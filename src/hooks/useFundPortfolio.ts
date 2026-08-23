import React, { useState, useCallback, useMemo } from 'react';
import { type Fund, type Position, type NAVRecord } from '../types/fund';
import { API_BASE } from '../config/api';
import {
  classifyFundSet,
  createUSSectorPresetFunds,
  migrateLegacyDefaultFunds,
  migrateUSSubsetNames,
  shouldPreferLocalFundSource,
  type FundSetSource,
} from '../data/usSectorFunds';

const STORAGE_KEY = 'shifeng_funds';
const SAVED_AT_KEY = 'shifeng_funds_saved_at';

const DEFAULT_FUNDS: Fund[] = createUSSectorPresetFunds();

function generateId(): string {
  return `fund_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadFundsSnapshot(): { funds: Fund[]; source: FundSetSource } {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const source = classifyFundSet(parsed);
        const migrated = migrateUSSubsetNames(migrateLegacyDefaultFunds(parsed));
        if (migrated !== parsed) saveFunds(migrated);
        return { funds: migrated, source };
      }
    }
  } catch {
    // ignore
  }
  saveFunds(DEFAULT_FUNDS);
  return { funds: DEFAULT_FUNDS, source: 'missing' };
}

function loadFunds(): Fund[] {
  return loadFundsSnapshot().funds;
}

function saveFunds(funds: Fund[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(funds));
  } catch {
    // ignore
  }
}

// 记录 localStorage 最近一次保存时间，用于和服务端 lastUpdated 比对
function getLocalSavedAt(): number {
  const v = localStorage.getItem(SAVED_AT_KEY);
  return v ? new Date(v).getTime() : 0;
}
function setLocalSavedAt(iso: string) {
  try {
    localStorage.setItem(SAVED_AT_KEY, iso);
  } catch {
    // ignore
  }
}

// Sync funds to backend server
async function syncFundsToBackend(funds: Fund[]): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/funds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ funds }),
    });
    if (!response.ok) {
      console.error(`[syncFundsToBackend] HTTP ${response.status} ${response.statusText} (payload size: ${JSON.stringify({ funds }).length} bytes)`);
    }
    return response.ok;
  } catch (err) {
    console.error('[syncFundsToBackend] network error:', err);
    return false;
  }
}

// Load funds from backend server
async function loadFundsFromBackend(): Promise<{
  funds: Fund[];
  lastUpdated: string | null;
  needsMigrationSync: boolean;
  source: FundSetSource;
} | null> {
  try {
    const response = await fetch(`${API_BASE}/api/funds`);
    if (response.ok) {
      const data = await response.json();
      if (data.funds && Array.isArray(data.funds)) {
        const source = classifyFundSet(data.funds);
        const migrated = migrateUSSubsetNames(migrateLegacyDefaultFunds(data.funds));
        return {
          funds: migrated,
          lastUpdated: data.lastUpdated ?? null,
          needsMigrationSync: migrated !== data.funds,
          source,
        };
      }
    } else {
      console.error(`[loadFundsFromBackend] HTTP ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error('[loadFundsFromBackend] network error:', err);
  }
  return null;
}

interface UseFundPortfolioReturn {
  funds: Fund[];
  syncStatus: {
    localCount: number;
    backendCount: number;
    source: 'backend' | 'local';
    backendReachable: boolean;
  };
  currentFund: Fund | null;
  selectFund: (id: string) => void;
  addFund: (name: string, initialCapital: number, market?: 'a' | 'hk' | 'us' | 'jp' | 'kr') => void;
  updateFund: (id: string, updates: { name?: string; initialCapital?: number; lastSyncDate?: string }) => void;
  deleteFund: (id: string) => void;
  addPosition: (fundId: string, position: Omit<Position, never>) => void;
  updatePosition: (fundId: string, code: string, updates: Partial<Position>) => void;
  deletePosition: (fundId: string, code: string) => void;
  addNAVRecord: (fundId: string, record: NAVRecord) => void;
  /** 内部 persist 函数，直接触发状态更新+localStorage 写入 */
  persistFunds: (newFunds: Fund[]) => void;
}

export function useFundPortfolio(): UseFundPortfolioReturn {
  const [funds, setFunds] = useState<Fund[]>(() => loadFunds());
  const [syncStatus, setSyncStatus] = useState<UseFundPortfolioReturn['syncStatus']>(() => {
    const localFunds = loadFunds();
    return {
      localCount: localFunds.length,
      backendCount: 0,
      source: 'local',
      backendReachable: false,
    };
  });
  const [currentFundId, setCurrentFundId] = useState<string | null>(() => {
    const loaded = loadFunds();
    return loaded.length > 0 ? loaded[0].id : null;
  });
  const [initialized, setInitialized] = useState(false);

  // Load from backend on first mount. Compare timestamps so that:
  // - If localStorage has unsynced changes (saved after backend's lastUpdated), use localStorage and re-push to backend
  // - Otherwise use backend as source of truth and update localStorage
  // This prevents the previous bug where backend data would silently overwrite newer localStorage data.
  React.useEffect(() => {
    if (initialized) return;
    setInitialized(true);

    const initialLocalFunds = loadFunds();
    const initialLocalCount = initialLocalFunds.length;
    setSyncStatus((prev) => ({
      ...prev,
      localCount: initialLocalCount,
      backendReachable: false,
    }));

    loadFundsFromBackend().then((backendData) => {
      // Re-read after the request so edits made while GET was pending are never resolved
      // against a stale mount-time snapshot.
      const localSnapshot = loadFundsSnapshot();
      const localFunds = localSnapshot.funds;
      const localCount = localFunds.length;
      if (!backendData) {
        // Backend unavailable, keep local state as the only source
        setSyncStatus({
          localCount,
          backendCount: 0,
          source: 'local',
          backendReachable: false,
        });
        if (localFunds.length > 0) {
          setFunds(localFunds);
          setCurrentFundId(localFunds[0]?.id ?? null);
        }
        return;
      }

      const backendFunds = backendData?.funds;
      const backendTime = backendData?.lastUpdated ? new Date(backendData.lastUpdated).getTime() : 0;
      const localTime = getLocalSavedAt();
      const backendCount = backendFunds?.length || 0;
      const shouldUseLocal = shouldPreferLocalFundSource({
        localSource: localSnapshot.source,
        localTime,
        backendSource: backendData.source,
        backendTime,
      });

      if (backendFunds && backendFunds.length > 0) {
        if (shouldUseLocal && localFunds.length > 0) {
          // localStorage has unsynced changes — use local and re-push to backend
          console.warn('[useFundPortfolio] localStorage is newer than backend, re-syncing', { localTime, backendTime });
          setFunds(localFunds);
          setCurrentFundId(localFunds[0]?.id ?? null);
          setSyncStatus({
            localCount,
            backendCount,
            source: 'local',
            backendReachable: true,
          });
          syncFundsToBackend(localFunds).then((ok) => {
            setSyncStatus((prev) => ({
              ...prev,
              backendReachable: ok,
              backendCount: ok ? localCount : prev.backendCount,
            }));
          });
        } else {
          // backend is at least as recent — use as source of truth
          setFunds(backendFunds);
          saveFunds(backendFunds);
          if (backendData?.lastUpdated) setLocalSavedAt(backendData.lastUpdated);
          setCurrentFundId(backendFunds[0].id);
          setSyncStatus({
            localCount,
            backendCount,
            source: 'backend',
            backendReachable: true,
          });
          if (backendData.needsMigrationSync) {
            syncFundsToBackend(backendFunds).then((ok) => {
              setSyncStatus((prev) => ({
                ...prev,
                backendReachable: ok,
                backendCount: ok ? backendFunds.length : prev.backendCount,
              }));
            });
          }
        }
      } else if (localFunds.length > 0) {
        // backend empty — use localStorage, try to push to backend
        setFunds(localFunds);
        setCurrentFundId(localFunds[0].id);
        setSyncStatus({
          localCount,
          backendCount,
          source: 'local',
          backendReachable: true,
        });
        syncFundsToBackend(localFunds).then((ok) => {
          setSyncStatus((prev) => ({
            ...prev,
            backendReachable: ok,
            backendCount: ok ? localCount : prev.backendCount,
          }));
        });
      } else {
        setSyncStatus({
          localCount,
          backendCount,
          source: 'local',
          backendReachable: true,
        });
      }
    });
  }, [initialized]);

  const currentFund = useMemo(
    () => funds.find((f) => f.id === currentFundId) ?? null,
    [funds, currentFundId]
  );

  const selectFund = useCallback((id: string) => {
    setCurrentFundId(id);
  }, []);

  const persist = useCallback((newFunds: Fund[]) => {
    setFunds(newFunds);
    saveFunds(newFunds);
    // Stamp localStorage save time so the next load can detect unsynced changes
    setLocalSavedAt(new Date().toISOString());
    setSyncStatus((prev) => ({
      ...prev,
      localCount: newFunds.length,
      source: 'local',
    }));
    // Also persist to backend server (async, don't block UI; failures are logged)
    syncFundsToBackend(newFunds).then((ok) => {
      setSyncStatus((prev) => ({
        ...prev,
        backendReachable: ok,
        backendCount: ok ? newFunds.length : prev.backendCount,
      }));
    });
  }, []);

  const addFund = useCallback((name: string, initialCapital: number, market: 'a' | 'hk' | 'us' | 'jp' | 'kr' = 'a') => {
    const newFund: Fund = {
      id: generateId(),
      name,
      market,
      initialCapital,
      positions: [],
      navHistory: [],
      createdAt: new Date().toISOString(),
    };
    persist([...funds, newFund]);
    setCurrentFundId(newFund.id);
  }, [funds, persist]);

  const updateFund = useCallback((id: string, updates: { name?: string; initialCapital?: number; lastSyncDate?: string }) => {
    persist(funds.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  }, [funds, persist]);

  const deleteFund = useCallback((id: string) => {
    const newFunds = funds.filter((f) => f.id !== id);
    persist(newFunds);
    if (currentFundId === id) {
      setCurrentFundId(newFunds.length > 0 ? newFunds[0].id : null);
    }
  }, [funds, persist, currentFundId]);

  const addPosition = useCallback((fundId: string, position: Omit<Position, never>) => {
    persist(funds.map((f) => {
      if (f.id !== fundId) return f;
      const exists = f.positions.some((p) => p.code === position.code);
      if (exists) return f;
      return { ...f, positions: [...f.positions, position] };
    }));
  }, [funds, persist]);

  const updatePosition = useCallback((fundId: string, code: string, updates: Partial<Position>) => {
    persist(funds.map((f) => {
      if (f.id !== fundId) return f;
      return {
        ...f,
        positions: f.positions.map((p) => (p.code === code ? { ...p, ...updates } : p)),
      };
    }));
  }, [funds, persist]);

  const deletePosition = useCallback((fundId: string, code: string) => {
    persist(funds.map((f) => {
      if (f.id !== fundId) return f;
      return { ...f, positions: f.positions.filter((p) => p.code !== code) };
    }));
  }, [funds, persist]);

  const addNAVRecord = useCallback((fundId: string, record: NAVRecord) => {
    persist(funds.map((f) => {
      if (f.id !== fundId) return f;
      const exists = f.navHistory.some((n) => n.date === record.date);
      if (exists) {
        return {
          ...f,
          navHistory: f.navHistory.map((n) => (n.date === record.date ? record : n)),
        };
      }
      return { ...f, navHistory: [...f.navHistory, record].sort((a, b) => a.date.localeCompare(b.date)) };
    }));
  }, [funds, persist]);

  return {
    funds,
    syncStatus,
    currentFund,
    selectFund,
    addFund,
    updateFund,
    deleteFund,
    addPosition,
    updatePosition,
    deletePosition,
    addNAVRecord,
    persistFunds: persist,
  };
}

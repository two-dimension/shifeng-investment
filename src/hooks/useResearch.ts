import { useEffect, useState, useCallback } from 'react';
import type {
  ResearchKind,
  ResearchSummary,
  ResearchHistoryResponse,
} from '../types/research';

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// 通用 fetch wrapper（处理错误 + JSON 解析）
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// 获取单个日期的研判摘要
export function useResearchSummary(
  kind: ResearchKind,
  date: string | null
): FetchState<ResearchSummary> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<ResearchSummary>>({
    data: null,
    loading: true,
    error: null,
  });

  const fetchData = useCallback(async () => {
    if (!date) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson<ResearchSummary>(
        `/api/research/${kind}/${date}`
      );
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [kind, date]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...state, refetch: fetchData };
}

// 获取最新一天的研判摘要
export function useResearchLatest(
  kind: ResearchKind
): FetchState<ResearchSummary> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<ResearchSummary>>({
    data: null,
    loading: true,
    error: null,
  });

  const fetchData = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson<ResearchSummary | null>(
        `/api/research/${kind}/latest`
      );
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [kind]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...state, refetch: fetchData };
}

// 获取历史日期列表
export function useResearchHistory(
  kind: ResearchKind
): FetchState<ResearchHistoryResponse> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<ResearchHistoryResponse>>({
    data: null,
    loading: true,
    error: null,
  });

  const fetchData = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson<ResearchHistoryResponse>(
        `/api/research/${kind}/history`
      );
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [kind]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...state, refetch: fetchData };
}
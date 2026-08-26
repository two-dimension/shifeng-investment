import React, { useState, useMemo } from 'react';
import * as XLSX from 'xlsx-js-style';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Table, Space, Button, Modal, Form, InputNumber, Popconfirm, message, Empty, AutoComplete, Segmented, DatePicker } from 'antd';
import { RiseOutlined, FallOutlined, SyncOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ArrowLeftOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTheme } from '../../hooks/useTheme';
import { syncPrices, syncHKPrices, syncUSPrices, syncJPQuotes, syncKRQuotes } from '../../services/quoteApi';
import { useFundPortfolio } from '../../hooks/useFundPortfolio';
import { FundDashboard, FundSwitcher, AddFundModal, ContributionModal } from '../../components/Fund';
import MarketTemperature from '../../components/Fund/MarketTemperature';
import { type Position } from '../../types/fund';
import { searchStocks } from '../../data/stocks';
import {
  applyTargetWeightQuote,
  calculatePortfolioMarketValue,
  getTargetWeightRebalanceCapital,
  hasUninitializedTargetWeightPositions,
} from '../../data/usSectorFunds';
import { createPortfolioEntryState } from './portfolioEntryState';
import type { SorterResult, SortOrder } from 'antd/es/table/interface';

const { useForm } = Form;
type PositionSortKey = 'nameCode' | 'price' | 'shares' | 'profit' | 'dailyReturn' | 'weight' | null;
type PositionSortOrder = 'asc' | 'desc' | null;
type PositionSortState = {
  key: PositionSortKey;
  order: PositionSortOrder;
};
const toSortOrder = (order: PositionSortOrder): SortOrder | undefined => {
  if (order === 'asc') return 'ascend';
  if (order === 'desc') return 'descend';
  return undefined;
};
type PositionRow = Position & { currentPrice: number; marketValue: number; profit: number; profitPercent: number; dailyReturn: number; contribution: number; contributionPercent: number; weight: number };

type QuoteSyncResult = Awaited<ReturnType<typeof syncPrices>>;

const syncFundQuotes = async (fund: { id: string; market: 'a' | 'hk' | 'us' | 'jp' | 'kr'; positions: Position[] }): Promise<QuoteSyncResult> => {
  const codes = fund.positions.map((position) => position.code);
  if (fund.market === 'hk') return syncHKPrices(codes);
  if (fund.market === 'us') return syncUSPrices(codes);
  if (fund.market === 'jp') return syncJPQuotes(codes);
  if (fund.market === 'kr') return syncKRQuotes(codes);

  const hkCodes = codes.filter((code) => code.toUpperCase().endsWith('.HK'));
  const aShareCodes = codes.filter((code) => !code.toUpperCase().endsWith('.HK'));
  const [aShareResult, hkResult] = await Promise.all([
    aShareCodes.length > 0
      ? syncPrices({ fundId: fund.id, codes: aShareCodes })
      : Promise.resolve<QuoteSyncResult>({ success: true, prices: {} }),
    hkCodes.length > 0
      ? syncHKPrices(hkCodes)
      : Promise.resolve<QuoteSyncResult>({ success: true, prices: {} }),
  ]);

  return {
    success: aShareResult.success || hkResult.success,
    tradeDate: aShareResult.tradeDate || hkResult.tradeDate,
    prices: { ...(aShareResult.prices || {}), ...(hkResult.prices || {}) },
    error: aShareResult.error || hkResult.error,
  };
};

const handleExportPositions = (fund: { positions: Position[]; name: string; initialCapital?: number }) => {
  const totalMarketValue = fund.positions.reduce((sum, position) => sum + position.shares * (position.currentPrice ?? position.avgCost), 0);
  const data = fund.positions.map((p) => {
    const currentPrice = p.currentPrice ?? p.avgCost;
    const mv = p.shares * currentPrice;
    const cost = p.shares * p.avgCost;
    const weight = totalMarketValue > 0 ? (mv / totalMarketValue * 100) : 0;
    return {
      '股票代码': p.code,
      '股票名称': p.name,
      '持仓数量': p.shares,
      '平均成本': p.avgCost,
      '现价': currentPrice,
      '前收': p.prevClose,
      '涨跌幅%': currentPrice && p.prevClose ? (((currentPrice - p.prevClose) / p.prevClose) * 100).toFixed(2) + '%' : '-',
      '持仓市值': mv,
      '仓位%': weight.toFixed(2) + '%',
      '浮盈亏': mv - cost,
      '盈亏%': p.avgCost ? (((currentPrice - p.avgCost) / p.avgCost) * 100).toFixed(2) + '%' : '-',
    };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
    { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 8 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '持仓明细');
  XLSX.writeFile(wb, `${fund.name}_持仓_${new Date().toISOString().slice(0, 10)}.xlsx`);
};

const PositionModal: React.FC<{
  open: boolean;
  position?: Position;
  initialCapital: number;
  currentFund?: { market: 'a' | 'hk' | 'us' | 'jp' | 'kr' };
  otherPositions: { code: string; marketValue: number }[];
  onClose: () => void;
  onSave: (data: Position) => void;
}> = ({ open, position, initialCapital, currentFund, otherPositions, onClose, onSave }) => {
  const [form] = useForm();
  const [inputMode, setInputMode] = useState<'shares' | 'weight'>('shares');
  const [codeOptions, setCodeOptions] = useState<{ value: string; label: string; name: string; code: string }[]>([]);
  const [nameOptions, setNameOptions] = useState<{ value: string; label: string; name: string; code: string }[]>([]);
  const title = position ? '编辑持仓' : '添加持仓';

  // 计算其他持仓的市值总和（编辑时排除自身），以初始资金为分母
  const otherMarketValueSum = otherPositions
    .filter((p) => p.code !== position?.code)
    .reduce((sum, p) => sum + p.marketValue, 0);
  // 其他持仓的权重（用于权重模式超限检查）
  const otherWeightSum = initialCapital > 0 ? (otherMarketValueSum / initialCapital) * 100 : 0;

  React.useEffect(() => {
    if (open) {
      if (position) {
        form.setFieldsValue({ ...position, weight: undefined });
        setInputMode('shares');
      } else {
        form.resetFields();
        setInputMode('shares');
      }
    }
  }, [open, position, form]);

  const handleCodeSelect = (val: string, opt: { name: string; code: string }) => {
    form.setFieldsValue({ code: val, name: opt.name });
    setNameOptions([]);
    // fetch current price based on market
    const market = currentFund?.market || 'a';
    const endpoint = market === 'hk' ? '/api/sync/hk' : market === 'us' ? '/api/sync/us' : market === 'jp' ? '/api/sync/jp' : '/api/sync';
    fetch(`http://localhost:3000${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: [val] }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.prices && data.prices[val]) {
          form.setFieldsValue({ currentPrice: data.prices[val].currentPrice });
        }
      })
      .catch(() => {});
  };

  // Auto-fetch current price when code changes (for new positions only)
  React.useEffect(() => {
    if (position) return;
    const code = form.getFieldValue('code');
    if (!code || code.length < 6) return;
    // price already loaded via onSelect
  }, [form, position]);

  const handleOk = () => {
    form.validateFields().then((values) => {
      const shares = Number(values.shares);
      const avgCost = Number(values.avgCost);
      const currentPrice = Number(form.getFieldValue('currentPrice'));
      console.log('[handleOk] from form:', currentPrice, '| from values:', values.currentPrice);

      if (inputMode === 'weight' && shares > 0 && initialCapital > 0) {
        // 检查 currentPrice 是否获取到
        if (!currentPrice || currentPrice <= 0) {
          message.error('当前价获取失败，请尝试重新选择股票代码');
          return;
        }
        // 检查权重是否超限
        const newTotal = otherWeightSum + shares;
        if (newTotal > 100) {
          message.error(`权重总和已达 ${newTotal.toFixed(1)}%，超过 100%，请降低权重`);
          return;
        }
        // 按权重计算股数：initialCapital * weight% / 当前价
        const calculatedShares = Math.floor((initialCapital * (shares / 100)) / currentPrice);
        onSave({ code: values.code, name: values.name, shares: calculatedShares, avgCost, currentPrice });
      } else {
        // 按股数录入：检查总持仓是否超过初始资金（编辑时用表单新值替换旧持仓市值）
        const thisMarketValue = shares * (currentPrice || avgCost);
        if (otherMarketValueSum + thisMarketValue > initialCapital) {
          const newPct = ((otherMarketValueSum + thisMarketValue) / initialCapital) * 100;
          message.error(`总持仓市值已达 ${newPct.toFixed(1)}%，超过 100%，请降低持仓`);
          return;
        }
        onSave({ code: values.code, name: values.name, shares, avgCost, currentPrice: currentPrice || avgCost });
      }
      onClose();
    });
  };

  return (
    <Modal
      title={title}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <div onKeyDown={(e) => { if (e.key === 'Enter') handleOk(); }}>

      <Form form={form} layout="vertical">
        <Form.Item label="录入方式" style={{ marginBottom: 8 }}>
          <Space>
            <Button type={inputMode === 'shares' ? 'primary' : 'default'} size="small" onClick={() => setInputMode('shares')}>按股数录入</Button>
            <Button type={inputMode === 'weight' ? 'primary' : 'default'} size="small" onClick={() => setInputMode('weight')}>按权重录入</Button>
          </Space>
        </Form.Item>
        <Form.Item name="code" label="股票代码" rules={[{ required: true, message: '请输入股票代码' }]}>
          <AutoComplete
            options={codeOptions}
            onSearch={(val) => {
              const market = currentFund?.market || 'a';
              setCodeOptions(searchStocks(val, market).slice(0, 10));
            }}
            onSelect={(val, opt) => handleCodeSelect(val, opt)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && codeOptions.length > 0) {
                const first = codeOptions[0];
                handleCodeSelect(first.value, { name: first.name || '', code: first.value });
                form.setFieldsValue({ code: first.value, name: first.name || '' });
              }
            }}
            placeholder="如 000001"
            disabled={!!position}
          />
        </Form.Item>
        <Form.Item name="name" label="股票名称" rules={[{ required: true, message: '请输入股票名称' }]}>
          <AutoComplete
            options={nameOptions}
            onSearch={(val) => {
              const market = currentFund?.market || 'a';
              setNameOptions(searchStocks(val, market).slice(0, 10));
            }}
            onSelect={(_val, opt) => { form.setFieldsValue({ name: opt.name, code: opt.code }); setCodeOptions([]); handleCodeSelect(opt.code, opt); }}
            placeholder="如 平安银行"
          />
        </Form.Item>
        {inputMode === 'shares' ? (
          <>
            <Form.Item name="shares" label="持仓数量" rules={[{ required: true, message: '请输入持仓数量' }]}>
              <InputNumber placeholder="如 10000" style={{ width: '100%' }} min={0} />
            </Form.Item>
            <Form.Item name="avgCost" label="平均成本" rules={[{ required: true, message: '请输入平均成本' }]}>
              <InputNumber placeholder="如 12.50" style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
            <Form.Item name="currentPrice" label="当前价（自动获取）">
              <InputNumber placeholder="自动获取" style={{ width: '100%' }} min={0} precision={2} disabled />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="shares" label="目标权重 (%)" rules={[{ required: true, message: '请输入目标权重' }]}>
              <InputNumber placeholder="如 20" style={{ width: '100%' }} min={0.01} max={100} precision={2} suffix="%" />
            </Form.Item>
            <Form.Item name="avgCost" label="平均成本" rules={[{ required: true, message: '请输入平均成本' }]}>
              <InputNumber placeholder="如 12.50" style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
            <Form.Item label="当前价（自动获取）">
              <InputNumber value={form.getFieldValue('currentPrice')} style={{ width: '100%' }} disabled />
            </Form.Item>
          </>
        )}
      </Form>
    </div>
    </Modal>
  );
};

const PortfolioPanel: React.FC = () => {
  const { theme } = useTheme();
  const {
    funds,
    currentFund,
    selectFund,
    addFund,
    updateFund,
    deleteFund,
    addPosition,
    updatePosition,
    deletePosition,
    persistFunds,
  } = useFundPortfolio();

  const navigate = useNavigate();

  const [modalOpen, setModalOpen] = useState(false);
  const [entryState, setEntryState] = useState(createPortfolioEntryState);
  const { market: marketFilter, isViewingDashboard } = entryState;
  const setMarketFilter = (market: typeof marketFilter) => {
    setEntryState((current) => ({ ...current, market }));
  };
  const setIsViewingDashboard = (nextIsViewingDashboard: boolean) => {
    setEntryState((current) => ({ ...current, isViewingDashboard: nextIsViewingDashboard }));
  };
  const [addFundModalOpen, setAddFundModalOpen] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [contributionModalOpen, setContributionModalOpen] = useState(false);
  const [navDateRange, setNavDateRange] = useState<[string | null, string | null]>([null, null]);
  const [marketTemperatureRefreshKey, setMarketTemperatureRefreshKey] = useState(0);
  const [positionSortState, setPositionSortState] = useState<PositionSortState>({ key: null, order: null });
  const positionSortKey = positionSortState.key;
  const positionSortOrder = positionSortState.order;
  const filteredNavHistory = useMemo(() => {
    if (!currentFund || !navDateRange[0] || !navDateRange[1]) {
      return currentFund?.navHistory ?? [];
    }
    return currentFund.navHistory.filter(
      (record) => record.date >= navDateRange[0]! && record.date <= navDateRange[1]!
    );
  }, [currentFund, navDateRange]);

  // 按市场过滤基金
  const filteredFunds = useMemo(() => {
    return funds.filter((f) => f.market === marketFilter);
  }, [funds, marketFilter]);

  // 计算当前基金的统计数据
  const stats = useMemo(() => {
    if (!currentFund) {
      return { totalMarketValue: 0, totalCost: 0, totalProfit: 0, profitPercent: 0, dailyReturn: 0, cash: 0, initialCapital: 0, positions: [] as (Position & { currentPrice: number; marketValue: number; profit: number; profitPercent: number; dailyReturn: number; contribution: number; contributionPercent: number; weight: number })[] };
    }
    const initialCapital = currentFund.initialCapital;
    const totalMarketValue = currentFund.positions.reduce((sum, p) => {
      const price = p.currentPrice ?? p.avgCost;
      return sum + p.shares * price;
    }, 0);
    const cash = initialCapital - totalMarketValue;
    const totalCost = currentFund.positions.reduce((sum, p) => sum + p.shares * p.avgCost, 0);
    const totalProfit = totalMarketValue - totalCost;
    const profitPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

    // 加权日收益：基于昨收和今价
    let dailyReturn = 0;
    let weightedCurr = 0;
    let weightedPrev = 0;
    for (const p of currentFund.positions) {
      const curr = (p.currentPrice ?? p.avgCost) * p.shares;
      const prev = (p.prevClose ?? p.currentPrice ?? p.avgCost) * p.shares;
      weightedCurr += curr;
      weightedPrev += prev;
    }
    if (weightedPrev > 0) {
      dailyReturn = ((weightedCurr - weightedPrev) / weightedPrev) * 100;
    }

    const positions = currentFund.positions.map((p) => {
      const currentPrice = p.currentPrice ?? p.avgCost;
      const prevPrice = p.prevClose ?? p.currentPrice ?? p.avgCost;
      const marketValue = p.shares * currentPrice;
      const cost = p.shares * p.avgCost;
      const profit = marketValue - cost;
      const profitPercent = cost > 0 ? (profit / cost) * 100 : 0;
      const dailyReturn = prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice) * 100 : 0;
      const contribution = profit;
      const contributionPercent = totalProfit !== 0 ? (profit / totalProfit) * 100 : 0;
      const weight = initialCapital > 0 ? (marketValue / initialCapital) * 100 : 0;
      return { ...p, currentPrice, marketValue, profit, profitPercent, dailyReturn, contribution, contributionPercent, weight };
    });

    return { totalMarketValue, totalCost, totalProfit, profitPercent, dailyReturn, cash, initialCapital, positions };
  }, [currentFund]);

  const sortedPositions = useMemo(() => {
    const positions = [...stats.positions];
    if (positionSortKey === null || positionSortOrder === null) {
      return positions;
    }
    positions.sort((a, b) => {
      if (positionSortKey === 'nameCode') {
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) return positionSortOrder === 'asc' ? byName : -byName;
        return positionSortOrder === 'asc'
          ? a.code.localeCompare(b.code)
          : b.code.localeCompare(a.code);
      }
      if (positionSortKey === 'price') {
        return positionSortOrder === 'asc'
          ? a.currentPrice - b.currentPrice
          : b.currentPrice - a.currentPrice;
      }
      if (positionSortKey === 'shares') {
        return positionSortOrder === 'asc'
          ? a.shares - b.shares
          : b.shares - a.shares;
      }
      if (positionSortKey === 'profit') {
        return positionSortOrder === 'asc'
          ? a.profit - b.profit
          : b.profit - a.profit;
      }
      if (positionSortKey === 'dailyReturn') {
        return positionSortOrder === 'asc'
          ? a.dailyReturn - b.dailyReturn
          : b.dailyReturn - a.dailyReturn;
      }
      return positionSortOrder === 'asc'
        ? a.weight - b.weight
        : b.weight - a.weight;
    });
    return positions;
  }, [stats.positions, positionSortKey, positionSortOrder]);

  const handlePositionTableChange = (
    _pagination: unknown,
    _filters: unknown,
    sorter: SorterResult<PositionRow> | SorterResult<PositionRow>[]
  ) => {
    const current = Array.isArray(sorter) ? sorter[0] : sorter;
    const rawColumnKey = current?.column?.key
      ?? current?.columnKey
      ?? current?.field
      ?? (current?.column?.dataIndex as string | string[] | undefined);
    const rawOrder = current?.order;
    const resolvedColumnKey = Array.isArray(rawColumnKey) ? rawColumnKey[rawColumnKey.length - 1] : rawColumnKey;
    const resolvedOrder: PositionSortOrder = rawOrder === 'ascend' ? 'asc' : rawOrder === 'descend' ? 'desc' : null;

    if (!resolvedColumnKey) {
      setPositionSortState({ key: null, order: null });
      return;
    }

    const key = resolvedColumnKey;
    if (key !== 'nameCode' && key !== 'price' && key !== 'shares' && key !== 'profit' && key !== 'dailyReturn' && key !== 'weight') {
      return;
    }

    if (key === positionSortKey) {
      if (resolvedOrder === null) {
        setPositionSortState({ key: null, order: null });
        return;
      }
    }

    setPositionSortState({
      key,
      order: resolvedOrder || 'asc',
    });
  };

  const handleFundSelect = (fundId: string) => {
    selectFund(fundId);
    setIsViewingDashboard(false);
  };

  const handleBackToDashboard = () => {
    setIsViewingDashboard(true);
  };

  const handleAddFund = (name: string, initialCapital: number, market?: 'a' | 'hk' | 'us' | 'jp' | 'kr') => {
    addFund(name, initialCapital, market);
  };

  const handleSave = (values: Position) => {
    if (!currentFund) return;
    if (editingPosition) {
      updatePosition(currentFund.id, editingPosition.code, values);
      message.success('持仓已更新');
    } else {
      addPosition(currentFund.id, values);
      message.success('持仓已添加');
    }
    setEditingPosition(undefined);
  };

  const handleEdit = (record: Position) => {
    setEditingPosition(record);
    setModalOpen(true);
  };

  const handleDelete = (code: string) => {
    if (!currentFund) return;
    deletePosition(currentFund.id, code);
    message.success('持仓已删除');
  };

  const handleSyncAll = async () => {
    if (syncing) return;
    setSyncing(true);

    // 闭包问题：fund 在 for 循环中是 var，会被后续异步回调修改，所以每个迭代都要 capture
    const updatedFunds = await Promise.all(funds.map(async (fundSnapshot) => {
      if (fundSnapshot.positions.length === 0) return fundSnapshot;
      const res = await syncFundQuotes(fundSnapshot);
      if (!res.success || !res.prices) return fundSnapshot;

      const today = res.tradeDate!;
      const rebalanceCapital = getTargetWeightRebalanceCapital(
        fundSnapshot.positions,
        res.prices,
        fundSnapshot.initialCapital,
      );
      const newPositions = fundSnapshot.positions.map((p) => {
        const pd = res.prices![p.code];
        if (!pd) return p;
        return applyTargetWeightQuote(p, pd, rebalanceCapital ?? Number.NaN);
      });
      const totalMV = calculatePortfolioMarketValue(newPositions);
      const activePositions = fundSnapshot.positions.filter((p) => Number(p.shares) > 0);
      const freshQuoteCount = activePositions.filter((p) => {
        const pd = res.prices![p.code];
        return pd && Number(pd.currentPrice) > 0 && Number(pd.prevClose) > 0;
      }).length;
      const hasReliableNAV = activePositions.length > 0 &&
        freshQuoteCount >= Math.max(1, Math.ceil(activePositions.length * 0.8)) &&
        !hasUninitializedTargetWeightPositions(newPositions) &&
        Number.isFinite(totalMV) && totalMV > 0;
      const nav = fundSnapshot.initialCapital > 0 ? totalMV / fundSnapshot.initialCapital : 1;
      const exists = fundSnapshot.navHistory.some((n) => n.date === today);
      const newNavHistory = !hasReliableNAV
        ? fundSnapshot.navHistory
        : exists
        ? fundSnapshot.navHistory.map((n) => n.date === today ? { ...n, nav, cumulativeNav: nav, marketValue: totalMV } : n)
        : [...fundSnapshot.navHistory, { date: today, nav, cumulativeNav: nav, marketValue: totalMV }].sort((a, b) => a.date.localeCompare(b.date));
      return {
        ...fundSnapshot,
        positions: newPositions,
        navHistory: newNavHistory,
        lastSyncDate: hasReliableNAV ? today : fundSnapshot.lastSyncDate,
      };
    }));

    // API success=true means we got fresh data (even if price unchanged today)
    persistFunds(updatedFunds);
    setMarketTemperatureRefreshKey((key) => key + 1);
    setSyncing(false);
    message.success(`已刷新 ${updatedFunds.length} 个基金的行情`);
  };

  const handleSyncCurrent = async () => {
    if (!currentFund) return;
    setSyncing(true);
    try {
      const res = await syncFundQuotes(currentFund);
      if (res.success && res.prices) {
        const today = res.tradeDate!;
        const needsNAVRecord = currentFund.lastSyncDate !== today;
        const fundId = currentFund.id;

        // 构建完整的更新后基金对象，单次 persist 避免多次 setState 时序问题
        const newFunds = funds.map((f) => {
          if (f.id !== fundId) return f;

          // 更新所有持仓价格
          const rebalanceCapital = getTargetWeightRebalanceCapital(
            f.positions,
            res.prices!,
            f.initialCapital,
          );
          const newPositions = f.positions.map((p) => {
            const pd = res.prices![p.code];
            if (!pd) return p;
            return applyTargetWeightQuote(p, pd, rebalanceCapital ?? Number.NaN);
          });

          // 计算总市值（用最新价格）
          const totalMV = calculatePortfolioMarketValue(newPositions);
          const activePositions = f.positions.filter((p) => Number(p.shares) > 0);
          const freshQuoteCount = activePositions.filter((p) => {
            const pd = res.prices![p.code];
            return pd && Number(pd.currentPrice) > 0 && Number(pd.prevClose) > 0;
          }).length;
          const hasReliableNAV = activePositions.length > 0 &&
            freshQuoteCount >= Math.max(1, Math.ceil(activePositions.length * 0.8)) &&
            !hasUninitializedTargetWeightPositions(newPositions) &&
            Number.isFinite(totalMV) && totalMV > 0;
          const shouldRecordNAV = needsNAVRecord && hasReliableNAV;
          const nav = f.initialCapital > 0 ? totalMV / f.initialCapital : 1;

          // 更新 navHistory
          let newNavHistory = f.navHistory;
          if (shouldRecordNAV) {
            const exists = f.navHistory.some((n) => n.date === today);
            if (exists) {
              newNavHistory = f.navHistory.map((n) => n.date === today ? { ...n, nav, cumulativeNav: nav, marketValue: totalMV } : n);
            } else {
              newNavHistory = [...f.navHistory, { date: today, nav, cumulativeNav: nav, marketValue: totalMV }].sort((a, b) => a.date.localeCompare(b.date));
            }
          }

          return {
            ...f,
            positions: newPositions,
            navHistory: newNavHistory,
            lastSyncDate: shouldRecordNAV ? today : f.lastSyncDate,
          };
        });

        // 直接调用 persistFunds 单次更新所有数据（positions + navHistory + lastSyncDate）
        persistFunds(newFunds);

        message.success(`数据已更新 (${today})`);
      } else {
        message.error(res.error || '同步失败');
      }
    } catch {
      message.error('同步失败，请检查服务');
    } finally {
      setSyncing(false);
    }
  };

  const openAddModal = () => {
    setEditingPosition(undefined);
    setModalOpen(true);
  };
  const curveChartOption = useMemo(() => {
    const navData = filteredNavHistory.length > 0 ? filteredNavHistory : [];
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const data = (params as { axisValue: string; value: number }[])[0];
          return data ? `${data.axisValue}<br/>净值: ${data.value.toFixed(3)}` : '';
        },
      },
      xAxis: {
        type: 'category',
        data: navData.map((record) => record.date.slice(5)),
        axisLine: { lineStyle: { color: theme === 'dark' ? '#444' : '#ddd' } },
        axisLabel: { color: theme === 'dark' ? '#888' : '#666', rotate: 45 },
      },
      yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: theme === 'dark' ? '#444' : '#ddd' } },
        axisLabel: {
          color: theme === 'dark' ? '#888' : '#666',
          formatter: (value: number) => value.toFixed(3),
        },
        splitLine: { lineStyle: { color: theme === 'dark' ? '#333' : '#eee' } },
      },
      series: [
        {
          data: navData.map((record) => record.nav),
          type: 'line',
          smooth: true,
          lineStyle: {
            color: stats.totalProfit >= 0 ? '#ff4d4f' : '#52c41a',
            width: 2,
          },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: stats.totalProfit >= 0 ? 'rgba(255, 77, 79, 0.3)' : 'rgba(82, 196, 26, 0.3)' },
                { offset: 1, color: stats.totalProfit >= 0 ? 'rgba(255, 77, 79, 0.05)' : 'rgba(82, 196, 26, 0.05)' },
              ],
            },
          },
        },
      ],
      grid: { left: 60, right: 20, top: 20, bottom: 60 },
    };
  }, [filteredNavHistory, theme, stats.totalProfit]);

  const allocationChartOption = {
    backgroundColor: 'transparent',
    title: {
      text: '仓位分布',
      left: 'center',
      textStyle: { color: theme === 'dark' ? '#fff' : '#333', fontSize: 14 },
    },
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const data = params as { name: string; value: number; percent: number };
        return `${data.name}: ¥${(data.value || 0).toLocaleString()} (${data.percent.toFixed(1)}%)`;
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 4,
          borderColor: theme === 'dark' ? '#141414' : '#fff',
          borderWidth: 2,
        },
        label: {
          color: theme === 'dark' ? '#fff' : '#333',
        },
        data: [
          ...stats.positions.map((p) => ({
            value: p.marketValue,
            name: p.name,
          })),
          ...(stats.cash > 0 ? [{ value: stats.cash, name: '现金' }] : []),
        ],
      },
    ],
  };

  const columns = [
    {
      title: '序号',
      key: 'rank',
      width: 64,
      align: 'center' as const,
      render: (_: unknown, __: Position, index: number) => index + 1,
    },
    {
      title: '名称/代码',
      key: 'nameCode',
      width: 130,
      sorter: (a: Position & { profit: number; dailyReturn: number; weight: number; code: string }, b: Position & { profit: number; dailyReturn: number; weight: number; code: string }) => {
        const n = a.name.localeCompare(b.name);
        if (n !== 0) return n;
        return a.code.localeCompare(b.code);
      },
      sortDirections: ['ascend', 'descend'] as ('ascend' | 'descend')[],
      sortOrder: positionSortKey === 'nameCode' ? toSortOrder(positionSortOrder) : undefined,
      render: (_: unknown, record: Position) => (
        <div style={{ lineHeight: 1.4 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>{record.name}</div>
          <div style={{ fontSize: 11, color: '#888' }}>{record.code}</div>
        </div>
      ),
    },
    {
      title: '成本/现价',
      key: 'price',
      sorter: (a: Position & { profit: number; dailyReturn: number; weight: number; profitPercent: number; currentPrice: number }, b: Position & { profit: number; dailyReturn: number; weight: number; profitPercent: number; currentPrice: number }) => a.currentPrice - b.currentPrice,
      sortDirections: ['ascend', 'descend'] as ('ascend' | 'descend')[],
      sortOrder: positionSortKey === 'price' ? toSortOrder(positionSortOrder) : undefined,
      width: 144,
      align: 'right' as const,
      render: (_: unknown, record: Position & { currentPrice: number; profitPercent: number }) => {
        const pctColor = record.profitPercent > 0 ? '#ff4d4f' : record.profitPercent < 0 ? '#52c41a' : '#888';
        return (
          <div style={{ lineHeight: 1.4, textAlign: 'right' }}>
            <div style={{ fontSize: 13 }}>
              <span style={{ color: pctColor }}>{record.avgCost.toFixed(2)}</span>
              <span style={{ color: '#aaa', margin: '0 4px' }}>→</span>
              <span style={{ color: pctColor }}>{record.currentPrice.toFixed(2)}</span>
            </div>
            <div style={{ fontSize: 11, color: pctColor }}>
              {record.profitPercent >= 0 ? '+' : ''}{record.profitPercent.toFixed(1)}%
            </div>
          </div>
        );
      },
    },
    {
      title: '持仓',
      key: 'shares',
      sorter: (a: Position, b: Position) => a.shares - b.shares,
      sortDirections: ['ascend', 'descend'] as ('ascend' | 'descend')[],
      sortOrder: positionSortKey === 'shares' ? toSortOrder(positionSortOrder) : undefined,
      width: 104,
      align: 'right' as const,
      render: (_: unknown, record: Position) => (
        <div style={{ lineHeight: 1.4, textAlign: 'right' }}>
          <div style={{ fontSize: 13 }}>{(record.shares || 0).toLocaleString()}</div>
          <div style={{ fontSize: 11, color: '#888' }}>股</div>
        </div>
      ),
    },
    {
      title: '持仓盈亏',
      key: 'profit',
      sorter: (a: Position & { profit: number; profitPercent: number }, b: Position & { profit: number; profitPercent: number }) => a.profit - b.profit,
      sortDirections: ['ascend', 'descend'] as ('ascend' | 'descend')[],
      sortOrder: positionSortKey === 'profit' ? toSortOrder(positionSortOrder) : undefined,
      width: 120,
      align: 'right' as const,
      render: (_: unknown, record: Position & { profit: number; profitPercent: number }) => {
        const color = record.profit > 0 ? '#ff4d4f' : record.profit < 0 ? '#52c41a' : '#888';
        return (
          <div style={{ lineHeight: 1.4, textAlign: 'right' }}>
            <div style={{ fontSize: 11, color }}>{record.profitPercent >= 0 ? '+' : ''}{record.profitPercent.toFixed(1)}%</div>
            <div style={{ fontSize: 13, color }}>{record.profit >= 0 ? '+' : ''}{(Math.round(record.profit) || 0).toLocaleString()}</div>
          </div>
        );
      },
    },
    {
      title: '今日涨跌',
      key: 'dailyReturn',
      sorter: (a: Position & { dailyReturn: number }, b: Position & { dailyReturn: number }) => a.dailyReturn - b.dailyReturn,
      sortDirections: ['ascend', 'descend'] as ('ascend' | 'descend')[],
      sortOrder: positionSortKey === 'dailyReturn' ? toSortOrder(positionSortOrder) : undefined,
      width: 96,
      align: 'right' as const,
      render: (_: unknown, record: Position & { dailyReturn: number; prevClose?: number; currentPrice: number }) => {
        const dr = record.dailyReturn;
        const color = dr > 0 ? '#ff4d4f' : dr < 0 ? '#52c41a' : '#888';
        const icon = dr > 0 ? <ArrowUpOutlined /> : dr < 0 ? <ArrowDownOutlined /> : null;
        const change = record.prevClose ? (record.currentPrice - record.prevClose) * (record.shares || 0) : 0;
        return (
          <div style={{ lineHeight: 1.4, textAlign: 'right' }}>
            <div style={{ fontSize: 11, color }}>
              {icon}{dr !== 0 ? `${dr > 0 ? '+' : ''}${dr.toFixed(2)}%` : '0.00%'}
            </div>
            <div style={{ fontSize: 13, color }}>
              {change >= 0 ? '+' : ''}{(Math.round(change) || 0).toLocaleString()}
            </div>
          </div>
        );
      },
    },
    {
      title: '仓位',
      key: 'weight',
      sorter: (a: Position & { weight: number }, b: Position & { weight: number }) => a.weight - b.weight,
      sortDirections: ['ascend', 'descend'] as ('ascend' | 'descend')[],
      sortOrder: positionSortKey === 'weight' ? toSortOrder(positionSortOrder) : undefined,
      width: 88,
      align: 'right' as const,
      render: (_: unknown, record: Position & { weight: number }) => (
        <span style={{ fontSize: 13 }}>{record.weight.toFixed(1)}%</span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, record: Position) => (
        <Space size="small" onClick={(e) => e.stopPropagation()}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.code)} okText="删除" cancelText="取消">
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (isViewingDashboard) {
    return (
      <>
        <div style={{ marginBottom: 16 }}>
          <Segmented
            value={marketFilter}
            onChange={(v) => setMarketFilter(v as typeof marketFilter)}
            options={[
              { label: 'A股', value: 'a' },
              { label: '港股', value: 'hk' },
              { label: '美股', value: 'us' },
              { label: '日股', value: 'jp' },
              { label: '韩股', value: 'kr' },
            ]}
          />
        </div>
        <MarketTemperature market={marketFilter} refreshKey={marketTemperatureRefreshKey} />
        <FundDashboard
              funds={filteredFunds}
              exportLabel={marketFilter === 'a' ? 'A股' : marketFilter === 'hk' ? '港股' : marketFilter === 'us' ? '美股' : marketFilter === 'jp' ? '日股' : '韩股'}
              showMarketBadge={false}
          onOpenAnomaly={(fundId, code) => navigate(`/portfolio/anomaly/${fundId}${code ? `?code=${encodeURIComponent(code)}` : ''}`)}
          onSelectFund={handleFundSelect}
          onAddFund={() => setAddFundModalOpen(true)}
          onSyncAll={handleSyncAll}
          syncing={syncing}
        />
        <AddFundModal
          open={addFundModalOpen}
          onClose={() => setAddFundModalOpen(false)}
          onSave={handleAddFund}
        />
      </>
    );
  }

  if (!currentFund) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Empty description="暂无基金" />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 12 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={handleBackToDashboard}>
            返回九宫格
          </Button>
        </Space>
      </div>

      <FundSwitcher
        funds={funds}
        currentFundId={currentFund.id}
        onSelect={selectFund}
        onAdd={(name, ic) => addFund(name, ic)}
        onUpdate={updateFund}
        onDelete={deleteFund}
      />

      <div style={{ fontSize: 32, fontWeight: 700, color: theme === 'dark' ? '#fff' : '#333', marginBottom: 16 }}>
        {currentFund.name}
      </div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small" style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff' }}>
            <Statistic
              title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>总盈亏</span>}
              value={stats.totalProfit}
              precision={2}
              prefix={stats.totalProfit >= 0 ? <RiseOutlined /> : <FallOutlined />}
              valueStyle={{ color: stats.totalProfit >= 0 ? '#ff4d4f' : '#52c41a' }}
              suffix="元"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff' }}>
            <Statistic
              title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>收益率</span>}
              value={stats.profitPercent}
              precision={2}
              prefix={stats.profitPercent >= 0 ? <RiseOutlined /> : <FallOutlined />}
              valueStyle={{ color: stats.profitPercent >= 0 ? '#ff4d4f' : '#52c41a' }}
              suffix="%"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff' }}>
            <Statistic
              title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>今日涨跌</span>}
              value={stats.dailyReturn}
              precision={2}
              prefix={stats.dailyReturn >= 0 ? <ArrowUpOutlined /> : stats.dailyReturn < 0 ? <ArrowDownOutlined /> : null}
              valueStyle={{ color: stats.dailyReturn > 0 ? '#ff4d4f' : stats.dailyReturn < 0 ? '#52c41a' : '#888' }}
              suffix="%"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff' }}>
            <Statistic
              title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>持仓数量</span>}
              value={stats.positions.length}
              valueStyle={{ color: theme === 'dark' ? '#fff' : '#333' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Card
            size="small"
            title="净值趋势"
            extra={
              <DatePicker.RangePicker
                size="small"
                onChange={(_dates: unknown, dateStrings: [string, string]) => {
                  setNavDateRange(dateStrings as [string | null, string | null]);
                }}
              />
            }
            style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff', height: 320 }}
          >
            <ReactECharts option={curveChartOption} style={{ height: 260 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            size="small"
            title="仓位分布"
            style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff', height: 320 }}
          >
            <ReactECharts option={allocationChartOption} style={{ height: 260 }} />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="持仓明细"
        extra={
          <Space>
            <Button icon={<SyncOutlined />} onClick={handleSyncCurrent} loading={syncing}>
              同步数据
            </Button>
            {stats.positions.length > 0 && (
              <Button onClick={() => handleExportPositions(currentFund)}>
                导出持仓
              </Button>
            )}
            {stats.positions.length > 0 && (
              <Button onClick={() => setContributionModalOpen(true)}>
                贡献分析
              </Button>
            )}
            <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
              添加持仓
            </Button>
          </Space>
        }
        style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff' }}
      >
        {stats.positions.length > 0 ? (
      <Table
            columns={columns}
            dataSource={sortedPositions}
            rowKey="code"
            pagination={false}
            size="small"
            style={{ width: '100%' }}
            onChange={handlePositionTableChange}
            onRow={(record) => ({ onClick: () => navigate(`/stock/${record.code}`), style: { cursor: 'pointer' } })}
            showSorterTooltip={false}
            summary={() => (
              <Table.Summary>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}>
                    <strong />
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1}>
                    <strong>股票合计</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <strong>¥{stats.totalMarketValue.toLocaleString()}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">
                    <strong>{stats.positions.reduce((s, p) => s + p.shares, 0).toLocaleString()}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">
                    <div style={{ lineHeight: 1.4, textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: stats.totalProfit >= 0 ? '#ff4d4f' : '#52c41a' }}>
                        {stats.profitPercent >= 0 ? '+' : ''}{stats.profitPercent.toFixed(1)}%
                      </div>
                      <div style={{ fontSize: 13, color: stats.totalProfit >= 0 ? '#ff4d4f' : '#52c41a' }}>
                        {stats.totalProfit >= 0 ? '+' : ''}{Math.round(stats.totalProfit).toLocaleString()}
                      </div>
                    </div>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">
                    <div style={{ lineHeight: 1.4, textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: stats.dailyReturn > 0 ? '#ff4d4f' : stats.dailyReturn < 0 ? '#52c41a' : '#888' }}>
                        {stats.dailyReturn !== 0 ? `${stats.dailyReturn > 0 ? '+' : ''}${stats.dailyReturn.toFixed(2)}%` : '0.00%'}
                      </div>
                      <div style={{ fontSize: 13, color: stats.dailyReturn > 0 ? '#ff4d4f' : stats.dailyReturn < 0 ? '#52c41a' : '#888' }}>
                        {(() => {
                          const totalChange = stats.positions.reduce((s, p) => {
                            const curr = (p.currentPrice ?? p.avgCost) * p.shares;
                            const prev = (p.prevClose ?? p.currentPrice ?? p.avgCost) * p.shares;
                            return s + curr - prev;
                          }, 0);
                          return `${totalChange >= 0 ? '+' : ''}${Math.round(totalChange).toLocaleString()}`;
                        })()}
                      </div>
                    </div>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">
                    <strong>{(stats.totalMarketValue / stats.initialCapital * 100).toFixed(1)}%</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={7} />
                </Table.Summary.Row>
                {stats.cash > 0 ? (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}>
                      <span />
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1}>
                      <span style={{ color: '#888' }}>现金</span>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">
                      <span style={{ color: '#888' }}>¥{(stats.cash || 0).toLocaleString()}</span>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">
                      <span style={{ color: '#888' }}>—</span>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">
                      <span style={{ color: '#888' }}>—</span>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={5} align="right">
                      <span style={{ color: '#888' }}>—</span>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={6} align="right">
                      <span style={{ color: '#888' }}>{((stats.cash || 0) / (stats.initialCapital || 1) * 100).toFixed(1)}%</span>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={7} />
                  </Table.Summary.Row>
                ) : null}
              </Table.Summary>
            )}
          />
        ) : (
          <Empty description="暂无持仓，点击「添加持仓」添加" />
        )}
      </Card>

      <PositionModal
        open={modalOpen}
        position={editingPosition}
        initialCapital={stats.initialCapital}
        currentFund={currentFund}
        otherPositions={stats.positions.map((p) => ({ code: p.code, marketValue: p.marketValue }))}
        onClose={() => { setModalOpen(false); setEditingPosition(undefined); }}
        onSave={handleSave}
      />

      <ContributionModal
        open={contributionModalOpen}
        positions={stats.positions}
        totalProfit={stats.totalProfit}
        onClose={() => setContributionModalOpen(false)}
      />
    </div>
  );
};

export default PortfolioPanel;

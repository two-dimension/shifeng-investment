import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Flex,
  Form,
  Input,
  Popover,
  Result,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CloudSyncOutlined,
  LockOutlined,
  LogoutOutlined,
  ReloadOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import type {
  AiDashboardApiResponse,
  AiDashboardSnapshot,
  IceCdsImportStatus,
} from './types';
import {
  benchmarkRefreshRequest,
  dashboardSourceEntries,
  dashboardSourceSummary,
  showDashboardSessionControls,
  sourceStatusColor,
  sourceStatusLabel,
} from './viewModel';
import {
  ArrValuationSection,
  ArtificialAnalysisSection,
  BenchmarkSection,
  ComputeRentalSection,
  DebtFinancingSection,
  ModelPricingSection,
  OpenRouterSection,
  OverviewSection,
} from './AIDashboardSections';
import { IceCdsImportModal } from './IceCdsImportModal';
import './AIDashboardPanel.css';

const { Title, Text, Paragraph } = Typography;

type AuthState = 'checking' | 'required' | 'authenticated' | 'error';

async function requestDashboard<T = AiDashboardSnapshot>(path = '', init?: RequestInit): Promise<AiDashboardApiResponse<T>> {
  const response = await fetch(`/api/ai-dashboard${path}`, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init?.headers,
    ...init,
  });
  const payload = await response.json().catch(() => ({ success: false, error: { code: 'invalid_response', message: '服务器返回了无效响应' } }));
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || `请求失败（${response.status}）`), { status: response.status, code: payload.error?.code });
  return payload;
}

type DashboardSourceEntry = ReturnType<typeof dashboardSourceEntries>[number];

function SourceStatusDetails({ entries }: { entries: DashboardSourceEntry[] }) {
  return (
    <div className="ai-source-popover">
      <Flex align="center" justify="space-between" className="ai-source-popover-header">
        <Text strong>数据源状态</Text>
        <Text type="secondary">{entries.length} 项</Text>
      </Flex>
      <div className="ai-source-popover-list">
        {entries.map(({ key, label, source }) => (
          <div className="ai-source-popover-item" key={key}>
            <Flex align="center" justify="space-between" gap={12}>
              <Space size={6}>
                <CloudSyncOutlined />
                <Text strong>{label}</Text>
              </Space>
              <Tag color={sourceStatusColor(source)}>{sourceStatusLabel(source)}</Tag>
            </Flex>
            <Text type="secondary" className="ai-source-popover-date">
              {source.asOf ? source.asOf.slice(0, 16).replace('T', ' ') : '暂无日期'}
            </Text>
            {source.message ? <Text type="secondary" className="ai-source-popover-message">{source.message}</Text> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function AccessGate({ loading, onSubmit }: { loading: boolean; onSubmit: (accessCode: string) => Promise<void> }) {
  const [form] = Form.useForm<{ accessCode: string }>();
  return (
    <div className="ai-access-wrap">
      <Card className="ai-access-card">
        <Result
          icon={<RobotOutlined className="ai-access-icon" />}
          title="AI 投资看板"
          subTitle="请输入独立访问口令。会话有效期 12 小时，口令不会存储在浏览器中。"
          extra={(
            <Form form={form} layout="vertical" onFinish={({ accessCode }) => onSubmit(accessCode)} requiredMark={false}>
              <Form.Item name="accessCode" label="访问口令" rules={[{ required: true, message: '请输入访问口令' }]}>
                <Input.Password autoFocus prefix={<LockOutlined />} placeholder="请输入访问口令" autoComplete="current-password" />
              </Form.Item>
              <Button block type="primary" htmlType="submit" loading={loading}>进入看板</Button>
            </Form>
          )}
        />
      </Card>
    </div>
  );
}

export const AIDashboardPanel: React.FC = () => {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [data, setData] = useState<AiDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [benchmarkRefreshing, setBenchmarkRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [publicAccess, setPublicAccess] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cdsImportStatus, setCdsImportStatus] = useState<IceCdsImportStatus | null>(null);
  const [cdsImportOpen, setCdsImportOpen] = useState(false);
  const [messageApi, messageContext] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusPromise = requestDashboard<IceCdsImportStatus>('/cds/import-status').catch(() => null);
      const payload = await requestDashboard<AiDashboardSnapshot>();
      const statusPayload = await statusPromise;
      setData(payload.data || null);
      setCdsImportStatus(statusPayload?.data || null);
      setPublicAccess(payload.publicAccess === true);
      setSessionExpiresAt(payload.sessionExpiresAt || null);
      setAuth('authenticated');
    } catch (requestError) {
      const status = (requestError as { status?: number }).status;
      if (status === 401) {
        setAuth('required');
        setData(null);
        setCdsImportStatus(null);
      } else {
        setError((requestError as Error).message);
        setAuth('error');
        setData(null);
        setCdsImportStatus(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (publicAccess || auth !== 'authenticated' || !sessionExpiresAt) return undefined;
    const remainingMs = Date.parse(sessionExpiresAt) - Date.now();
    const expireSession = () => {
      setAuth('required');
      setData(null);
      setCdsImportStatus(null);
      setSessionExpiresAt(null);
      messageApi.info('AI 看板会话已到期，请重新输入访问口令');
    };
    if (remainingMs <= 0) {
      expireSession();
      return undefined;
    }
    const timer = window.setTimeout(expireSession, remainingMs);
    return () => window.clearTimeout(timer);
  }, [auth, messageApi, publicAccess, sessionExpiresAt]);

  const login = async (accessCode: string) => {
    setSubmitting(true);
    try {
      await requestDashboard('/session', { method: 'POST', body: JSON.stringify({ accessCode }) });
      await load();
      messageApi.success('已进入 AI 看板');
    } catch (requestError) {
      messageApi.error((requestError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const payload = await requestDashboard('/refresh', { method: 'POST', body: JSON.stringify({ force: true }) });
      setData(payload.data || null);
      setPublicAccess(payload.publicAccess === true);
      setSessionExpiresAt(payload.sessionExpiresAt || sessionExpiresAt);
      messageApi.success('数据刷新完成');
    } catch (requestError) {
      if ((requestError as { status?: number }).status === 401) {
        setAuth('required');
        setData(null);
        setSessionExpiresAt(null);
      } else {
        messageApi.error((requestError as Error).message);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const changeTab = async (key: string) => {
    setActiveTab(key);
    const refreshRequest = benchmarkRefreshRequest(key);
    if (!refreshRequest || benchmarkRefreshing) return;
    setBenchmarkRefreshing(true);
    try {
      const payload = await requestDashboard('/refresh', {
        method: 'POST',
        body: JSON.stringify(refreshRequest),
      });
      setData(payload.data || null);
      setPublicAccess(payload.publicAccess === true);
      setSessionExpiresAt(payload.sessionExpiresAt || sessionExpiresAt);
    } catch (requestError) {
      if ((requestError as { status?: number }).status === 401) {
        setAuth('required');
        setData(null);
        setSessionExpiresAt(null);
      } else {
        messageApi.warning(`Benchmark 刷新失败，继续展示上一版：${(requestError as Error).message}`);
      }
    } finally {
      setBenchmarkRefreshing(false);
    }
  };

  const logout = async () => {
    try { await requestDashboard('/session', { method: 'DELETE' }); } catch { /* session is cleared locally either way */ }
    setAuth('required');
    setData(null);
    setCdsImportStatus(null);
    setSessionExpiresAt(null);
  };

  const completeCdsImport = useCallback(async (batchId: string) => {
    await load();
    setActiveTab('debt');
    messageApi.success(`ICE CDS 已导入：${batchId}`);
  }, [load, messageApi]);

  const tabs = useMemo(() => data ? [
    { key: 'overview', label: '总览', children: <OverviewSection data={data} /> },
    { key: 'arr', label: 'ARR & 估值', children: <ArrValuationSection data={data} /> },
    { key: 'openrouter', label: 'OpenRouter', children: <OpenRouterSection data={data} /> },
    { key: 'pricing', label: '模型价格', children: <ModelPricingSection data={data} /> },
    { key: 'benchmark', label: 'Benchmark', children: <BenchmarkSection data={data} refreshing={benchmarkRefreshing} /> },
    { key: 'aa', label: 'AA 指数与成本', children: <ArtificialAnalysisSection data={data} /> },
    { key: 'compute', label: '算力租赁', children: <ComputeRentalSection data={data} /> },
    {
      key: 'debt',
      label: '融资与债务',
      children: (
        <DebtFinancingSection
          data={data}
          cdsImportStatus={cdsImportStatus}
          onImportIceCds={() => setCdsImportOpen(true)}
        />
      ),
    },
  ] : [], [benchmarkRefreshing, cdsImportStatus, data]);

  if (auth === 'checking' || (loading && !data)) return <><Skeleton active paragraph={{ rows: 8 }} />{messageContext}</>;
  if (auth === 'required') return <>{messageContext}<AccessGate loading={submitting} onSubmit={login} /></>;
  if (auth === 'error' || (error && !data)) return <><Result status="error" title="AI 看板暂时不可用" subTitle={error} extra={<Button type="primary" onClick={() => void load()}>重试</Button>} />{messageContext}</>;
  if (!data) return null;

  const sourceEntries = dashboardSourceEntries(data.sources);
  const sourceSummary = dashboardSourceSummary(sourceEntries.map(({ source }) => source));

  return (
    <div className="ai-dashboard">
      {messageContext}
      <header className="ai-dashboard-header">
        <div>
          <Flex align="center" gap={10} wrap>
            <Title level={2}>AI 投资看板</Title>
            <Popover
              content={<SourceStatusDetails entries={sourceEntries} />}
              placement="bottom"
              trigger={['hover', 'click']}
            >
              <Button
                aria-label={`数据源状态：${sourceSummary.label}`}
                className={`ai-source-summary-button is-${sourceSummary.color}`}
                icon={<CloudSyncOutlined />}
                size="small"
                type="text"
              >
                数据源 · {sourceSummary.label}
              </Button>
            </Popover>
          </Flex>
          <Paragraph type="secondary">聚焦 AI 公司的增长变化、公开流量、定价、融资与基础设施成本。</Paragraph>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refresh()}>刷新数据</Button>
          {showDashboardSessionControls(publicAccess) && (
            <Tooltip title="退出 AI 看板会话"><Button aria-label="退出 AI 看板会话" icon={<LogoutOutlined />} onClick={() => void logout()} /></Tooltip>
          )}
        </Space>
      </header>
      {error && <Alert className="ai-page-alert" type="warning" showIcon closable title="数据加载存在异常" description={error} />}
      <Tabs className="ai-primary-tabs" activeKey={activeTab} onChange={(key) => void changeTab(key)} items={tabs} destroyOnHidden={false} />
      <IceCdsImportModal open={cdsImportOpen} onClose={() => setCdsImportOpen(false)} onImported={completeCdsImport} />
      <footer className="ai-dashboard-footer">
        数据仅供研究参考，不构成投资建议。各分片来自公开来源并独立标注状态；OpenRouter Token 流量不代表全行业使用量或模型质量。
      </footer>
    </div>
  );
};

export default AIDashboardPanel;

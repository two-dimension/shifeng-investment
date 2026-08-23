import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Flex,
  Form,
  Input,
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
import type { AiDashboardApiResponse, AiDashboardSnapshot, SourceStatus } from './types';
import {
  benchmarkRefreshRequest,
  dashboardSourceEntries,
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
import './AIDashboardPanel.css';

const { Title, Text, Paragraph } = Typography;

type AuthState = 'checking' | 'required' | 'authenticated' | 'error';

async function requestDashboard(path = '', init?: RequestInit): Promise<AiDashboardApiResponse> {
  const response = await fetch(`/api/ai-dashboard${path}`, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init?.headers,
    ...init,
  });
  const payload = await response.json().catch(() => ({ success: false, error: { code: 'invalid_response', message: '服务器返回了无效响应' } }));
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || `请求失败（${response.status}）`), { status: response.status, code: payload.error?.code });
  return payload;
}

function SourceBadge({ label, source }: { label: string; source: SourceStatus }) {
  const content = (
    <Space size={5}>
      <CloudSyncOutlined />
      <Text>{label}</Text>
      <Tag color={sourceStatusColor(source)}>{sourceStatusLabel(source)}</Tag>
      <Text type="secondary">{source.asOf ? source.asOf.slice(0, 16).replace('T', ' ') : '暂无日期'}</Text>
    </Space>
  );
  return source.message ? <Tooltip title={source.message}>{content}</Tooltip> : content;
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
  const [messageApi, messageContext] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await requestDashboard();
      setData(payload.data || null);
      setPublicAccess(payload.publicAccess === true);
      setSessionExpiresAt(payload.sessionExpiresAt || null);
      setAuth('authenticated');
    } catch (requestError) {
      const status = (requestError as { status?: number }).status;
      if (status === 401) {
        setAuth('required');
        setData(null);
      } else {
        setError((requestError as Error).message);
        setAuth('error');
        setData(null);
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
    setSessionExpiresAt(null);
  };

  const tabs = useMemo(() => data ? [
    { key: 'overview', label: '总览', children: <OverviewSection data={data} /> },
    { key: 'arr', label: 'ARR & 估值', children: <ArrValuationSection data={data} /> },
    { key: 'openrouter', label: 'OpenRouter', children: <OpenRouterSection data={data} /> },
    { key: 'pricing', label: '模型价格', children: <ModelPricingSection data={data} /> },
    { key: 'benchmark', label: 'Benchmark', children: <BenchmarkSection data={data} refreshing={benchmarkRefreshing} /> },
    { key: 'aa', label: 'AA 指数与成本', children: <ArtificialAnalysisSection data={data} /> },
    { key: 'compute', label: '算力租赁', children: <ComputeRentalSection data={data} /> },
    { key: 'debt', label: '融资与债务', children: <DebtFinancingSection data={data} /> },
  ] : [], [benchmarkRefreshing, data]);

  if (auth === 'checking' || (loading && !data)) return <><Skeleton active paragraph={{ rows: 8 }} />{messageContext}</>;
  if (auth === 'required') return <>{messageContext}<AccessGate loading={submitting} onSubmit={login} /></>;
  if (auth === 'error' || (error && !data)) return <><Result status="error" title="AI 看板暂时不可用" subTitle={error} extra={<Button type="primary" onClick={() => void load()}>重试</Button>} />{messageContext}</>;
  if (!data) return null;

  const sourceEntries = dashboardSourceEntries(data.sources);
  const hasStaleSource = sourceEntries.some(({ source }) => source.stale);

  return (
    <div className="ai-dashboard">
      {messageContext}
      <header className="ai-dashboard-header">
        <div>
          <Flex align="center" gap={10} wrap>
            <Title level={2}>AI 投资看板</Title>
            {hasStaleSource ? <Tag color="warning">部分数据过期</Tag> : <Tag color="success">数据最新</Tag>}
          </Flex>
          <Paragraph type="secondary">聚焦 AI 公司的增长变化、公开流量、定价、融资与基础设施成本。</Paragraph>
          <Flex gap={14} wrap className="ai-source-row">
            {sourceEntries.map(({ key, label, source }) => <SourceBadge key={key} label={label} source={source} />)}
          </Flex>
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
      <footer className="ai-dashboard-footer">
        数据仅供研究参考，不构成投资建议。各分片来自公开来源并独立标注状态；OpenRouter Token 流量不代表全行业使用量或模型质量。
      </footer>
    </div>
  );
};

export default AIDashboardPanel;

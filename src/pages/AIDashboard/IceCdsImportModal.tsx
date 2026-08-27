import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Flex,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { FileExcelOutlined, UploadOutlined } from '@ant-design/icons';
import type {
  AiDashboardApiResponse,
  CdsQualityStatus,
  DiscountCurveInput,
  IceCdsPreview,
} from './types';

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

function qualityTag(status: CdsQualityStatus) {
  if (status === 'validated') return <Tag color="success">已通过官方基准验证</Tag>;
  if (status === 'model-derived') return <Tag color="blue">模型换算值</Tag>;
  if (status === 'needs-review') return <Tag color="warning">待复核</Tag>;
  if (status === 'stale') return <Tag color="error">数据过期</Tag>;
  return <Tag>不可用</Tag>;
}

function parseCurveCsv(text: string): DiscountCurveInput {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = lines[0]?.split(',').map((value) => value.trim());
  const required = ['curveId', 'asOf', 'currency', 'years', 'zeroRate'];
  if (!headers || required.some((header) => !headers.includes(header))) {
    throw new Error(`曲线 CSV 必须包含：${required.join(', ')}`);
  }
  const index = new Map(headers.map((header, column) => [header, column]));
  const rows = lines.slice(1).map((line) => line.split(',').map((value) => value.trim()));
  if (rows.length === 0) throw new Error('曲线 CSV 没有节点');
  const first = rows[0];
  return {
    curveId: first[index.get('curveId')!],
    asOf: first[index.get('asOf')!],
    currency: first[index.get('currency')!] as 'USD',
    sourceLabel: index.has('sourceLabel') ? first[index.get('sourceLabel')!] : undefined,
    sourceUrl: index.has('sourceUrl') ? first[index.get('sourceUrl')!] : undefined,
    nodes: rows.map((row) => ({
      years: Number(row[index.get('years')!]),
      zeroRate: Number(row[index.get('zeroRate')!]),
    })),
  };
}

function parseCurveText(text: string): DiscountCurveInput {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('请粘贴或选择折现曲线文件');
  const curve = trimmed.startsWith('{') ? JSON.parse(trimmed) : parseCurveCsv(trimmed);
  if (!curve || typeof curve !== 'object' || !Array.isArray(curve.nodes)) throw new Error('折现曲线格式无效');
  return curve as DiscountCurveInput;
}

async function requestCds<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/ai-dashboard${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ success: false, error: { message: '服务器返回了无效响应' } })) as AiDashboardApiResponse<T>;
  if (!response.ok || !payload.data) throw new Error(payload.error?.message || `请求失败（${response.status}）`);
  return payload.data;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (batchId: string) => Promise<void>;
}

export const IceCdsImportModal: React.FC<Props> = ({ open, onClose, onImported }) => {
  const [iceText, setIceText] = useState('');
  const [curveText, setCurveText] = useState('');
  const [preview, setPreview] = useState<IceCdsPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = useMemo(() => {
    try {
      return { iceText, discountCurve: parseCurveText(curveText) };
    } catch {
      return null;
    }
  }, [curveText, iceText]);

  const resetAndClose = () => {
    if (previewing || importing) return;
    setPreview(null);
    setError(null);
    onClose();
  };

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const discountCurve = parseCurveText(curveText);
      setPreview(await requestCds<IceCdsPreview>('/cds/import/preview', { iceText, discountCurve }));
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const commit = async () => {
    if (!input || !preview || preview.blocking) return;
    setImporting(true);
    setError(null);
    try {
      const result = await requestCds<{ batchId: string }>('/cds/import', input);
      await onImported(result.batchId);
      setPreview(null);
      onClose();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      width={1040}
      title="导入 ICE 当日 EOD Price"
      onCancel={resetAndClose}
      destroyOnHidden
      footer={(
        <Flex justify="space-between" align="center" gap={12} wrap>
          <Text type="secondary">先预览换算与校验；确认时服务器会重新计算，不采用浏览器结果。</Text>
          <Space>
            <Button onClick={resetAndClose} disabled={previewing || importing}>取消</Button>
            <Button type="primary" onClick={() => void commit()} loading={importing} disabled={!preview || preview.blocking}>确认导入并写入 Excel</Button>
          </Space>
        </Flex>
      )}
    >
      <div className="ai-cds-import-body">
        <Alert
          type="info"
          showIcon
          title="免费模式：复制 ICE Settlement Prices 表格 + 提供当日 USD 折现曲线"
          description="系统只保存你提交的 ICE EOD Price，并将模型换算结果明确标为估算值；没有官方 spread 基准时不会标记为已验证。"
        />
        <div className="ai-cds-import-grid">
          <section>
            <Flex justify="space-between" align="center" gap={8}>
              <Text strong>1. ICE 表格 / CSV</Text>
              <Upload
                accept=".csv,.tsv,.txt"
                showUploadList={false}
                beforeUpload={(file) => {
                  void file.text().then((text) => { setIceText(text); setPreview(null); });
                  return false;
                }}
              >
                <Button size="small" icon={<UploadOutlined />}>选择文件</Button>
              </Upload>
            </Flex>
            <Paragraph type="secondary">列名：Clearing Date、Name、Instrument Name、EOD Price</Paragraph>
            <TextArea
              value={iceText}
              rows={8}
              onChange={(event) => { setIceText(event.target.value); setPreview(null); }}
              placeholder="从 ICE 页面复制表头和七家公司当日记录，或选择 CSV / TSV 文件"
            />
          </section>
          <section>
            <Flex justify="space-between" align="center" gap={8}>
              <Text strong>2. USD 折现曲线 JSON / CSV</Text>
              <Upload
                accept=".json,.csv,.txt"
                showUploadList={false}
                beforeUpload={(file) => {
                  void file.text().then((text) => { setCurveText(text); setPreview(null); });
                  return false;
                }}
              >
                <Button size="small" icon={<FileExcelOutlined />}>选择文件</Button>
              </Upload>
            </Flex>
            <Paragraph type="secondary">JSON 需包含 curveId、asOf、currency=USD 和 nodes；CSV 每行一个 years / zeroRate 节点。</Paragraph>
            <TextArea
              value={curveText}
              rows={8}
              onChange={(event) => { setCurveText(event.target.value); setPreview(null); }}
              placeholder='{"curveId":"usd-sofr-...","asOf":"2026-08-24","currency":"USD","nodes":[...]}'
            />
          </section>
        </div>
        <Button type="primary" ghost icon={<FileExcelOutlined />} loading={previewing} disabled={!iceText.trim() || !curveText.trim()} onClick={() => void runPreview()}>
          预览换算与校验
        </Button>
        {error ? <Alert type="error" showIcon title="无法处理这批数据" description={error} /> : null}
        {preview ? (
          <section className="ai-cds-preview">
            <Flex justify="space-between" align="center" gap={8} wrap>
              <Text strong>预览 · {preview.clearingDate} · {preview.batchId}</Text>
              <Tag color={preview.blocking ? 'error' : 'success'}>{preview.blocking ? '存在阻断项' : '可以导入'}</Tag>
            </Flex>
            {preview.warnings.map((warning) => <Alert key={warning} type="warning" showIcon title={warning} />)}
            <Table
              rowKey="company"
              size="small"
              pagination={false}
              scroll={{ x: 980 }}
              dataSource={preview.rows}
              columns={[
                { title: '公司', dataIndex: 'company', fixed: 'left', width: 110 },
                { title: '合约', dataIndex: 'instrumentName', width: 310 },
                { title: 'EOD Price', dataIndex: 'eodPrice', width: 110, align: 'right', render: (value: number) => value.toFixed(4) },
                { title: '估算 Spread', dataIndex: 'spreadBp', width: 125, align: 'right', render: (value: number) => `${value.toFixed(2)} bp` },
                { title: '价格残差', dataIndex: 'priceResidual', width: 115, align: 'right', render: (value: number) => value.toFixed(6) },
                { title: '状态', dataIndex: 'qualityStatus', width: 180, render: qualityTag },
                { title: '校验', dataIndex: 'validationMessage', width: 280 },
              ]}
            />
          </section>
        ) : null}
      </div>
    </Modal>
  );
};

export default IceCdsImportModal;

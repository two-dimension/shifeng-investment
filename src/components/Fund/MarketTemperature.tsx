import React, { useEffect, useMemo, useState } from 'react';
import { Card, Checkbox, Col, Popover, Row, Spin, Typography, message } from 'antd';
import { DownOutlined } from '@ant-design/icons';

const { Text } = Typography;

type Market = 'a' | 'hk' | 'us' | 'jp' | 'kr';

interface MarketIndexQuote {
  code: string;
  name: string;
  currentPrice: number | null;
  prevClose: number | null;
  pctChg: number | null;
}

interface MarketTemperatureProps {
  market: Market;
  refreshKey?: number;
}

const marketTitle: Record<Market, string> = {
  a: 'A股市场温度',
  hk: '港股市场温度',
  us: '美股市场温度',
  jp: '日股市场温度',
  kr: '韩股市场温度',
};

const marketOptions: Record<Market, { code: string; name: string }[]> = {
  a: [
    { code: '000001.SS', name: '上证指数' },
    { code: '399001.SZ', name: '深证成指' },
    { code: '000300.SS', name: '沪深300' },
    { code: '000905.SS', name: '中证500' },
    { code: '000852.SS', name: '中证1000' },
    { code: '000688.SS', name: '科创50' },
    { code: '399006.SZ', name: '创业板指' },
    { code: '899050.BJ', name: '北证50' },
  ],
  hk: [
    { code: '^HSI', name: '恒生指数' },
    { code: '3033.HK', name: '恒生科技' },
    { code: '^HSCE', name: '国企指数' },
    { code: '2800.HK', name: '盈富基金' },
  ],
  us: [
    { code: '^NDX', name: '纳斯达克100' },
    { code: '^GSPC', name: '标普500' },
    { code: '^DJI', name: '道琼斯' },
    { code: 'NQ=F', name: '纳指期货' },
    { code: 'ES=F', name: '标普期货' },
    { code: 'YM=F', name: '道指期货' },
    { code: '^SOX', name: '费城半导体' },
    { code: '^RUT', name: '罗素2000' },
    { code: '^VIX', name: 'VIX' },
    { code: 'DX-Y.NYB', name: '美元指数' },
    { code: 'TLT', name: '美债长债' },
  ],
  jp: [
    { code: '^N225', name: '日经225' },
    { code: '^TPX', name: 'TOPIX' },
    { code: '1306.T', name: 'TOPIX ETF' },
    { code: '285A.T', name: 'Kioxia' },
    { code: '8035.T', name: '东京电子' },
    { code: '6981.T', name: '村田制作所' },
  ],
  kr: [
    { code: '^KS11', name: 'KOSPI' },
    { code: '^KQ11', name: 'KOSDAQ' },
    { code: '005930.KS', name: '三星电子' },
    { code: '000660.KS', name: 'SK海力士' },
  ],
};

const defaultCodes: Record<Market, string[]> = {
  a: ['000001.SS', '000300.SS', '000688.SS', '399006.SZ'],
  hk: ['^HSI', '3033.HK', '^HSCE'],
  us: ['^NDX', '^GSPC', '^DJI', '^SOX'],
  jp: ['^N225', '^TPX'],
  kr: ['^KS11', '^KQ11'],
};

const STORAGE_KEY = 'shifeng_market_temperature_codes';

const valueColor = (value: number | null) => {
  if (value === null) return '#8c8c8c';
  if (value > 0) return '#ff4d4f';
  if (value < 0) return '#52c41a';
  return '#8c8c8c';
};

const formatPrice = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
};

const formatPct = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
};

const MarketTemperature: React.FC<MarketTemperatureProps> = ({ market, refreshKey = 0 }) => {
  const [quotes, setQuotes] = useState<MarketIndexQuote[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedByMarket, setSelectedByMarket] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const selectedCodes = selectedByMarket[market] || defaultCodes[market];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/market-indices?market=${market}&codes=${encodeURIComponent(selectedCodes.join(','))}`)
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          setQuotes(Array.isArray(data.indices) ? data.indices : []);
        }
      })
      .catch(() => {
        if (!cancelled) setQuotes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [market, selectedCodes.join(','), refreshKey]);

  const updateSelectedCodes = (nextCodes: string[]) => {
    if (nextCodes.length > 4) {
      message.warning('最多选择 4 个');
      return;
    }
    if (nextCodes.length === 0) {
      message.warning('至少保留 1 个');
      return;
    }
    const next = { ...selectedByMarket, [market]: nextCodes };
    setSelectedByMarket(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const title = (
    <Popover
      trigger="click"
      placement="bottomLeft"
      content={
        <div style={{ width: 220 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            选择显示项目，最多 4 个
          </Text>
          <Checkbox.Group value={selectedCodes} onChange={(values) => updateSelectedCodes(values as string[])}>
            <div style={{ display: 'grid', gap: 8 }}>
              {marketOptions[market].map((option) => (
                <Checkbox key={option.code} value={option.code}>
                  {option.name}
                </Checkbox>
              ))}
            </div>
          </Checkbox.Group>
        </div>
      }
    >
      <button
        type="button"
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          fontWeight: 600,
          color: '#262626',
        }}
      >
        {marketTitle[market]} <DownOutlined style={{ fontSize: 10 }} />
      </button>
    </Popover>
  );

  const content = useMemo(() => {
    if (loading && quotes.length === 0) {
      return (
        <div style={{ height: 92, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      );
    }

    return (
      <Row gutter={[10, 10]}>
        {quotes.map((quote) => (
          <Col xs={12} sm={8} md={6} lg={6} xl={6} key={quote.code}>
            <div
              style={{
                border: '1px solid #f0f0f0',
                borderRadius: 10,
                padding: '10px 12px',
                background: '#fafafa',
                minHeight: 78,
              }}
            >
              <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                {quote.name}
              </Text>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: '#262626' }}>
                  {formatPrice(quote.currentPrice)}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: valueColor(quote.pctChg) }}>
                  {formatPct(quote.pctChg)}
                </span>
              </div>
            </div>
          </Col>
        ))}
      </Row>
    );
  }, [loading, quotes]);

  return (
    <Card
      size="small"
      title={title}
      style={{ marginBottom: 16 }}
      styles={{ body: { padding: 12 } }}
    >
      {content}
    </Card>
  );
};

export default MarketTemperature;

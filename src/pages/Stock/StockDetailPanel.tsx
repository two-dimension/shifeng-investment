import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Spin, Empty, Typography, Space, Button, List, Tag, Segmented } from 'antd';
import { ArrowLeftOutlined, RiseOutlined, FallOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import dayjs from 'dayjs';
import { fetchKline } from '../../services/quoteApi';
import { STOCK_LIST, HK_STOCK_LIST, US_STOCK_LIST } from '../../data/stocks';
import { useNewsFeed } from '../../hooks/useNewsFeed';
import { useTheme } from '../../hooks/useTheme';

const { Text } = Typography;

type Period = 'daily' | '15min' | '30min' | '60min';

interface KlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  pct_chg: number;
}

const StockDetailPanel: React.FC = () => {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { news } = useNewsFeed();

  const [klineData, setKlineData] = useState<KlineBar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('daily');
  const [realtimeQuote, setRealtimeQuote] = useState<{ open: number; close: number; high: number; low: number; volume: number; pre_close: number; pct_chg: number } | null>(null);

  // 股票名称：从A股/港股/美股列表中查找
  const stockInfo = useMemo(() => {
    const upperCode = code?.toUpperCase();
    const aShare = STOCK_LIST.find(s => s.code === code);
    if (aShare) return { code, name: aShare.name };
    const hkStock = HK_STOCK_LIST.find(s => s.code === upperCode);
    if (hkStock) return { code, name: hkStock.name };
    const usStock = US_STOCK_LIST.find(s => s.code === upperCode);
    if (usStock) return { code, name: usStock.name };
    return { code, name: code };
  }, [code]);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    setError(null);
    setRealtimeQuote(null);
    fetchKline(code, 300, period)
      .then(data => {
        if (data.success && data.data) {
          setKlineData(data.data);
          // 日K且当天非最新K线时，获取今日实时报价拼入图表
          if (period === 'daily') {
            const today = dayjs().format('YYYY-MM-DD');
            const latestDate = data.data[0]?.date;
            if (latestDate !== today && dayjs().day() >= 1 && dayjs().day() <= 5) {
              fetch(`/api/quote?code=${code}`)
                .then(r => r.json())
                .then(q => {
                  if (q.trade_date === today) {
                    setRealtimeQuote({
                      open: q.open,
                      close: q.close,
                      high: q.high,
                      low: q.low,
                      volume: q.volume,
                      pre_close: q.pre_close,
                      pct_chg: q.pct_chg,
                    });
                  }
                })
                .catch(() => {});
            }
          }
        } else {
          setError(data.error || '获取K线数据失败');
        }
      })
      .catch(err => {
        setError(err.message || '网络错误');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [code, period]);

  // 拼接今日实时K线（日K模式下，若当日未收盘则插入实时K线）
  const displayData = useMemo(() => {
    const today = dayjs().format('YYYY-MM-DD');
    // klineData 永远是倒序（ newest first）。detect：如果第一条 < 最后一条，说明原始数据就是正序（分钟数据）
    const isAscending = klineData.length >= 2 && klineData[0].date < klineData[klineData.length - 1].date;
    const ordered = isAscending ? klineData : [...klineData].reverse();
    if (realtimeQuote && ordered[ordered.length - 1]?.date !== today) {
      return [...ordered, {
        date: today,
        open: realtimeQuote.open,
        close: realtimeQuote.close,
        high: realtimeQuote.high,
        low: realtimeQuote.low,
        volume: realtimeQuote.volume,
        pct_chg: realtimeQuote.pct_chg,
      }];
    }
    return ordered;
  }, [klineData, realtimeQuote]);

  // 最新一条K线（displayData 是正序，最新在最后）
  const latest = useMemo(() => {
    if (displayData.length === 0) return null;
    return displayData[displayData.length - 1] || null;
  }, [displayData]);

  const prevClose = useMemo(() => {
    // 如果今日实时K线已插入，昨收取 realtimeQuote.pre_close；否则从 displayData 倒数第二个获取
    if (realtimeQuote && displayData.length > 0 && displayData[displayData.length - 1].date === dayjs().format('YYYY-MM-DD')) {
      return realtimeQuote.pre_close;
    }
    return displayData.length >= 2 ? displayData[displayData.length - 2].close : null;
  }, [displayData, realtimeQuote]);

  // 根据前收盘计算真实涨跌幅
  const latestPctChg = useMemo(() => {
    if (!latest || prevClose == null || prevClose <= 0) return latest?.pct_chg ?? 0;
    return (latest.close - prevClose) / prevClose * 100;
  }, [latest, prevClose]);

  // 相关新闻（按股票名称过滤）
  const relatedNews = useMemo(() => {
    if (!stockInfo.name) return [];
    return news.filter(item =>
      item.title.includes(stockInfo.name || '') ||
      item.title.includes(code!)
    ).slice(0, 10);
  }, [news, stockInfo, code]);

  // ---------- 技术指标计算（基于 displayData，正序）----------
  const indicators = useMemo(() => {
    if (displayData.length < 26) return { ma5: [], ma10: [], ma20: [], macd: [], dif: [], dea: [] };
    const closes = displayData.map(d => d.close);

    const calcEMA = (data: number[], period: number): number[] => {
      const k = 2 / (period + 1);
      const ema: number[] = [];
      ema[0] = data[0];
      for (let i = 1; i < data.length; i++) ema[i] = data[i] * k + ema[i - 1] * (1 - k);
      return ema;
    };

    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const dif = ema12.map((v, i) => v - ema26[i]);
    const dea = calcEMA(dif, 9);
    const macd = dif.map((v, i) => (v - dea[i]) * 2);

    const calcMA = (data: number[], period: number): number[] =>
      data.map((_, i) => i < period - 1 ? NaN : data.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period);

    return {
      ma5: calcMA(closes, 5),
      ma10: calcMA(closes, 10),
      ma20: calcMA(closes, 20),
      dif,
      dea,
      macd,
    };
  }, [klineData]);

  // 最新 MACD 值（DIF, DEA, MACD 柱）
  const latestMACD = useMemo(() => {
    const m = indicators.macd;
    if (m.length === 0) return null;
    return {
      dif: indicators.dif[m.length - 1],
      dea: indicators.dea[m.length - 1],
      bar: m[m.length - 1],
    };
  }, [indicators]);

  // 最新成交量
  const latestVolume = useMemo(() => {
    if (klineData.length === 0) return null;
    return klineData[klineData.length - 1].volume;
  }, [klineData]);

  // K线图 ECharts 配置
  const klineOption = useMemo(() => {
    if (displayData.length === 0) return {};
    const dates = displayData.map(d => d.date);
    const ohlc = displayData.map(d => [d.open, d.close, d.low, d.high]);
    const volumes = displayData.map(d => ({ value: d.volume, itemStyle: { color: d.close >= d.open ? '#ef5350' : '#26a69a' } }));
    const orderedMa5 = indicators.ma5;
    const orderedMa10 = indicators.ma10;
    const orderedMa20 = indicators.ma20;
    // MACD 数据已经是基于正序计算，直接用
    const macdData = indicators.macd;
    const difData = indicators.dif;
    const deaData = indicators.dea;

    const upColor = '#ef5350';
    const downColor = '#26a69a';
    const textColor = theme === 'dark' ? '#e8e8e8' : '#333';
    const gridLineColor = theme === 'dark' ? '#222' : '#f0f0f0';
    const axisLineColor = theme === 'dark' ? '#333' : '#ddd';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: unknown) => {
          const arr = (params as { seriesName: string; dataIndex: number; value: number | number[] }[]);
          if (!arr || arr.length === 0) return '';
          const idx = arr[0].dataIndex;
          const d = displayData[idx];
          if (!d) return '';
          const today = dayjs().format('YYYY-MM-DD');
          const isToday = d.date === today;
          // 今日动态K线用 realtimeQuote.pre_close 作为昨收，其他用前一根收盘价
          const prevCloseVal = isToday && realtimeQuote
            ? realtimeQuote.pre_close
            : (idx > 0 ? displayData[idx - 1].close : d.open);
          const pctChgCalc = prevCloseVal > 0 ? ((d.close - prevCloseVal) / prevCloseVal * 100) : 0;
          const volItem = arr.find(p => p.seriesName === 'VOLUME');
          const difItem = arr.find(p => p.seriesName === 'DIF');
          const deaItem = arr.find(p => p.seriesName === 'DEA');
          const macdItem = arr.find(p => p.seriesName === 'MACD');
          return `<div style="font-size:12px">
            <div>${d.date}</div>
            <div>开: ${d.open} &nbsp; 收: ${d.close} &nbsp; 高: ${d.high} &nbsp; 低: ${d.low}</div>
            <div>涨跌: ${pctChgCalc >= 0 ? '+' : ''}${pctChgCalc.toFixed(2)}%</div>
            ${volItem ? `<div>VOLUME: ${(d.volume / 100).toFixed(2)}万手</div>` : ''}
            ${difItem ? `<div>DIF: ${(difItem.value as number).toFixed(3)}</div>` : ''}
            ${deaItem ? `<div>DEA: ${(deaItem.value as number).toFixed(3)}</div>` : ''}
            ${macdItem ? `<div>MACD: ${(macdItem.value as number).toFixed(3)}</div>` : ''}
          </div>`;
        }
      },
      legend: { show: true, top: 0, textStyle: { color: textColor, fontSize: 11 }, inactiveColor: '#666', data: ['MA5', 'MA10', 'MA20'] },
      title: [
        {},
        { text: 'VOLUME', textStyle: { color: textColor, fontSize: 10 }, left: 60, top: '60%', z: 10 },
        { text: 'MACD', textStyle: { color: textColor, fontSize: 10 }, left: 60, top: '77%', z: 10 },
      ],
      grid: [
        { left: 60, right: 20, top: 30, height: '38%' },
        { left: 60, right: 20, top: '60%', height: '15%' },
        { left: 60, right: 20, top: '77%', height: '20%' },
      ],
      xAxis: [
        { type: 'category', data: dates, gridIndex: 0, boundaryGap: true, axisLine: { lineStyle: { color: axisLineColor } }, axisLabel: { color: textColor, fontSize: 10 }, splitLine: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 1, boundaryGap: true, axisLine: { lineStyle: { color: axisLineColor } }, axisLabel: { show: false }, splitLine: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 2, boundaryGap: true, axisLine: { lineStyle: { color: axisLineColor } }, axisLabel: { show: false }, splitLine: { show: false }, axisTick: { show: false } },
      ],
      yAxis: [
        { scale: true, gridIndex: 0, axisLine: { show: false }, axisLabel: { color: textColor, fontSize: 10 }, splitLine: { lineStyle: { color: gridLineColor } }, axisTick: { show: false } },
        { scale: true, gridIndex: 1, axisLine: { show: false }, axisLabel: { show: false }, splitLine: { show: false }, axisTick: { show: false } },
        { scale: true, gridIndex: 2, axisLine: { show: false }, axisLabel: { color: textColor, fontSize: 10 }, splitLine: { lineStyle: { color: gridLineColor } }, axisTick: { show: false } },
      ],
      series: [
        { name: 'MA5', type: 'line', data: orderedMa5, smooth: true, lineStyle: { color: '#f39c12', width: 1 }, symbol: 'none', xAxisIndex: 0, yAxisIndex: 0 },
        { name: 'MA10', type: 'line', data: orderedMa10, smooth: true, lineStyle: { color: '#e74c3c', width: 1 }, symbol: 'none', xAxisIndex: 0, yAxisIndex: 0 },
        { name: 'MA20', type: 'line', data: orderedMa20, smooth: true, lineStyle: { color: '#3498db', width: 1 }, symbol: 'none', xAxisIndex: 0, yAxisIndex: 0 },
        { type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor } },
        { name: 'VOLUME', type: 'bar', data: volumes, xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' },
        { name: 'DIF', type: 'line', data: difData, smooth: true, lineStyle: { color: '#9966ff', width: 1 }, symbol: 'none', xAxisIndex: 2, yAxisIndex: 2 },
        { name: 'DEA', type: 'line', data: deaData, smooth: true, lineStyle: { color: '#ffcc00', width: 1 }, symbol: 'none', xAxisIndex: 2, yAxisIndex: 2 },
        {
          name: 'MACD', type: 'bar', data: macdData.map(v => ({ value: v, itemStyle: { color: v >= 0 ? upColor : downColor } })),
          xAxisIndex: 2, yAxisIndex: 2, barWidth: '60%',
        },
      ],
      dataZoom: [
        { type: 'inside', start: 85, end: 100, xAxisIndex: [0, 1, 2] },
        { type: 'slider', start: 85, end: 100, xAxisIndex: [0, 1, 2], height: 18, bottom: 2, borderColor: 'transparent', backgroundColor: theme === 'dark' ? '#1f1f1f' : '#f0f0f0', fillerColor: 'rgba(100,149,237,0.2)', handleStyle: { color: '#6495ed' } },
      ],
    };
  }, [klineData, indicators, theme, latestMACD, latestVolume]);

  if (!code) {
    return <Empty description="无效的股票代码" />;
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
          返回
        </Button>
      </Space>

      <Card
        size="small"
        title={
          <Space>
            <Text strong style={{ fontSize: 18 }}>{stockInfo.name}</Text>
            <Text type="secondary">{stockInfo.code}</Text>
          </Space>
        }
        style={{ marginBottom: 16, background: theme === 'dark' ? '#1f1f1f' : '#fff' }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : error ? (
          <Empty description={error} />
        ) : latest ? (
          <Row gutter={16}>
            <Col span={6}>
              <Statistic
                title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>最新价</span>}
                value={latest.close}
                precision={2}
                valueStyle={{ color: latestPctChg >= 0 ? '#ff4d4f' : '#52c41a', fontSize: 22 }}
                suffix="元"
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>涨跌幅</span>}
                value={latestPctChg}
                precision={2}
                prefix={latestPctChg >= 0 ? <RiseOutlined /> : <FallOutlined />}
                valueStyle={{ color: latestPctChg >= 0 ? '#ff4d4f' : '#52c41a' }}
                suffix="%"
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>昨收</span>}
                value={prevClose ?? latest.open}
                precision={2}
                valueStyle={{ color: theme === 'dark' ? '#fff' : '#333' }}
                suffix="元"
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={<span style={{ color: theme === 'dark' ? '#888' : '#666' }}>成交量</span>}
                value={(latest.volume / 10000).toFixed(2)}
                valueStyle={{ color: theme === 'dark' ? '#fff' : '#333' }}
                suffix="万手"
              />
            </Col>
          </Row>
        ) : null}
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <Text strong style={{ fontSize: 18 }}>
              {period === 'daily' ? '日K' : period === '15min' ? '15分钟K' : period === '30min' ? '30分钟K' : '60分钟K'}
            </Text>
            <Segmented
              size="small"
              value={period}
              onChange={(v) => setPeriod(v as Period)}
              options={[
                { label: '日K', value: 'daily' },
                { label: '15分', value: '15min' },
                { label: '30分', value: '30min' },
                { label: '60分', value: '60min' },
              ]}
            />
          </Space>
        }
        style={{ marginBottom: 16, background: theme === 'dark' ? '#1f1f1f' : '#fff' }}
        styles={{ body: { height: 560 } }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
        ) : error ? (
          <Empty description={error} />
        ) : (
          <ReactECharts option={klineOption} style={{ height: 400 }} />
        )}
      </Card>

      {relatedNews.length > 0 && (
        <Card
          size="small"
          title="相关新闻"
          style={{ background: theme === 'dark' ? '#1f1f1f' : '#fff' }}
          styles={{ body: { maxHeight: 300, overflow: 'auto' } }}
        >
          <List
            size="small"
            dataSource={relatedNews}
            renderItem={item => (
              <List.Item style={{ padding: '8px 0' }}>
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color="blue" style={{ fontSize: 11 }}>{item.category}</Tag>
                    <Text style={{ fontSize: 13 }}>{item.title}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {item.source} &nbsp; {item.time || dayjs().format('HH:mm')}
                  </Text>
                </div>
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
};

export default StockDetailPanel;

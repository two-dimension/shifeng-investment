import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Empty, Space, Spin, Statistic, Table, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { useFundPortfolio } from '../../hooks/useFundPortfolio';
import { type Fund, type Position } from '../../types/fund';

const { Text, Title } = Typography;

interface EvidenceItem {
  type: '公告监控' | '业绩预告' | '新闻资讯';
  title: string;
  summary?: string;
  url?: string;
  text: string;
  polarity: 'positive' | 'negative' | 'neutral';
}

interface ActiveResearchSource {
  title: string;
  url?: string;
  source?: string;
  summary?: string;
  query?: string;
}

interface ActiveResearchResult {
  success: boolean;
  level: 'company' | 'theme' | 'unknown';
  reason: string;
  confidence: '高' | '中' | '低';
  sources: ActiveResearchSource[];
  queries: string[];
}

interface AnomalyRow extends Position {
  key: string;
  dailyReturn: number;
  direction: '异常上涨' | '异常下跌';
  reason: string;
  confidence: '高' | '中' | '低';
  sources: EvidenceItem[];
  isFocused: boolean;
}

const THRESHOLD = 5;
const upColor = '#ff4d4f';
const downColor = '#52c41a';

const textOf = (...values: unknown[]) => values
  .flatMap((value) => Array.isArray(value) ? value : [value])
  .filter((value) => value !== undefined && value !== null)
  .map((value) => String(value))
  .join(' ');

const normalize = (value: string) => value.toLowerCase();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const themeAliasMap: Array<{ keyword: string; aliases: string[] }> = [
  { keyword: '机器人', aliases: ['机器人', '宇树', 'unitree', '具身智能', '人形机器人'] },
  { keyword: '存储', aliases: ['存储', 'hbm', 'dram', 'nand', 'memory', '三星', 'samsung', 'sk海力士', '海力士', 'hynix', 'korea'] },
  { keyword: 'hbm', aliases: ['hbm', 'dram', '三星', 'samsung', 'sk海力士', '海力士', 'hynix', 'memory', 'korea'] },
  { keyword: 'cpo', aliases: ['cpo', '光模块', '光通信', 'coherent', 'semiAnalysis', 'optical'] },
  { keyword: '半导体', aliases: ['半导体', 'semiconductor', 'chip', '晶圆', '先进制程'] },
  { keyword: 'mlcc', aliases: ['mlcc', '被动元件', '电容'] },
  { keyword: '燃机', aliases: ['燃机', '燃气轮机', 'gas turbine', 'power turbine', 'ge vernova'] },
];

const companyAliasMap: Array<{ keyword: string; aliases: string[] }> = [
  { keyword: '三星电子', aliases: ['samsung', 'samsung electronics', '005930'] },
  { keyword: 'sk海力士', aliases: ['sk hynix', 'hynix', '000660'] },
  { keyword: '海力士', aliases: ['sk hynix', 'hynix', '000660'] },
  { keyword: '特斯拉', aliases: ['tesla', 'tsla'] },
  { keyword: '英伟达', aliases: ['nvidia', 'nvda'] },
  { keyword: '美光', aliases: ['micron', '$mu'] },
  { keyword: '美光科技', aliases: ['micron', '$mu'] },
  { keyword: '台积电', aliases: ['tsmc', 'taiwan semiconductor', 'tsm'] },
  { keyword: '博通', aliases: ['broadcom', 'avgo'] },
  { keyword: '迈威尔', aliases: ['marvell', 'mrvl'] },
  { keyword: '英特尔', aliases: ['intel', 'intc'] },
  { keyword: '科磊', aliases: ['kla', 'klac'] },
  { keyword: '应用材料', aliases: ['applied materials', 'amat'] },
  { keyword: '东京电子', aliases: ['tokyo electron', 'tel', '8035'] },
  { keyword: '村田制作所', aliases: ['murata', 'murata manufacturing', '6981'] },
  { keyword: '太阳诱电', aliases: ['taiyo yuden', '6976'] },
  { keyword: '发那科', aliases: ['fanuc', '6954'] },
  { keyword: '安川电机', aliases: ['yaskawa', 'yaskawa electric', '6506'] },
  { keyword: '基恩士', aliases: ['keyence', '6861'] },
  { keyword: '台达电子', aliases: ['delta electronics'] },
  { keyword: '联电', aliases: ['umc', 'united microelectronics'] },
  { keyword: '格芯', aliases: ['globalfoundries', 'gfs'] },
  { keyword: '阿斯麦', aliases: ['asml'] },
  { keyword: '泛林', aliases: ['lam research', 'lrcx'] },
  { keyword: '迪斯科', aliases: ['disco', '6146'] },
  { keyword: '爱德万', aliases: ['advantest', '6857'] },
  { keyword: '铠侠', aliases: ['kioxia', '285a'] },
  { keyword: 'Lasertec', aliases: ['lasertec', '6920'] },
  { keyword: 'MARUWA', aliases: ['maruwa', '5344'] },
  { keyword: 'Resonac', aliases: ['resonac', '4004'] },
  { keyword: 'SCREEN', aliases: ['screen holdings', 'screen', '7735'] },
  { keyword: 'SMC', aliases: ['smc', '6273'] },
  { keyword: 'TDK', aliases: ['tdk', '6762'] },
  { keyword: 'Tri Chemical', aliases: ['tri chemical', '4369'] },
  { keyword: '三菱重工', aliases: ['mitsubishi heavy industries', 'mitsubishi heavy', '7011'] },
  { keyword: '东京应化', aliases: ['tokyo ohka', 'tok', '4186'] },
  { keyword: '东京精密', aliases: ['tokyo seimitsu', 'accretech', '7729'] },
  { keyword: '京瓷', aliases: ['kyocera', '6971'] },
  { keyword: '住友电气', aliases: ['sumitomo electric', '5802'] },
  { keyword: '信越化学', aliases: ['shin-etsu', 'shin etsu', '4063'] },
  { keyword: '古河电气', aliases: ['furukawa electric', '5801'] },
  { keyword: '藤仓', aliases: ['fujikura', '5803'] },
  { keyword: '韩美半导体', aliases: ['hanmi semiconductor', 'hanmi', '042700'] },
  { keyword: 'Techwing', aliases: ['techwing', '089030'] },
  { keyword: 'EO Technics', aliases: ['eo technics', '039030'] },
  { keyword: 'Wonik IPS', aliases: ['wonik ips', '240810'] },
  { keyword: 'Soulbrain', aliases: ['soulbrain', '357780'] },
  { keyword: '高通', aliases: ['qualcomm', 'qcom'] },
  { keyword: '德州仪器', aliases: ['texas instruments', 'txn'] },
  { keyword: '戴尔科技', aliases: ['dell', 'dell technologies'] },
  { keyword: '西部数据', aliases: ['western digital', 'wdc'] },
  { keyword: '希捷', aliases: ['seagate', 'stx'] },
  { keyword: '希捷科技', aliases: ['seagate', 'stx'] },
  { keyword: '航空环境', aliases: ['aerovironment', 'avav'] },
  { keyword: '红猫', aliases: ['red cat', 'rcat'] },
  { keyword: '火箭实验室', aliases: ['rocket lab', 'rklb'] },
  { keyword: '铱星', aliases: ['iridium', 'irdm'] },
  { keyword: '全球星', aliases: ['globalstar', 'gsat'] },
  { keyword: '维谛', aliases: ['vertiv', 'vrt'] },
  { keyword: '超微电脑', aliases: ['super micro', 'super micro computer', 'smci'] },
];

const inferPolarity = (text: string): EvidenceItem['polarity'] => {
  const positiveWords = ['利好', '增长', '大增', '超预期', '中标', '订单', '涨价', '扩产', '回购', '增持', '获批', '突破', '合作', '景气', '上调'];
  const negativeWords = ['利空', '下滑', '下降', '亏损', '低于预期', '减持', '处罚', '调查', '风险', '违约', '降价', '砍单', '终止', '撤回', '被立案'];
  const normalized = normalize(text);
  const positive = positiveWords.some((word) => normalized.includes(normalize(word)));
  const negative = negativeWords.some((word) => normalized.includes(normalize(word)));
  if (positive && !negative) return 'positive';
  if (negative && !positive) return 'negative';
  return 'neutral';
};

const evidenceSupportsMove = (item: EvidenceItem, dailyReturn: number) => {
  if (item.polarity === 'neutral') return true;
  if (dailyReturn >= 0) return item.polarity === 'positive';
  return item.polarity === 'negative';
};

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
};

const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('主动搜索失败');
  return response.json();
};

const evidenceTitle = (item: Record<string, unknown>, fallback: string) => {
  return String(item.title || item.announcementTitle || item.name || item.stockName || item.companyName || fallback);
};

const evidenceSummary = (item: Record<string, unknown>) => {
  return textOf(item.summary, item.snippet, item.description, item.conclusion, item.scoreLabel, item.logic, item.facts).slice(0, 180);
};

const collectNewsEvidence = (payload: unknown): EvidenceItem[] => {
  const data = payload as Record<string, unknown> | null;
  const directNews = Array.isArray(data?.news) ? data.news : [];
  const nestedNews = data?.news && typeof data.news === 'object' && Array.isArray((data.news as Record<string, unknown>).news)
    ? (data.news as Record<string, unknown>).news as unknown[]
    : [];
  const entryNews = Array.isArray(data?.entries)
    ? (data.entries as unknown[]).flatMap((entry) => {
      const record = entry as Record<string, unknown>;
      return Array.isArray(record.news) ? record.news as unknown[] : [];
    })
    : [];
  const items = directNews.length > 0 ? directNews : nestedNews.length > 0 ? nestedNews : entryNews;

  return items.map((raw) => {
    const item = raw as Record<string, unknown>;
    const title = evidenceTitle(item, '新闻资讯');
    const summary = evidenceSummary(item);
    const text = textOf(
      title,
      summary,
      item.category,
      item.source,
      item.content,
      item.description,
      item.snippet,
      item.investmentCategory,
      item.sourceCategory,
      item.collectionChannel,
      item.symbols,
      item.tags
    );
    return {
      type: '新闻资讯' as const,
      title,
      summary,
      url: typeof item.url === 'string' ? item.url : undefined,
      text: normalize(text),
      polarity: inferPolarity(text),
    };
  });
};

const collectResearchEvidence = (payload: unknown, type: '公告监控' | '业绩预告'): EvidenceItem[] => {
  const data = payload as Record<string, unknown> | null;
  const buckets = ['topGood', 'topBad', 'allGood', 'allBad', 'allItems'] as const;
  const items = buckets.flatMap((bucket) => Array.isArray(data?.[bucket]) ? (data[bucket] as unknown[]).map((item) => ({ item, bucket })) : []);

  return items.map(({ item: raw, bucket }) => {
    const item = raw as Record<string, unknown>;
    const title = evidenceTitle(item, type);
    const summary = evidenceSummary(item);
    const text = textOf(
      item.code,
      item.stockCode,
      item.name,
      item.stockName,
      item.companyName,
      item.announcementTitle,
      title,
      summary,
      item.facts,
      item.type
    );
    return {
      type,
      title,
      summary,
      url: typeof item.url === 'string' ? item.url : undefined,
      text: normalize(text),
      polarity: bucket.includes('Good')
        ? 'positive'
        : bucket.includes('Bad')
          ? 'negative'
          : inferPolarity(text),
    };
  });
};

const getDailyReturn = (position: Position) => {
  const currentPrice = position.currentPrice ?? position.avgCost;
  const prevClose = position.prevClose ?? currentPrice;
  if (!Number.isFinite(currentPrice) || !Number.isFinite(prevClose) || prevClose <= 0) return 0;
  return ((currentPrice - prevClose) / prevClose) * 100;
};

const getFundDailyReturn = (positions: Position[]) => {
  let current = 0;
  let previous = 0;
  positions.forEach((position) => {
    const currentPrice = position.currentPrice ?? position.avgCost;
    const prevClose = position.prevClose ?? currentPrice;
    current += currentPrice * position.shares;
    previous += prevClose * position.shares;
  });
  return previous > 0 ? ((current - previous) / previous) * 100 : 0;
};

const getThemeKeywords = (fundName: string) => {
  const stripped = fundName.replace(/^(美股|日股|韩国|韩股|港股|A股)/, '');
  const baseKeywords = [fundName, stripped, ...stripped.split(/[\/\s-]+/)].filter((word) => word.length >= 2);
  const aliasKeywords = themeAliasMap
    .filter((item) => normalize(fundName).includes(normalize(item.keyword)) || normalize(stripped).includes(normalize(item.keyword)))
    .flatMap((item) => item.aliases);
  return Array.from(new Set([...baseKeywords, ...aliasKeywords].filter((word) => word.length >= 2)));
};

const getComparableTheme = (fundName: string) => fundName
  .replace(/^(美股|日股|韩国|韩股|港股|A股)/, '')
  .replace(/韩国/g, '')
  .replace(/[\s/_-]/g, '')
  .toLowerCase();

const matchesPositionDirectly = (item: EvidenceItem, position: Position) => {
  const code = normalize(position.code);
  const name = normalize(position.name);
  const aliases = companyAliasMap
    .filter((entry) => name.includes(normalize(entry.keyword)))
    .flatMap((entry) => entry.aliases.map((alias) => normalize(alias)));
  const isAsciiTicker = /^[a-z.=-]{1,8}$/i.test(position.code);
  const codeMatched = isAsciiTicker
    ? new RegExp(`(^|[^a-z0-9])\\$?${escapeRegExp(code)}([^a-z0-9]|$)`, 'i').test(item.text)
    : item.text.includes(code);
  return codeMatched || (!!name && item.text.includes(name)) || aliases.some((alias) => item.text.includes(alias));
};

const getCompatibleThemeEvidence = (evidence: EvidenceItem[], fundName: string, dailyReturn: number) => {
  const themeKeywords = getThemeKeywords(fundName).map((word) => normalize(word));
  return evidence
    .filter((item) => evidenceSupportsMove(item, dailyReturn))
    .filter((item) => themeKeywords.some((keyword) => item.text.includes(keyword)));
};

const getRelatedFundSignals = (fund: Fund | undefined, funds: Fund[]) => {
  if (!fund) return [];
  const theme = getComparableTheme(fund.name);
  if (!theme) return [];
  return funds
    .filter((item) => item.id !== fund.id)
    .map((item) => ({
      fund: item,
      theme: getComparableTheme(item.name),
      dailyReturn: getFundDailyReturn(item.positions),
    }))
    .filter((item) => item.theme && (item.theme === theme || item.theme.includes(theme) || theme.includes(item.theme)))
    .sort((a, b) => Math.abs(b.dailyReturn) - Math.abs(a.dailyReturn))
    .slice(0, 3);
};

const buildReason = (
  position: Position,
  evidence: EvidenceItem[],
  fundName: string,
  abnormalCount: number,
  dailyReturn: number
): Pick<AnomalyRow, 'reason' | 'confidence' | 'sources'> => {
  const directEvidence = evidence
    .filter((item) => matchesPositionDirectly(item, position))
    .filter((item) => evidenceSupportsMove(item, dailyReturn));
  if (directEvidence.length > 0) {
    const first = directEvidence[0];
    return {
      reason: `匹配到该公司直接${first.type}：${first.title}`,
      confidence: '高',
      sources: directEvidence.slice(0, 3),
    };
  }

  const themeEvidence = getCompatibleThemeEvidence(evidence, fundName, dailyReturn);
  if (themeEvidence.length > 0) {
    return {
      reason: '主题/板块催化',
      confidence: '中',
      sources: [],
    };
  }

  if (abnormalCount >= 2) {
    return {
      reason: `同一子集中有 ${abnormalCount} 只成分股涨跌幅超过 ${THRESHOLD}%，可能为板块情绪或资金行为。`,
      confidence: '中',
      sources: [],
    };
  }

  return {
    reason: '暂无明确公开催化，可能为板块情绪或资金行为。',
    confidence: '低',
    sources: [],
  };
};

const buildInferenceSummary = (
  fund: Fund,
  rows: AnomalyRow[],
  evidence: EvidenceItem[],
  funds: Fund[],
  fundDailyReturn: number
) => {
  const directRows = rows.filter((row) => row.confidence === '高');
  if (directRows.length > 0) {
    const names = directRows.slice(0, 3).map((row) => row.name).join('、');
    return `推理：${names}存在与自身名称/代码直接匹配、且方向基本一致的公开信息，因此今天的异动更可能包含公司事件驱动；但是否足以解释整个子集，还需要看其他成分股是否同步扩散。`;
  }

  const themeEvidence = getCompatibleThemeEvidence(evidence, fund.name, fundDailyReturn);
  if (themeEvidence.length > 0) {
    const first = themeEvidence[0];
    return `推理：没有找到异常成分股的直接公告，但新闻/公告中出现与「${fund.name}」相关的主题线索（${first.title}）。这更像板块催化或主题情绪传导，而不是单一公司原因。`;
  }

  const relatedSignals = getRelatedFundSignals(fund, funds).filter((item) => Math.abs(item.dailyReturn) >= 1);
  const sameDirection = relatedSignals.find((item) => Math.sign(item.dailyReturn) === Math.sign(fundDailyReturn));
  if (sameDirection) {
    return `推理：暂无直接新闻/公告匹配，但同主题子集「${sameDirection.fund.name}」今日${sameDirection.dailyReturn >= 0 ? '上涨' : '下跌'} ${Math.abs(sameDirection.dailyReturn).toFixed(2)}%，与本子集方向一致。更像跨市场/同产业链映射或风险偏好扩散，不能单独当作确定原因。`;
  }

  if (rows.length >= 2) {
    return `推理：该子集中有 ${rows.length} 只成分股涨跌幅超过 ${THRESHOLD}%，但暂未匹配到方向一致的公开催化。更像板块资金行为或情绪扩散，暂不应归因到某一条公告。`;
  }

  return '推理：暂无直接公司催化、主题新闻或跨市场同向映射证据。当前只能确认价格异动，原因需要继续观察后续公告、新闻和成交结构。';
};

const confidenceColor: Record<AnomalyRow['confidence'], string> = {
  高: 'red',
  中: 'orange',
  低: 'default',
};

const ActiveResearchResultView: React.FC<{ result?: ActiveResearchResult }> = ({ result }) => {
  if (!result) return null;
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Text>
        <Tag color={result.level === 'company' ? 'red' : result.level === 'theme' ? 'blue' : 'default'}>
          {result.level === 'company' ? '公司线索' : result.level === 'theme' ? '主题线索' : '未明确'}
        </Tag>
        {result.reason}
      </Text>
      {result.sources.slice(0, 3).map((source, index) => (
        <Text key={`${source.url || source.title}-${index}`} type="secondary" style={{ fontSize: 12 }}>
          {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}
          {source.source ? ` · ${source.source}` : ''}
        </Text>
      ))}
      {result.sources.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          暂未搜到明确来源{result.queries.length > 0 ? `；搜索词：${result.queries.join(' / ')}` : ''}
        </Text>
      )}
    </Space>
  );
};

const PortfolioAnomalyPanel: React.FC = () => {
  const { fundId } = useParams<{ fundId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focusCode = searchParams.get('code');
  const { funds } = useFundPortfolio();
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(true);
  const [activeResearch, setActiveResearch] = useState<Record<string, ActiveResearchResult>>({});
  const [activeResearchLoading, setActiveResearchLoading] = useState<Record<string, boolean>>({});
  const activeResearchRequestedRef = useRef<Set<string>>(new Set());

  const fund = funds.find((item) => item.id === fundId);

  useEffect(() => {
    let cancelled = false;
    setLoadingEvidence(true);
    Promise.all([
      fetchJson('/api/news/latest'),
      fetchJson('/api/research/cninfo/latest'),
      fetchJson('/api/research/earnings/latest'),
    ]).then(([news, cninfo, earnings]) => {
      if (cancelled) return;
      setEvidence([
        ...collectNewsEvidence(news),
        ...collectResearchEvidence(cninfo, '公告监控'),
        ...collectResearchEvidence(earnings, '业绩预告'),
      ]);
    }).finally(() => {
      if (!cancelled) setLoadingEvidence(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fundDailyReturn = useMemo(() => getFundDailyReturn(fund?.positions ?? []), [fund]);

  const rows = useMemo<AnomalyRow[]>(() => {
    if (!fund) return [];
    const abnormalPositions = fund.positions
      .map((position) => ({ position, dailyReturn: getDailyReturn(position) }))
      .filter((item) => Math.abs(item.dailyReturn) >= THRESHOLD);

    const abnormalCount = abnormalPositions.length;
    return abnormalPositions
      .map(({ position, dailyReturn }) => {
        const attribution = buildReason(position, evidence, fund.name, abnormalCount, dailyReturn);
        return {
          ...position,
          key: position.code,
          dailyReturn,
          direction: (dailyReturn >= 0 ? '异常上涨' : '异常下跌') as AnomalyRow['direction'],
          isFocused: focusCode === position.code,
          ...attribution,
        };
      })
      .sort((a, b) => {
        if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
        return Math.abs(b.dailyReturn) - Math.abs(a.dailyReturn);
      });
  }, [fund, evidence, focusCode]);

  const inferenceSummary = useMemo(() => {
    if (!fund) return '';
    return buildInferenceSummary(fund, rows, evidence, funds, fundDailyReturn);
  }, [fund, rows, evidence, funds, fundDailyReturn]);

  const themeEvidence = useMemo(() => {
    if (!fund) return [];
    return getCompatibleThemeEvidence(evidence, fund.name, fundDailyReturn).slice(0, 5);
  }, [evidence, fund, fundDailyReturn]);

  const topDriver = rows[0];

  const runActiveResearch = async (key: string, payload: Record<string, unknown>) => {
    if (!fund) return;
    if (activeResearchRequestedRef.current.has(key)) return;
    activeResearchRequestedRef.current.add(key);
    setActiveResearchLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const result = await postJson('/api/anomaly/research', {
        fundName: fund.name,
        market: fund.market,
        dailyReturn: fundDailyReturn,
        ...payload,
      }) as ActiveResearchResult;
      setActiveResearch((prev) => ({ ...prev, [key]: result }));
    } catch (error) {
      setActiveResearch((prev) => ({
        ...prev,
        [key]: {
          success: false,
          level: 'unknown',
          reason: error instanceof Error ? error.message : '主动搜索失败',
          confidence: '低',
          sources: [],
          queries: [],
        },
      }));
    } finally {
      setActiveResearchLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  useEffect(() => {
    if (!fund || loadingEvidence) return;

    if (rows.length > 0 && themeEvidence.length === 0) {
      runActiveResearch('theme', { mode: 'theme' });
    }

    const rowsToResearch = rows.filter((row) => row.confidence !== '高' && Math.abs(row.dailyReturn) >= THRESHOLD);
    rowsToResearch.forEach((row, index) => {
      window.setTimeout(() => {
        runActiveResearch(row.code, {
          mode: 'stock',
          stock: { code: row.code, name: row.name },
          dailyReturn: row.dailyReturn,
        });
      }, index * 600);
    });
  }, [fund, loadingEvidence, rows, themeEvidence.length]);

  if (!fund) {
    return (
      <Card>
        <Empty description="未找到对应子集">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/portfolio')}>返回子集</Button>
        </Empty>
      </Card>
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/portfolio')}>返回子集</Button>
        <Title level={4} style={{ margin: 0 }}>{fund.name} - 异动归因</Title>
      </Space>

      <Card style={{ marginBottom: 16 }}>
        <Space size="large" wrap>
          <Statistic
            title="子集今日涨跌"
            value={fundDailyReturn}
            precision={2}
            suffix="%"
            prefix={fundDailyReturn >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
            valueStyle={{ color: fundDailyReturn >= 0 ? upColor : downColor }}
          />
          <Statistic title={`涨跌幅超过 ${THRESHOLD}%`} value={rows.length} suffix="只" />
          <div>
            <Text type="secondary">Top 贡献/拖累股</Text>
            <div style={{ marginTop: 4 }}>
              {topDriver ? (
                <Text strong style={{ color: topDriver.dailyReturn >= 0 ? upColor : downColor }}>
                  {topDriver.name}（{topDriver.dailyReturn > 0 ? '+' : ''}{topDriver.dailyReturn.toFixed(2)}%）
                </Text>
              ) : (
                <Text type="secondary">暂无</Text>
              )}
            </div>
          </div>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="板块异动推理"
        description={inferenceSummary}
      />

      <Card title="主题/板块催化" style={{ marginBottom: 16 }}>
        {themeEvidence.length > 0 || activeResearch.theme ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {themeEvidence.map((source, index) => (
              <div key={`${source.type}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Tag style={{ flex: '0 0 auto' }}>{source.type}</Tag>
                <div>
                  <Text strong>
                    {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}
                  </Text>
                  {source.summary && (
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{source.summary}</Text>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {activeResearchLoading.theme && <Text type="secondary">正在自动搜索板块催化...</Text>}
            <ActiveResearchResultView result={activeResearch.theme} />
          </Space>
        ) : (
          <Text type="secondary">{activeResearchLoading.theme ? '正在自动搜索板块催化...' : '本地新闻/公告暂未匹配到主题催化。'}</Text>
        )}
      </Card>

      <Spin spinning={loadingEvidence}>
        {rows.length === 0 ? (
          <Card>
            <Empty description={`今日暂无涨跌幅超过 ${THRESHOLD}% 的成分股。`} />
          </Card>
        ) : (
          <Card>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="个股归因只使用当前公司直接匹配且方向不冲突的证据；板块或跨市场线索会明确标注为传导推理，不冒充个股公告。"
            />
            <Table
              rowKey="code"
              dataSource={rows}
              pagination={false}
              rowClassName={(record) => record.isFocused ? 'ant-table-row-selected' : ''}
              columns={[
                {
                  title: '股票',
                  key: 'stock',
                  width: 180,
                  render: (_: unknown, record: AnomalyRow) => (
                    <Space direction="vertical" size={0}>
                      <Space size={6}>
                        <Text strong>{record.name}</Text>
                        {record.isFocused && <Tag color="blue">当前点击</Tag>}
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>{record.code}</Text>
                    </Space>
                  ),
                },
                {
                  title: '今日涨跌',
                  dataIndex: 'dailyReturn',
                  width: 110,
                  align: 'right' as const,
                  render: (value: number) => (
                    <Text strong style={{ color: value >= 0 ? upColor : downColor }}>
                      {value > 0 ? '+' : ''}{value.toFixed(2)}%
                    </Text>
                  ),
                },
                {
                  title: '异动方向',
                  dataIndex: 'direction',
                  width: 110,
                  render: (value: AnomalyRow['direction']) => <Tag color={value === '异常上涨' ? 'red' : 'green'}>{value}</Tag>,
                },
                {
                  title: '可能原因',
                  dataIndex: 'reason',
                  render: (value: string, record: AnomalyRow) => (
                    <Space direction="vertical" size={4}>
                      <Text>{value}</Text>
                      {record.sources.length > 0 && record.sources.map((source, index) => (
                        <Text key={`${source.type}-${index}`} type="secondary" style={{ fontSize: 12 }}>
                          {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}
                        </Text>
                      ))}
                      {activeResearchLoading[record.code] && <Text type="secondary" style={{ fontSize: 12 }}>正在自动搜索原因...</Text>}
                      <ActiveResearchResultView result={activeResearch[record.code]} />
                    </Space>
                  ),
                },
                {
                  title: '证据来源',
                  key: 'sources',
                  width: 150,
                  render: (_: unknown, record: AnomalyRow) => (
                    <Space size={[4, 4]} wrap>
                      {record.sources.length > 0
                        ? Array.from(new Set(record.sources.map((source) => source.type))).map((type) => <Tag key={type}>{type}</Tag>)
                        : record.reason === '主题/板块催化'
                          ? <Tag color="blue">主题催化</Tag>
                          : <Tag>行情联动</Tag>}
                    </Space>
                  ),
                },
                {
                  title: '置信度',
                  dataIndex: 'confidence',
                  width: 90,
                  render: (value: AnomalyRow['confidence']) => <Tag color={confidenceColor[value]}>{value}</Tag>,
                },
              ]}
            />
          </Card>
        )}
      </Spin>
    </div>
  );
};

export default PortfolioAnomalyPanel;

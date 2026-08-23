import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFeishuClient,
  normalizeFeishuWorkbook,
} from './aiDashboardData.js';

test('Feishu adapters normalize existing AI sheets without treating percentages as ARR values', () => {
  const workbook = normalizeFeishuWorkbook({
    'ARR&估值': [
      ['ARR对比(亿美元)'],
      ['月份', 'Anthropic', '环比绝对值', '环比', 'OpenAI', null, '估值日期', 'Anthropic', 'P/ARR', 'OpenAI'],
      ['2026年5月', 500, 85, '19%', 370, null, '2026年5月', 3800, 19, 9000],
      ['2026年6月', 'Yipit：月初500+，月末预测700；实测650', 100, '33%', '390-400', null, '2026年6月', '9000-10000', 14, 10000],
      ['2026年7月', null, null, null, '月底预测：800', null, null, null, null, null],
    ],
    'API模型token价格&发布日期&优化方向': [
      ['地区', '厂商', '发布时间', '模型', '分类', '输入 $/1M', '缓存命中 $/1M', '输出 $/1M', '缓存命中率下限', '缓存命中率上限', '来源', '更新时间'],
      ['海外', 'OpenAI', '2026/06/27', 'GPT 5.6 Sol', '旗舰', 5, 0.5, 30, 20, 80, 'OpenAI', '2026-06-27'],
      [null, null, '2026/06/27', 'GPT 5.6 Terra', '均衡', 2.5, 0.25, 15, 90, 20, 'OpenAI', '2026-06-27'],
    ],
    '模型基准测试': [
      [null, null, null, 'GPT 5.6 Sol', 'GPT-5.5', 'Mythos Preview'],
      ['测试分类', '评测维度', '核心指标', 'GPT 5.6 Sol', 'GPT-5.5', 'Mythos Preview'],
      ['Coding', 'SWE-bench Pro', '修复率', '77.8%', '58.6%', '99%'],
      ['Coding', 'YC-Bench', '成本', '$2.0M', '$2.5M', '$0.1M'],
      [null, null, null],
      ['测评分类', '测评维度', '核心指标', '第1名', '第2名'],
      ['Coding', 'SWE-bench Pro', '修复率', 'GPT 5.6 Sol', 'GPT-5.5'],
    ],
    '海外算力租赁价格追踪': [
      ['平台', 'GPU', '日期', 'On-demand($/GPU/hr)', 'Preemptible($/GPU/hr)'],
      ['NBIS', 'B300', '2026-06-01', 7.9, 4.3],
      [null, 'H100', '2026-06-01', 3.85, 2.15],
    ],
    '债务融资': [
      ['公司', '日期', '手段', '规模', '币种', '点评', '来源', '更新时间'],
      ['CoreWeave', '2026年8月12日', '可转债', 2000, 'USD mn', '扩充算力', '公司公告', '2026-08-12'],
    ],
    '视频模型价格': [
      ['厂商', '模型', '生成模式', '分辨率', '时长档', 'USD/秒', '来源', '更新时间'],
      ['Google', 'Veo', '文生视频', '1080p', '8s', 0.4, 'Google', '2026-08-01'],
    ],
    'Coding Plan价格': [
      ['厂商', '套餐', '月付USD', '年付折算/月USD', '额度限制', '超量计费', '来源', '更新时间'],
      ['Anthropic', 'Max', 200, 166.67, '20x', '不可超量', 'Anthropic', '2026-08-01'],
    ],
  }, { asOf: '2026-08-20T00:00:00.000Z' });

  const anthropicActuals = workbook.arrRecords.filter((row) => row.company === 'Anthropic' && row.kind === 'actual');
  assert.deepEqual(anthropicActuals.map((row) => row.value), [500, 650]);
  assert.deepEqual(workbook.arrRecords.filter((row) => row.kind === 'forecast').map((row) => row.value), [700, 800]);
  assert.equal(workbook.arrRecords.some((row) => row.company === 'OpenAI' && row.observedAt === '2026-07-01' && row.kind === 'actual'), false);
  const juneAnthropicValuation = workbook.valuationRecords.find((row) => row.company === 'Anthropic' && row.asOf === '2026-06-01');
  assert.equal(juneAnthropicValuation.valuationLow, 9000);
  assert.equal(juneAnthropicValuation.valuationHigh, 10000);
  assert.equal(workbook.modelPrices[0].cacheRangeValid, true);
  assert.equal(workbook.modelPrices[1].cacheRangeValid, false);
  assert.equal(workbook.modelPrices[1].vendor, 'OpenAI');
  assert.equal(workbook.benchmarkModels.find((row) => row.model === 'GPT 5.6 Sol').scores['SWE-bench Pro'].value, 77.8);
  assert.equal(workbook.benchmarkModels.find((row) => row.model === 'GPT 5.6 Sol').scores['测评维度'], undefined);
  assert.equal(workbook.benchmarkModels.find((row) => row.model === 'GPT 5.6 Sol').scores['YC-Bench'].direction, 'lower');
  assert.equal(workbook.computeRental[1].platform, 'NBIS');
  assert.equal(workbook.debtFinancing[0].method, '可转债');
  assert.equal(workbook.debtFinancing[0].asOf, '2026-08-12');
  assert.equal(workbook.videoPrices[0].pricePerSecond, 0.4);
  assert.equal(workbook.codingPlans[0].monthlyPrice, 200);
});

test('Feishu adapters read the real Yipit matrix and Excel serial dates from the source workbook', () => {
  const workbook = normalizeFeishuWorkbook({
    'ARR&估值': [
      ['ARR对比(亿美金）', null, null, null, null, null, null, null, null, null, null, null, null, '估值'],
      [null, 'Anthropic', '环比绝对值', '环比', 'Claude code', 'OpenAI', null, null, null, null, null, null, null, null, 'Anthropic', 'P/ARR', 'OpenAI', 'P/ARR'],
      [46143, '月初470亿（官方口径），月底预期500-550', null, null, null, 370, null, null, null, null, null, null, null, 46143, 'h轮9650亿', null, 'IPO估值10000亿'],
      [46174, 'Yipit：月初500+，月末预测700；硅谷：650', null, null, null, '390-400', null, null, null, null, null, null, null, 46174, null, null, null],
      [null, 'Yipit'],
      [null, 'Anthropic', 'OpenAI'],
      [46172, 54, 37],
      [46187, 62, 39.5],
      [46199, 67, 42],
      [46215, 73, 45],
      [null, 80, 47],
    ],
    'API模型token价格&发布日期&优化方向': [
      ['【模型发布及优化方向】'],
      ['地区', '厂商', '发布时间', '模型', '分类', '输入 $/1M', '缓存命中 $/1M', '输出 $/1M'],
      ['海外', 'OpenAI', 46200, 'GPT 5.6 Sol', '旗舰', 5, 0.5, 30],
      ['中国', 'DeepSeek', 46136, 'DeepSeek-V4-Pro-Preview', '旗舰', 0.435, 0.003625, 0.87],
    ],
    '模型基准测试': [
      ['测试分类', '评测维度', '核心指标', 'GPT 5.6 Sol', 'DeepSeek-V4-Pro'],
      ['Coding', 'SWE-bench Pro', '修复率', 0.778, 0.554],
    ],
    '海外算力租赁价格追踪': [
      ['平台', 'GPU', '日期', 'On-demand($/GPU/hr)', 'Preemptible($/GPU/hr)'],
      ['NBIS', 'B300', 46173, 6.1, 3.4],
    ],
  }, { asOf: '2026-08-23T00:00:00.000Z' });

  assert.deepEqual(
    workbook.arrRecords.filter((row) => row.company === 'Anthropic' && row.kind === 'actual').map((row) => [row.observedAt, row.value, row.sourceLabel]),
    [
      ['2026-05-30', 540, 'Yipit'],
      ['2026-06-14', 620, 'Yipit'],
      ['2026-06-26', 670, 'Yipit'],
      ['2026-07-12', 730, 'Yipit'],
    ],
  );
  assert.deepEqual(
    workbook.arrRecords.filter((row) => row.company === 'Anthropic' && row.kind === 'forecast').map((row) => [row.observedAt, row.value]),
    [['2026-07-31', 800]],
  );
  assert.equal(workbook.arrRecords.some((row) => row.value === 650 || row.value === 80), false);
  assert.equal(workbook.arrRecords.every((row) => row.sourceLabel === 'Yipit'), true);
  assert.equal(workbook.valuationRecords[0].asOf, '2026-05-01');
  assert.equal(workbook.valuationRecords[0].valuationLow, 9650);
  assert.equal(workbook.modelPrices[0].releasedAt, '2026-06-27');
  assert.equal(workbook.benchmarkModels.find((row) => row.model === 'DeepSeek-V4-Pro').releasedAt, '2026-04-24');
  assert.equal(workbook.computeRental[0].asOf, '2026-05-31');
  assert.ok(workbook.validSheets.includes('ARR&估值'));
});

test('Feishu client discovers sheet IDs by title and batch reads named ranges with app credentials', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (String(url).includes('/sheets/query')) {
      return Response.json({ code: 0, data: { sheets: [
        { sheet_id: 'arr-id', title: 'ARR&估值' },
        { sheet_id: 'debt-id', title: '债务融资' },
      ] } });
    }
    return Response.json({ code: 0, data: { valueRanges: [
      { range: 'arr-id!A1:ZZ1000', values: [['ARR']] },
      { range: 'debt-id!A1:ZZ1000', values: [['债务']] },
    ] } });
  };
  const client = createFeishuClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    spreadsheetToken: 'sheet-token',
    fetchImpl,
  });

  const workbook = await client.readWorkbook(['ARR&估值', '债务融资']);

  assert.deepEqual(workbook, { 'ARR&估值': [['ARR']], '债务融资': [['债务']] });
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /ranges=arr-id%21A1%3AZZ1000%2Cdebt-id%21A1%3AZZ1000/);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer tenant-token');
});

from extract_financials import _tokens, extract_financial_metrics


SAMPLE = """
主要会计数据和财务指标
单位：元
营业收入 12,345,678,900.00 10,000,000,000.00 23.46%
归属于上市公司股东的净利润 1,234,567,890.00 1,000,000,000.00 23.46%
归属于上市公司股东的扣除非经常性损益的净利润 1,100,000,000.00 900,000,000.00 22.22%
经营活动产生的现金流量净额 (500,000,000.00) 300,000,000.00 -266.67%
基本每股收益 1.25 1.02 22.55%
加权平均净资产收益率 12.50% 10.00% 2.50个百分点
"""


def test_extracts_core_metrics_and_converts_to_yi():
    result = extract_financial_metrics(SAMPLE)
    assert result["营业收入亿元"] == 123.4568
    assert result["营业收入同比%"] == 23.46
    assert result["归母净利润亿元"] == 12.3457
    assert result["扣非净利润亿元"] == 11.0
    assert result["经营现金流亿元"] == -5.0
    assert result["基本每股收益元"] == 1.25
    assert result["加权ROE%"] == 12.5
    assert result["指标覆盖数"] == 4


def test_uses_wan_yuan_context():
    result = extract_financial_metrics("单位：万元\n营业收入 120000 100000 20.0%")
    assert result["营业收入亿元"] == 12.0
    assert result["营业收入同比%"] == 20.0


def test_missing_values_remain_none_not_zero():
    result = extract_financial_metrics("本报告不含目标财务表")
    assert result["营业收入亿元"] is None
    assert result["归母净利润亿元"] is None
    assert result["指标覆盖数"] == 0


def test_handles_metric_label_wrapped_across_lines():
    text = """
单位：元
归属于上市公司股东的净利润（元） 232,342,843.01 63,382,376.16 266.57%
归属于上市公司股东的扣除非经常性
损益的净利润（元） 217,030,774.07 44,215,093.71 390.85%
"""
    result = extract_financial_metrics(text)
    assert result["归母净利润亿元"] == 2.3234
    assert result["扣非净利润亿元"] == 2.1703
    assert result["扣非净利润同比%"] == 390.85


def test_q3_uses_year_to_date_columns_and_keeps_not_applicable_yoy_blank():
    text = """
单位：元 币种：人民币
项目 本报告期 本报告期比上年同期增减变动幅度(%) 年初至报告期末 年初至报告期末比上年同期增减变动幅度(%)
营业收入 181,845,381.55 -16.45 509,508,363.22 -14.19
归属于上市公司股东的净利
润 -36,128,235.45 不适用 -109,252,544.99 不适用
归属于上市公司股东的扣除
非经常性损益的净利润 -23,039,741.75 不适用 -90,774,609.04 不适用
经营活动产生的现金流量净 -23,737,647.18 不适用 -144,105,064.27 不适用
额
基本每股收益（元/股） -0.056609 不适用 -0.171187 不适用
加权平均净资产收益率（%） -2.56297 不适用 -7.75047 不适用
"""
    result = extract_financial_metrics(text, report_type="第三季度报告")
    assert result["营业收入亿元"] == 5.0951
    assert result["营业收入同比%"] == -14.19
    assert result["归母净利润亿元"] == -1.0925
    assert result["归母净利润同比%"] is None
    assert result["扣非净利润亿元"] == -0.9077
    assert result["经营现金流亿元"] == -1.4411
    assert result["基本每股收益元"] == -0.1712
    assert result["加权ROE%"] == -7.7505


def test_extracts_wrapped_english_annual_report_metrics():
    text = """
VI. Key accounting data and financial indicators
2025 2024 Increase/decrease 2023
Operating income (yuan) 106,856,298,720.47 103,062,962,254.34 3.68% 141,703,248,931.32
Net profit attributable to
shareholders of the listed
company (yuan)
-1,784,352,202.18 473,599,068.10 -476.76% 249,195,333.87
Net profit attributable to
shareholders of the listed -1,473,654,768.30 614,433,937.76 -339.84% -4,608,338,751.75
Full text of the 2025 Annual Report of New Hope Liuhe Co., Ltd.
19
company after deducting
non-recurring gains and
losses (yuan)
Net cash flows from
operating activities
(yuan)
9,377,940,842.22 9,126,553,532.87 2.75% 13,904,015,800.54
Basic earnings per share
(yuan/share) -0.41 0.09 -555.56% 0.04
Weighted average ROE -8.85% 1.73% A drop of 10.58 percentage points 0.71%
"""
    result = extract_financial_metrics(text, report_type="年度报告")
    assert result["营业收入亿元"] == 1068.563
    assert result["营业收入同比%"] == 3.68
    assert result["归母净利润亿元"] == -17.8435
    assert result["归母净利润同比%"] == -476.76
    assert result["扣非净利润亿元"] == -14.7365
    assert result["扣非净利润同比%"] == -339.84
    assert result["经营现金流亿元"] == 93.7794
    assert result["经营现金流同比%"] == 2.75
    assert result["基本每股收益元"] == -0.41
    assert result["加权ROE%"] == -8.85
    assert result["指标覆盖数"] == 4


def test_converts_english_money_units_to_yi():
    result = extract_financial_metrics(
        "Unit: RMB million\nOperating income 12,345.67 10,000.00 23.46%",
        report_type="年度报告",
    )
    assert result["营业收入亿元"] == 123.4567
    assert result["营业收入同比%"] == 23.46


def test_reconstructs_wrapped_numbers_and_standalone_minus_with_explicit_yoy():
    text = """
单位：元
2023 年 2022年 本年比上年增减 2021年
调整前 调整后 调整后 调整前 调整后
营业收入（元）
4,547,810,68
0.92
6,059,335,68
0.68
6,059,335,68
0.68 -24.95% 5,572,424,94
6.92
5,572,424,94
6.92
归属于上市公司股东的净利润（元）
-
127,833,708.
40
-
130,853,424.
01
-
129,621,779.
10
1.38% 82,058,400.4
7
82,058,400.4
7
归属于上市公司股东的扣除非经常性损益的净利润（元）
-
131,498,256.
13
-
134,444,327.
01
-
133,212,682.
10
1.29% 70,177,062.2
2
70,177,062.2
2
经营活动产生的现金流量净额（元）
246,804,136.
31
435,473,652.
17
435,473,652.
17 -43.33% 61,218,330.5
4
61,218,330.5
4
基本每股收益（元/股） -0.25 -0.25 -0.25 0.00% 0.1600 0.1600
"""
    result = extract_financial_metrics(text, report_type="年度报告")
    assert result["营业收入亿元"] == 45.4781
    assert result["营业收入同比%"] == -24.95
    assert result["归母净利润亿元"] == -1.2783
    assert result["归母净利润同比%"] == 1.38
    assert result["扣非净利润亿元"] == -1.315
    assert result["扣非净利润同比%"] == 1.29
    assert result["经营现金流亿元"] == 2.468
    assert result["经营现金流同比%"] == -43.33


def test_uses_header_column_for_wrapped_plain_yoy_values():
    text = """
单位：元 币种：人民币
主要会计数据 2025年
2024年 本期比上年同期增减 (%) 2023年
调整后 调整前
营业收入 1,848,999,4
24.43
2,986,25
7,948.06
2,838,27
8,460.69 -38.08 2,958,577,1
94.90
归属于上市公司股东的净利润
-
188,323,14
0.35
100,684,
869.87
94,769,2
26.58 -287.04 153,984,18
9.58
归属于上市公司股东的扣除非经常性损益的净利润
-
315,576,51
9.90
81,477,5
63.45
81,477,5
63.45 -487.32 161,372,04
3.32
经营活动产生的现金流量净额
-
387,794,57
9.76
207,460,
063.29
236,431,
459.44 -286.92
-
597,461,87
4.41
基本每股收益（元／股） -0.83 0.44 0.48 -288.64 0.76
"""
    result = extract_financial_metrics(text, report_type="年度报告")
    assert result["营业收入亿元"] == 18.49
    assert result["营业收入同比%"] == -38.08
    assert result["归母净利润亿元"] == -1.8832
    assert result["归母净利润同比%"] == -287.04
    assert result["扣非净利润亿元"] == -3.1558
    assert result["扣非净利润同比%"] == -487.32
    assert result["经营现金流亿元"] == -3.8779
    assert result["经营现金流同比%"] == -286.92


def test_rejects_partial_tokens_and_leaves_ambiguous_wrapped_amount_blank():
    assert _tokens("1,848,999,4") == []
    assert _tokens("127,833,708.") == []
    result = extract_financial_metrics(
        "单位：元\n营业收入\n1,234,56\n12.34\n下一项目",
        report_type="年度报告",
    )
    assert result["营业收入亿元"] is None
    assert result["营业收入同比%"] is None


def test_only_derives_yoy_from_exactly_two_unambiguous_amounts():
    two_values = extract_financial_metrics("单位：元\n营业收入 300000000 200000000")
    assert two_values["营业收入同比%"] == 50.0

    three_values = extract_financial_metrics("单位：元\n营业收入 300000000 200000000 100000000")
    assert three_values["营业收入亿元"] == 3.0
    assert three_values["营业收入同比%"] is None

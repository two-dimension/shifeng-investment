#!/usr/bin/env python3
"""
cninfo 公告抓取客户端
====================
- 单/多日范围拉取(支持 T-3~T-1 这种跨自然日的范围)
- 翻页抓全(sse + szse 双 column)
- 频率控制:每页 0.5s,column 之间 1s,失败指数退避重试 5 次
- 输出 raw 公告 JSON(announcements_*.json)

API:POST http://www.cninfo.com.cn/new/hisAnnouncement/query
字段:seDate=START~END,column=sse|szse,pageNum,pageSize=30
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

BASE_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'
HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': '*/*',
    'Origin': 'http://www.cninfo.com.cn',
    'Referer': 'http://www.cninfo.com.cn/',
}
PAGE_SIZE = 30
RETRY_MAX = 5
COLUMNS = ['sse', 'szse']


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", file=sys.stderr)


def _fetch_page(page: int, column: str, se_date: str) -> Optional[Dict]:
    """单页拉取,失败指数退避重试 RETRY_MAX 次"""
    data = {
        'pageNum': str(page),
        'pageSize': str(PAGE_SIZE),
        'column': column,
        'tabName': 'fulltext',
        'plate': '',
        'stock': '',
        'searchkey': '',
        'secid': '',
        'category': '',
        'trade': '',
        'seDate': se_date,
        'sortName': '',
        'sortType': '',
        'isHLtitle': 'true',
    }
    req = urllib.request.Request(
        BASE_URL,
        data=urllib.parse.urlencode(data).encode('utf-8'),
        headers=HEADERS,
    )
    for attempt in range(RETRY_MAX):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            wait = 5 * (attempt + 1)
            _log(f"  retry {attempt + 1}/{RETRY_MAX} after {wait}s: {e}")
            time.sleep(wait)
    return None


def _first_page_signature(data: Dict):
    """识别 cninfo 忽略 column 参数后返回的同一条公告流。"""
    announcements = data.get('announcements') or []
    announcement_ids = tuple(a.get('announcementId') for a in announcements)
    if not announcement_ids or any(not aid for aid in announcement_ids):
        return None
    return data.get('totalAnnouncement') or 0, announcement_ids


def fetch_range(
    start_date: str,
    end_date: Optional[str] = None,
    columns: Optional[List[str]] = None,
) -> Dict:
    """
    抓取 [start_date, end_date] 区间的所有 cninfo 公告 (v4: 按 seDate 拉)

    Args:
        start_date: 起始日 YYYY-MM-DD (cninfo seDate)
        end_date:   结束日 YYYY-MM-DD(默认等于 start_date)
        columns:    ['sse','szse'](默认)

    业务背景 (v4):
    - 跑批当日 seDate 单日拉取, 不做毫秒过滤
    - 7am 跑批时拿的是 cninfo 公告日期=今天 的全量 (0:00~7:00 之间发布的)
    - 不管 announcementTime 实际发件时间是 T-1 盘后还是 T 盘前
    """
    if end_date is None:
        end_date = start_date
    se_date = f"{start_date}~{end_date}"
    columns = columns or COLUMNS

    all_anns: List[Dict] = []
    col_meta: Dict[str, Dict] = {}
    is_complete = True
    unique_feeds = []
    first_page_feeds = {}

    # 先紧挨着探测两个 column 的第一页。cninfo 当前有时会忽略 column，
    # 给 sse/szse 返回完全相同的全市场公告；这种情况只翻页一次。
    for col in columns:
        d = _fetch_page(1, col, se_date)
        if not d:
            _log(f"WARN {col} 第一次拉取失败,该 column 数据缺失")
            col_meta[col] = {'error': True, 'count': 0}
            is_complete = False
            continue
        total = d.get('totalAnnouncement') or 0
        pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
        _log(f"  {col} | {se_date} | total={total} pages={pages}")
        signature = _first_page_signature(d)
        duplicate_of = first_page_feeds.get(signature) if signature else None
        if duplicate_of:
            col_meta[col] = {
                'total': total,
                'pages': pages,
                'count': 0,
                'skipped_duplicate': True,
                'duplicate_of': duplicate_of,
            }
            _log(f"  {col} 与 {duplicate_of} 首页及总数相同,跳过重复翻页")
            continue

        col_meta[col] = {'total': total, 'pages': pages, 'count': 0}
        if signature:
            first_page_feeds[signature] = col
        unique_feeds.append((col, d, pages))

    for col, first_page, pages in unique_feeds:
        d = first_page

        for p in range(1, pages + 1):
            if p > 1:
                d = _fetch_page(p, col, se_date)
            if d and d.get('announcements'):
                all_anns.extend(d['announcements'])
                col_meta[col]['count'] += len(d['announcements'])
            if p % 5 == 0:
                _log(f"    fetched page {p}/{pages}")
            time.sleep(0.5)
        time.sleep(1)

    # 去重
    seen = set()
    unique: List[Dict] = []
    for a in all_anns:
        aid = a.get('announcementId')
        if aid and aid not in seen:
            seen.add(aid)
            unique.append(a)

    _log(f"OK 抓取完成: {len(unique)} 条 (raw {len(all_anns)} 条,去重 {len(all_anns) - len(unique)})")

    return {
        'start_date': start_date,
        'end_date': end_date,
        'se_date': se_date,
        'total': len(unique),
        'is_complete': is_complete,
        'columns': col_meta,
        'announcements': unique,
    }


def save_raw(data: Dict, out_path: Path) -> Path:
    """把 fetch_range 的结果写到 JSON 文件"""
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    _log(f"OK saved: {out_path}")
    return out_path


def load_raw(raw_path: Path) -> Dict:
    """读 raw JSON(支持 'announcements' key 在顶层,或 fetch_range 嵌套)"""
    with open(raw_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # 兼容旧格式(announcements_24h.json 用 'window_start'/'window_end')
    if 'announcements' in data and isinstance(data['announcements'], list):
        return data
    raise ValueError(f"无法识别的 raw JSON 格式: {raw_path}")


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--start', required=True, help='起始日 YYYY-MM-DD')
    p.add_argument('--end', help='结束日 YYYY-MM-DD(默认=start)')
    p.add_argument('--out', help='输出 JSON 路径(默认=announcements_<start>_<end>.json)')
    args = p.parse_args()

    out = Path(args.out) if args.out else Path(f"announcements_{args.start}_{args.end or args.start}.json")
    data = fetch_range(args.start, args.end)
    save_raw(data, out)
    print(f"Done: {data['total']} announcements -> {out}")

"""올림픽공원 공연정보의 자유서식 '공연시간(tm)' 텍스트를 날짜별 공연 시작시각으로 변환한다.

공연정보(한국체육산업개발 '올림픽공원 공연정보')의 공연시간 항목은 아래처럼 서식이 제각각이다.
  - "2026년 11월 27일(금) 오후 7시 2026년 11월 28일(토) 오후 6시"
  - "금 오후 7시 / 토 오후 6시 / 일 오후 5시"
  - "(토) 18:00 / (일) 17:00", "10(금) 19:00 / 11(토) 18:00"
  - "수목금 19시 30분 / 토 15시, 19시 / 일 14시"
  - "평일(수목금) 11:00 / 주말,공휴일 11:00, 14:00, 16:30 / 월,화 공연없음"
  - "2026.12.18. FRI 7PM / 12.19 SAT 6PM / 12.20 SUN 5PM(KST)"
혼잡 예측에는 '그 날 몇 시에 공연이 시작하는가'가 필요하므로, 텍스트를 토큰(날짜/요일/시각/공연없음)으로
분해한 뒤 순서대로 읽어 날짜별·요일별 시작시각 표를 만든다.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

WEEKDAY_KO = "월화수목금토일"
WEEKDAY_EN = {"MON": 0, "TUE": 1, "WED": 2, "THU": 3, "FRI": 4, "SAT": 5, "SUN": 6}
HOLIDAY = 7  # 공휴일은 요일표에서 7로 표기(일요일처럼 취급)

_FULLWIDTH = str.maketrans({"：": ":", "（": "(", "）": ")", "／": "/", "～": "~", "，": ",", "．": "."})


def _clean(text: str) -> str:
    text = (text or "").translate(_FULLWIDTH)
    text = re.sub(r"[​‌‍﻿]", "", text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"(?<=\d);(?=\d{2})", ":", text)  # '19;00' 오타 보정
    return text


def _to_minutes(hour: int, minute: int, ampm: str | None) -> int | None:
    if ampm in ("오후", "PM"):
        if hour < 12:
            hour += 12
    elif ampm in ("오전", "AM"):
        if hour == 12:
            hour = 0
    else:
        # 오전/오후 표기가 없으면: 1~9시는 저녁 공연으로 본다(예: '6시' → 18시). 10·11·12시는 그대로.
        if 1 <= hour <= 9:
            hour += 12
    if not (0 <= hour <= 26 and 0 <= minute < 60):
        return None
    return hour * 60 + minute


# 토큰 정규식(우선순위 순). 날짜를 먼저 소비해야 '27일'의 '일'이 요일로 오인되지 않는다.
_PATTERNS = [
    ("date_full", re.compile(r"(20\d{2})\s*[.년\-/]\s*(\d{1,2})\s*[.월\-/]\s*(\d{1,2})\s*일?\.?")),
    ("date_md", re.compile(r"(?<![\d.])(\d{1,2})\s*월\s*(\d{1,2})\s*일?")),
    ("date_md_dot", re.compile(r"(?<![\d.:])(\d{1,2})\s*[./]\s*(\d{1,2})\.?(?=\s*\(|\s+(?:MON|TUE|WED|THU|FRI|SAT|SUN)\b)", re.I)),
    ("date_d", re.compile(r"(?<![\d.:/])(\d{1,2})\s*일?\s*(?=\(\s*[월화수목금토일])")),
    ("time_range", re.compile(r"(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})")),
    ("time_en", re.compile(r"(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)", re.I)),
    # '18:00시' 같은 혼용 표기에서 '00시'가 따로 잡히지 않도록 콜론 표기를 '시' 표기보다 먼저 소비한다.
    ("time_colon", re.compile(r"(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?")),
    ("time_ko", re.compile(r"(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?(?!간)")),
    ("none", re.compile(r"공연\s*없음|휴관|휴연|공연\s*없|쉼")),
    ("wd_word", re.compile(r"평일|주말|공휴일|[월화수목금토일]요일")),
    ("wd_en", re.compile(r"\b(MON|TUE|WED|THU|FRI|SAT|SUN)(?:DAY)?\b", re.I)),
    ("wd_ko", re.compile(r"(?<![가-힣0-9])([월화수목금토일](?:\s*[,·]?\s*[월화수목금토일])*)(?![가-힣])")),
]


def _tokenize(text: str):
    """텍스트에서 겹치지 않는 토큰들을 위치순으로 추출."""
    taken = [False] * len(text)
    tokens = []
    for kind, pat in _PATTERNS:
        for m in pat.finditer(text):
            s, e = m.span()
            if s == e or any(taken[s:e]):
                continue
            for i in range(s, e):
                taken[i] = True
            tokens.append((s, e, kind, m))
    tokens.sort(key=lambda t: t[0])
    return tokens


def _weekday_set(kind: str, m: re.Match) -> set[int]:
    if kind == "wd_en":
        return {WEEKDAY_EN[m.group(1).upper()[:3]]}
    word = m.group(0)
    if kind == "wd_word":
        if word == "평일":
            return {0, 1, 2, 3, 4}
        if word == "주말":
            return {5, 6}
        if word == "공휴일":
            return {HOLIDAY}
        return {WEEKDAY_KO.index(word[0])}
    return {WEEKDAY_KO.index(ch) for ch in word if ch in WEEKDAY_KO}


def _resolve_md(month: int, day: int, begin: date, end: date) -> date | None:
    for year in (begin.year, end.year, begin.year + 1):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if begin - timedelta(days=1) <= d <= end + timedelta(days=1):
            return d
    try:
        return date(begin.year, month, day)
    except ValueError:
        return None


def parse_show_times(tm: str, begin: date, end: date, holidays: set[date] | None = None):
    """날짜별 공연 시작시각(분 단위, 0시 기준) 목록과 파싱 방식을 돌려준다.

    반환: (schedule, method)
      schedule: {date: [start_min, ...]}  — 공연이 없는 날은 빈 목록
      method:   'explicit' | 'weekday' | 'global' | 'default'
    """
    holidays = holidays or set()
    text = _clean(tm)
    tokens = _tokenize(text)

    by_date: dict[date, list[int]] = {}
    by_wd: dict[int, list[int]] = {}
    global_times: list[int] = []
    end_minutes: list[int] = []

    pend_dates: list[date] = []
    pend_wds: set[int] = set()
    after_time = False
    prev_kind = None
    prev_end = -1

    def flush_reset():
        nonlocal pend_dates, pend_wds, after_time
        pend_dates, pend_wds, after_time = [], set(), False

    for (s, e, kind, m) in tokens:
        gap = text[prev_end:s] if prev_end >= 0 else ""
        if kind.startswith("date"):
            if after_time:
                flush_reset()
            if kind == "date_full":
                try:
                    d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                except ValueError:
                    d = None
            elif kind in ("date_md", "date_md_dot"):
                d = _resolve_md(int(m.group(1)), int(m.group(2)), begin, end)
            else:  # date_d: 일자만 표기 → 시작월 기준
                day = int(m.group(1))
                d = None
                cur = begin
                while cur <= end:
                    if cur.day == day:
                        d = cur
                        break
                    cur += timedelta(days=1)
            if d:
                pend_dates.append(d)
        elif kind in ("wd_ko", "wd_word", "wd_en"):
            # 날짜 바로 뒤 괄호 속 요일 '(토)' 은 날짜의 주석일 뿐이다.
            if prev_kind and prev_kind.startswith("date") and re.fullmatch(r"\s*\(?\s*", gap):
                prev_kind = "date_annot"
                prev_end = e
                continue
            if after_time:
                flush_reset()
            pend_wds |= _weekday_set(kind, m)
        elif kind == "none":
            for w in pend_wds:
                by_wd[w] = []
            for d in pend_dates:
                by_date[d] = []
            flush_reset()
        else:  # 시각
            if kind == "time_range":
                start = _to_minutes(int(m.group(1)), int(m.group(2)), "PM" if int(m.group(1)) < 10 else None)
                fin = _to_minutes(int(m.group(3)), int(m.group(4)), None)
                if fin is not None:
                    end_minutes.append(fin)
            elif kind == "time_ko":
                start = _to_minutes(int(m.group(2)), int(m.group(3) or 0), m.group(1))
            elif kind == "time_en":
                start = _to_minutes(int(m.group(1)), int(m.group(2) or 0), m.group(3).upper())
            else:  # time_colon
                start = _to_minutes(int(m.group(2)), int(m.group(3)), m.group(1))
            if start is None:
                prev_kind, prev_end = kind, e
                continue
            if pend_wds:
                for w in pend_wds:
                    lst = by_wd.setdefault(w, [])
                    if start not in lst:
                        lst.append(start)
            elif pend_dates:
                for d in pend_dates:
                    lst = by_date.setdefault(d, [])
                    if start not in lst:
                        lst.append(start)
            else:
                if start not in global_times:
                    global_times.append(start)
            after_time = True
        prev_kind, prev_end = kind, e

    schedule: dict[date, list[int]] = {}
    methods = set()
    cur = begin
    while cur <= end:
        wd = HOLIDAY if (cur in holidays and HOLIDAY in by_wd) else cur.weekday()
        if cur in by_date:
            schedule[cur] = sorted(by_date[cur]); methods.add("explicit")
        elif wd in by_wd:
            schedule[cur] = sorted(by_wd[wd]); methods.add("weekday")
        elif by_wd and cur.weekday() in (5, 6) and HOLIDAY in by_wd:
            schedule[cur] = sorted(by_wd[HOLIDAY]); methods.add("weekday")
        elif global_times:
            schedule[cur] = sorted(global_times); methods.add("global")
        elif by_date or by_wd:
            # 다른 날짜·요일은 명시돼 있는데 이 날은 언급이 없음 → 공연 없는 날로 본다.
            schedule[cur] = []
        else:
            schedule[cur] = None  # 정보 없음 → 호출측 기본값 사용
            methods.add("default")
        cur += timedelta(days=1)
    method = "explicit" if "explicit" in methods else ("weekday" if "weekday" in methods else ("global" if "global" in methods else "default"))
    return schedule, method, (max(end_minutes) if end_minutes else None)


def parse_duration_minutes(nd_tm: str | None) -> int | None:
    if not nd_tm:
        return None
    t = _clean(nd_tm)
    m = re.search(r"(\d{2,3})\s*분", t)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d)\s*시간\s*(?:(\d{1,2})\s*분)?", t)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2) or 0)
    return None


if __name__ == "__main__":
    samples = [
        ("2026년 11월 27일(금) 오후 7시 2026년 11월 28일(토) 오후 6시 2026년 11월 29일(일) 오후 5시", "2026-11-27", "2026-11-29"),
        ("금 오후 7시 / 토 오후 6시 / 일 오후 5시", "2026-11-06", "2026-11-08"),
        ("(토) 18:00 / (일) 17:00", "2024-02-24", "2024-02-25"),
        ("수목금 19시 30분 / 토 15시, 19시 / 일 14시 (일자별 공연 시간 변동 있으며, 상세페이지 참고 부탁드립니다. )", "2026-11-28", "2026-12-06"),
        ("평일(수목금) 11:00 / 주말,공휴일 11:00, 14:00, 16:30 / 월,화 공연없음", "2023-06-02", "2023-06-08"),
        ("2026.12.18. FRI 7PM / 12.19 SAT 6PM / 12.20 SUN 5PM(KST)", "2026-12-18", "2026-12-20"),
        ("12.24(목) 8PM 12.25(금) 5PM 12.26(토) 6PM", "2026-12-24", "2026-12-26"),
        ("2026년 1월 10일(토)-11일(일) / 토 6PM, 일 5PM", "2026-01-10", "2026-01-11"),
        ("10(금) 19:00 / 11(토) 18:00 / 12(일) 17:00", "2023-03-10", "2023-03-12"),
        ("2026년 12월 31일(목) 9:00:00PM(KST) 2027년 1월 1일(금) 07:00:00PM(KST)", "2026-12-31", "2027-01-01"),
        ("토요일 : 14:00 ~ 22:30 / 일요일 : 14:00 ~ 21:30", "2026-06-20", "2026-06-21"),
        ("8월 8일(토) ~8월 9일(일) 오후 7시", "2026-08-08", "2026-08-09"),
        ("2025년 9월 26일(금) ~ 9월 28일(일)  금 오후 7시 / 토 오후 6시 / 일 오후 4시", "2025-09-26", "2025-09-28"),
        ("18시", "2026-02-15", "2026-02-15"),
    ]
    for tm, b, e in samples:
        sch, method, fin = parse_show_times(tm, date.fromisoformat(b), date.fromisoformat(e))
        pretty = {d.isoformat(): [f"{x // 60:02d}:{x % 60:02d}" for x in (v or [])] if v is not None else None for d, v in sch.items()}
        print(method, pretty, fin)

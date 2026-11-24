"""올팍캐스트 혼잡 예보 모델 학습 및 웹 서비스용 데이터 생성.

입력(공공데이터)
  data/raw/parking_inout_2024-07.csv  올림픽공원 입출차 정보 (215,528건, 2024-07)
  data/raw/parking_monthly.csv        월별주차현황 (2023~2025)
  data/raw/parking_congestion.csv     주차장 혼잡도 정보 (구역별 혼잡 기록)
  data/events/events.json             올림픽공원 공연정보 (fetch_events.py)

출력(웹 서비스가 읽는 정적 JSON)
  site/data/model.json     시간대별 기본 패턴, 공연 영향 계수, 월별 계수, 공연장·주차장 정보, 검증 결과
  site/data/events.json    예정 공연 일정(날짜별 시작시각·관객 유형)
  site/data/insights.json  데이터 분석 결과(그래프용)

모델 개요
  주차장(동2·남2·북2문, 2,200면) 30분 단위 점유대수
    = 요일유형별 기본 패턴(평일/토/일·공휴일) × 계절 계수
    + Σ 공연 영향 [좌석수 × 관객유형 계수 × 도착·체류·퇴장 곡선]
  관객유형 계수와 기본 패턴은 2024년 7월 입출차 기록으로 최소제곱 추정하고,
  곡선 모양(도착 시작 시점, 퇴장 소요시간 등)은 날짜 단위 교차검증(leave-one-day-out)으로 고른다.
"""
from __future__ import annotations

import itertools
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from event_parser import parse_duration_minutes, parse_show_times  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
EVENTS_JSON = ROOT / "data" / "events" / "events.json"
TAGS_JSON = Path(__file__).resolve().parent / "audience_tags.json"
OUT = ROOT / "site" / "data"
KST = timezone(timedelta(hours=9))

SLOT_MIN = 30
NSLOT = 24 * 60 // SLOT_MIN
CAPACITY = 2200  # 동2·남2·북2문 주차장 수용대수(한국체육산업개발 '주차장 예상 이용률 서비스' 표기)
TRAIN_FROM, TRAIN_TO = date(2024, 7, 2), date(2024, 7, 31)  # 7/1은 6월 입차 차량이 빠져 있어 제외
DAY_TYPES = ["weekday", "saturday", "sunday"]
LEVELS = [  # KSPO 주차장 예상 이용률 서비스와 같은 기준
    {"key": "free", "label": "여유", "min": 0.0},
    {"key": "normal", "label": "보통", "min": 0.5},
    {"key": "busy", "label": "혼잡", "min": 0.7},
    {"key": "full", "label": "만차 위험", "min": 0.9},
]

# 공휴일(요일유형 판정용). 2024-07은 공휴일 없음.
HOLIDAYS = {
    "2024-08-15", "2024-09-16", "2024-09-17", "2024-09-18", "2024-10-01", "2024-10-03", "2024-10-09", "2024-12-25",
    "2025-01-01", "2025-01-27", "2025-01-28", "2025-01-29", "2025-01-30", "2025-03-01", "2025-03-03", "2025-05-05",
    "2025-05-06", "2025-06-03", "2025-06-06", "2025-08-15", "2025-10-03", "2025-10-05", "2025-10-06", "2025-10-07",
    "2025-10-08", "2025-10-09", "2025-12-25",
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-03-02", "2026-05-05", "2026-05-24",
    "2026-05-25", "2026-06-03", "2026-06-06", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26",
    "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25",
    "2027-01-01", "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08", "2027-03-01", "2027-05-05", "2027-06-06",
}
HOLIDAY_DATES = {date.fromisoformat(d) for d in HOLIDAYS}

# 공연장 정보: 좌석수는 올림픽공원 누리집 공연장 안내, 가까운 주차장·출입문은 주차 안내 페이지 기준
VENUES = {
    "KSPO DOME": {"seats": 15000, "label": "KSPO DOME(올림픽체조경기장)", "lots": ["P5", "P4"], "gates": ["북2문", "동2문"]},
    "티켓링크 라이브 아레나": {"seats": 5003, "label": "티켓링크 라이브 아레나(핸드볼경기장)", "lots": ["P6"], "gates": ["남2문", "동2문"]},
    "올림픽홀": {"seats": 3000, "label": "올림픽홀", "lots": ["P2"], "gates": ["동2문"]},
    "우리금융아트홀": {"seats": 1184, "label": "우리금융아트홀(올림픽역도경기장)", "lots": ["P7"], "gates": ["남2문"]},
    "뮤즈라이브": {"seats": 237, "label": "뮤즈라이브", "lots": ["P2"], "gates": ["동2문"]},
    "88잔디마당": {"seats": 15000, "label": "88잔디마당(야외)", "lots": ["P1B", "P2", "P3"], "gates": ["동2문"]},
    "88호수수변무대": {"seats": 3000, "label": "88호수수변무대(야외)", "lots": ["P4", "P5"], "gates": ["북2문"]},
    "기타": {"seats": 1000, "label": "올림픽공원 내 기타 시설", "lots": ["P1A", "P1B"], "gates": ["동2문", "남2문"]},
}
VENUE_RULES = [
    ("KSPO DOME", r"KSPO|체조"),
    ("티켓링크 라이브 아레나", r"핸드볼|티켓링크"),
    ("올림픽홀", r"올림픽홀"),
    ("우리금융아트홀", r"우리금융"),
    ("뮤즈라이브", r"뮤즈라이브"),
    ("88잔디마당", r"88\s*잔디"),
    ("88호수수변무대", r"수변무대"),
]

# 주차구역 정보(올림픽공원 누리집 '주차 안내'의 출입문별 주차구역·가능 주차대수)
LOTS = {
    "P1A": {"gate": "남2문", "near": ["K-아트홀", "우리금융아트홀", "벨로드롬"]},
    "P1B": {"gate": "동2문", "near": ["K-아트홀", "88잔디마당", "장미광장"]},
    "P2": {"gate": "동2문", "near": ["올림픽홀", "뮤즈라이브", "만남의 광장"]},
    "P3": {"gate": "동2문", "near": ["88잔디마당", "한얼광장"]},
    "P4": {"gate": "북2문", "near": ["올림픽수영장", "88호수수변무대"]},
    "P5": {"gate": "북2문", "near": ["KSPO DOME"]},
    "P6": {"gate": "남2문", "near": ["티켓링크 라이브 아레나"]},
    "P7": {"gate": "남2문", "near": ["우리금융아트홀"]},
    "P11": {"gate": "동2문", "near": ["올림픽테니스경기장"]},
}
LOT_SPACES = {"P1": 562, "P2": 320, "P4": 117, "P5": 176, "P6": 167, "P7": 137, "P11": 190}

KEYWORDS_A = r"트로트|디너쇼|가요제|효도|\d{2}\s*주년"
KEYWORDS_FAMILY = r"가족|어린이|키즈|아기상어|핑크퐁|티니핑|하츄핑|뽀로로|타요|콩순이"
KEYWORDS_B = r"WORLD\s*TOUR|ASIA\s*TOUR|FAN\s*-?\s*CON|FAN\s*-?\s*MEETING|FANMEETING|팬미팅|SHOWCASE|쇼케이스|K-?POP|KCON|아이돌|IN\s+SEOUL"


# ---------------------------------------------------------------- 공연 일정

def normalize_venue(plc: str) -> str:
    found = [name for name, pat in VENUE_RULES if re.search(pat, plc or "", re.I)]
    if not found:
        return "기타"
    return max(found, key=lambda n: VENUES[n]["seats"])


def classify(ev: dict, tags: dict) -> tuple[str, str, str]:
    tag = tags.get(str(ev["evtSeq"]))
    if tag:
        return tag["class"], "검수", tag.get("note", "")
    title = ev.get("title") or ""
    age = ev.get("seeAge") or ""
    if re.search(KEYWORDS_FAMILY, title) or re.search(r"(24|36)\s*개월", age):
        return "C", "자동", "가족·어린이 공연"
    if re.search(KEYWORDS_A, title):
        return "A", "자동", "중장년 팬층 공연 키워드"
    letters = re.findall(r"[A-Za-z]", title)
    hangul = re.findall(r"[가-힣]", title)
    if re.search(KEYWORDS_B, title, re.I) or (len(letters) >= 8 and len(letters) > 2 * len(hangul)):
        return "B", "자동", "팬덤·해외투어형 공연명"
    return "C", "자동", "기본값(혼합형)"


def default_start(venue: str, d: date) -> int:
    weekend = d.weekday() >= 5 or d in HOLIDAY_DATES
    if venue in ("우리금융아트홀", "뮤즈라이브"):
        return 14 * 60 if weekend else 19 * 60 + 30
    if d.weekday() == 5:
        return 18 * 60
    if weekend:
        return 17 * 60
    return 19 * 60 + 30


def default_duration(venue: str) -> int:
    return {"우리금융아트홀": 120, "뮤즈라이브": 70}.get(venue, 150)


def build_shows(events: list[dict], tags: dict) -> pd.DataFrame:
    rows = []
    for ev in events:
        try:
            b, e = date.fromisoformat(ev["beginDt"]), date.fromisoformat(ev["endDt"])
        except (TypeError, ValueError):
            continue
        if (e - b).days > 200:  # 상설 전시 등은 제외
            continue
        venue = normalize_venue(ev.get("plc", ""))
        cls, cls_src, cls_note = classify(ev, tags)
        sched, method, end_min = parse_show_times(ev.get("tm") or "", b, e, HOLIDAY_DATES)
        dur = parse_duration_minutes(ev.get("ndTm")) or default_duration(venue)
        for d, starts in sched.items():
            if starts is None:
                starts, src = [default_start(venue, d)], "추정"
            else:
                src = "공연정보"
            for st in starts:
                du = dur
                if end_min and end_min > st:
                    du = end_min - st
                rows.append({
                    "date": d, "evtSeq": ev["evtSeq"], "title": (ev.get("title") or "").strip(),
                    "venue": venue, "plc": ev.get("plc", ""), "start": st, "dur": int(du),
                    "cls": cls, "clsSrc": cls_src, "clsNote": cls_note, "timeSrc": src, "parse": method,
                    "seats": VENUES[venue]["seats"], "link": ev.get("evtLink") or "",
                })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- 점유대수

def load_occupancy() -> tuple[pd.DataFrame, pd.DataFrame]:
    df = pd.read_csv(RAW / "parking_inout_2024-07.csv")
    df["in"] = pd.to_datetime(df["입차일시"])
    df["out"] = pd.to_datetime(df["출차일시"])
    grid = pd.date_range("2024-07-01", "2024-08-01", freq="10min", inclusive="left")
    ins = np.searchsorted(np.sort(df["in"].values), grid.values, side="right")
    outs = np.searchsorted(np.sort(df["out"].values), grid.values, side="right")
    occ = pd.Series(ins - outs, index=grid, dtype=float)
    slot = occ.groupby([occ.index.date, (occ.index.hour * 60 + occ.index.minute) // SLOT_MIN]).mean().unstack()
    slot.index = pd.to_datetime(slot.index).date
    return df, slot


def day_type(d: date) -> str:
    if d in HOLIDAY_DATES or d.weekday() == 6:
        return "sunday"
    if d.weekday() == 5:
        return "saturday"
    return "weekday"


# ---------------------------------------------------------------- 공연 영향 곡선

def show_curve(start_min: int, dur_min: int, lead: float, power: float, tail: float, extra: float) -> np.ndarray:
    """공연 1회가 주차장 점유에 주는 상대 영향(0~1)을 30분 슬롯별로 계산(슬롯 내 5점 평균)."""
    s = start_min / 60.0
    e = s + dur_min / 60.0 + extra
    t = (np.arange(NSLOT)[:, None] * SLOT_MIN + np.linspace(3, SLOT_MIN - 3, 5)[None, :]) / 60.0
    v = np.zeros_like(t)
    ramp = (t >= s - lead) & (t < s)
    v[ramp] = ((t[ramp] - (s - lead)) / lead) ** power
    v[(t >= s) & (t < e)] = 1.0
    dec = (t >= e) & (t < e + tail)
    v[dec] = 1.0 - (t[dec] - e) / tail
    return v.mean(axis=1)


def event_features(shows: pd.DataFrame, days: list[date], params: tuple) -> np.ndarray:
    """날짜×슬롯별 [A형 영향, B형 영향] (좌석 1,000석 단위). C형은 A·B 중간값으로 본다."""
    lead, power, tail, extra = params
    feats = np.zeros((len(days), NSLOT, 2))
    idx = {d: i for i, d in enumerate(days)}
    for r in shows.itertuples():
        if r.date not in idx:
            continue
        c = show_curve(r.start, r.dur, lead, power, tail, extra) * (r.seats / 1000.0)
        w = {"A": (1.0, 0.0), "B": (0.0, 1.0), "C": (0.5, 0.5)}[r.cls]
        feats[idx[r.date], :, 0] += w[0] * c
        feats[idx[r.date], :, 1] += w[1] * c
    return feats


def fit(occ: np.ndarray, types: list[str], feats: np.ndarray, use_events: bool = True):
    """최소제곱 추정: 요일유형×슬롯 기본값 + 관객유형 계수 2개."""
    n = occ.shape[0]
    nb = len(DAY_TYPES) * NSLOT
    cols = nb + (2 if use_events else 0)
    X = np.zeros((n * NSLOT, cols))
    y = occ.reshape(-1)
    for i in range(n):
        ti = DAY_TYPES.index(types[i])
        rows = slice(i * NSLOT, (i + 1) * NSLOT)
        X[rows, ti * NSLOT:(ti + 1) * NSLOT] = np.eye(NSLOT)
        if use_events:
            X[rows, nb:] = feats[i]
    # 표본이 없는 요일유형 열이 있으면 lstsq가 0을 준다(최소노름 해)
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    if use_events and (coef[nb:] < 0).any():  # 음수 계수는 0으로 고정 후 재추정
        keep = [k for k in range(cols) if k < nb or coef[k] > 0]
        sub, *_ = np.linalg.lstsq(X[:, keep], y, rcond=None)
        coef = np.zeros(cols)
        coef[keep] = sub
    base = coef[:nb].reshape(len(DAY_TYPES), NSLOT)
    ev = coef[nb:] if use_events else np.zeros(2)
    return base, ev


def predict(base, ev, types, feats):
    out = np.zeros((len(types), NSLOT))
    for i, t in enumerate(types):
        out[i] = base[DAY_TYPES.index(t)] + feats[i] @ ev
    return out


def level_of(x: np.ndarray) -> np.ndarray:
    r = x / CAPACITY
    return np.digitize(r, [0.5, 0.7, 0.9])


def evaluate(occ, types, feats, use_events=True):
    """날짜 단위 leave-one-out 예측."""
    n = occ.shape[0]
    preds = np.zeros_like(occ)
    for i in range(n):
        m = np.ones(n, bool)
        m[i] = False
        base, ev = fit(occ[m], [t for t, k in zip(types, m) if k], feats[m], use_events)
        preds[i] = predict(base, ev, [types[i]], feats[i:i + 1])[0]
    return preds


def metrics(occ, preds, mask_days=None, hours=(7, 23)):
    sl = slice(hours[0] * 2, hours[1] * 2)
    o, p = occ[:, sl], preds[:, sl]
    if mask_days is not None:
        o, p = o[mask_days], p[mask_days]
    err = np.abs(o - p)
    peak_err = np.abs(o.max(axis=1) - p.max(axis=1))
    return {
        "mae_cars": round(float(err.mean()), 1),
        "mae_pct_capacity": round(float(err.mean() / CAPACITY * 100), 2),
        "wape_pct": round(float(err.sum() / o.sum() * 100), 1),
        "peak_mae_cars": round(float(peak_err.mean()), 1),
        "level_accuracy_pct": round(float((level_of(o) == level_of(p)).mean() * 100), 1),
        "days": int(o.shape[0]),
    }


# ---------------------------------------------------------------- 보조 데이터

def month_factors() -> dict:
    m = pd.read_csv(RAW / "parking_monthly.csv")
    m = m[m["주차장소"] == "올림픽공원"].copy()
    m["mon"] = m["월"].str.extract(r"(\d+)").astype(int)
    avg = m.groupby("mon")["주차대수"].mean()
    rel = avg / avg.loc[7]
    damp = 1 + 0.8 * (rel - 1)  # 월 합계에는 공연 수요도 섞여 있어 80%만 반영
    series = m.pivot_table(index="mon", columns="연도", values="주차대수").sort_index()
    return {
        "factor": [round(float(damp.loc[k]), 3) for k in range(1, 13)],
        "raw_relative_to_july": [round(float(rel.loc[k]), 3) for k in range(1, 13)],
        "monthly_by_year": {str(y): [int(v) for v in series[y].tolist()] for y in series.columns},
    }


def lot_stats() -> dict:
    c = pd.read_csv(RAW / "parking_congestion.csv")
    c["ts"] = pd.to_datetime(c["등록일"] + " " + c["등록시간"])
    c["hour"] = c["ts"].dt.hour
    c["weekend"] = (c["ts"].dt.day_of_week >= 5) | c["ts"].dt.date.isin(HOLIDAY_DATES)
    out = {}
    for lot, g in c.groupby("주차구역"):
        vc = g["혼잡도"].value_counts()
        n = int(len(g))
        out[lot] = {
            "records": n,
            "full": int(vc.get("만차", 0)), "busy": int(vc.get("혼잡", 0)), "free": int(vc.get("원활", 0)),
            "full_share": round(float(vc.get("만차", 0) / n), 3),
            "gate": LOTS.get(lot, {}).get("gate"),
            "near": LOTS.get(lot, {}).get("near", []),
        }
    by_hour = c.pivot_table(index="hour", columns="혼잡도", values="일련번호", aggfunc="count").fillna(0)
    by_month = c.groupby(c["ts"].dt.month)["혼잡도"].apply(lambda s: int((s == "만차").sum()))
    weekend_full = int(((c["혼잡도"] == "만차") & c["weekend"]).sum())
    return {
        "lots": out,
        "by_hour": {str(int(h)): {k: int(v) for k, v in row.items()} for h, row in by_hour.iterrows()},
        "full_by_month": {str(int(k)): int(v) for k, v in by_month.items()},
        "full_total": int((c["혼잡도"] == "만차").sum()),
        "full_weekend": weekend_full,
        "period": [str(c["ts"].min().date()), str(c["ts"].max().date())],
        "records": int(len(c)),
    }


# ---------------------------------------------------------------- 메인

def main() -> int:
    tags = json.loads(TAGS_JSON.read_text(encoding="utf-8"))["tags"]
    events = json.loads(EVENTS_JSON.read_text(encoding="utf-8"))
    shows = build_shows(events, tags)

    raw, slot = load_occupancy()
    days = [d for d in slot.index if TRAIN_FROM <= d <= TRAIN_TO]
    occ = slot.loc[days].values
    types = [day_type(d) for d in days]

    # 곡선 모양 파라미터: 날짜 단위 교차검증 오차가 가장 작은 조합 선택
    grid = list(itertools.product([2.0, 3.0, 4.0, 5.0, 6.0], [0.5, 1.0, 1.5, 2.0], [1.0, 1.5, 2.0, 2.5, 3.0], [0.0, 0.5]))
    prev = OUT / "model.json"
    if os.environ.get("OLPARK_FAST") == "1" and prev.exists():
        # 매일 자동 갱신 시에는 이전에 고른 곡선 파라미터를 재사용(학습 데이터가 바뀌면 전체 탐색 실행)
        c = json.loads(prev.read_text(encoding="utf-8"))["curve"]
        grid = [(c["leadHours"], c["power"], c["tailHours"], c["extraHours"])]
    best = None
    for params in grid:
        feats = event_features(shows, days, params)
        preds = evaluate(occ, types, feats)
        sse = float(((occ[:, 14:46] - preds[:, 14:46]) ** 2).sum())
        if best is None or sse < best[0]:
            best = (sse, params, feats, preds)
    _, params, feats, preds = best
    base, ev = fit(occ, types, feats)

    base_only = evaluate(occ, types, np.zeros_like(feats), use_events=False)
    ev_effect = feats @ ev  # 날짜×슬롯별 공연 기여 대수
    big_event_days = ev_effect.max(axis=1) > 200  # 공연 영향이 200대를 넘는 날
    any_event_days = np.array([feats[i].sum() > 0 for i in range(len(days))])
    bt = {
        "method": "날짜 단위 교차검증(leave-one-day-out): 하루를 빼고 학습한 뒤 그 날 07~23시를 예측",
        "period": [str(days[0]), str(days[-1])],
        "model_all": metrics(occ, preds),
        "baseline_all": metrics(occ, base_only),
        "model_event_days": metrics(occ, preds, any_event_days),
        "baseline_event_days": metrics(occ, base_only, any_event_days),
        "model_big_event_days": metrics(occ, preds, big_event_days),
        "baseline_big_event_days": metrics(occ, base_only, big_event_days),
        "baseline_desc": "같은 요일유형(평일/토/일)의 평균 패턴만 사용(공연 미반영)",
    }

    # 기본 하한(야간 상주 차량): 새벽 2~5시 평균
    floors = {t: float(np.mean(base[i, 4:10])) for i, t in enumerate(DAY_TYPES)}

    mf = month_factors()
    lots = lot_stats()

    # ------------------------------------------------ 분석(인사이트)용 데이터
    d_index = {d: i for i, d in enumerate(days)}
    shows_jul = shows[(shows["date"] >= TRAIN_FROM) & (shows["date"] <= TRAIN_TO)]
    daily = []
    entries = raw.groupby(raw["in"].dt.date).size()
    for d in days:
        i = d_index[d]
        s = shows_jul[shows_jul["date"] == d]
        daily.append({
            "date": str(d), "dow": "월화수목금토일"[d.weekday()],
            "peak": int(round(occ[i].max())), "peak_time": f"{int(occ[i].argmax()) // 2:02d}:{30 * (int(occ[i].argmax()) % 2):02d}",
            "entries": int(entries.get(d, 0)),
            "shows": [{"title": r.title, "venue": r.venue, "start": f"{r.start // 60:02d}:{r.start % 60:02d}", "cls": r.cls}
                      for r in s.itertuples() if r.venue in ("KSPO DOME", "올림픽홀", "티켓링크 라이브 아레나")],
        })
    stay = (raw["out"] - raw["in"]).dt.total_seconds() / 60
    bins = [(0, 10, "10분 이하(무료 회차)"), (10, 60, "10분~1시간"), (60, 120, "1~2시간"), (120, 240, "2~4시간"), (240, 1e9, "4시간 초과")]
    stay_dist = []
    for lo, hi, lab in bins:
        mask = ((stay >= 0) if lo == 0 else (stay > lo)) & (stay <= hi)
        stay_dist.append({"label": lab, "count": int(mask.sum())})
    total = sum(b["count"] for b in stay_dist)
    for b in stay_dist:
        b["share"] = round(b["count"] / total, 4)

    def curve(i):
        return [int(round(x)) for x in occ[i]]

    case = {
        "a_day": {"date": "2024-07-21", "label": "7/21(일) SG워너비 17시 + 휘인 16시", "curve": curve(d_index[date(2024, 7, 21)])},
        "b_day": {"date": "2024-07-14", "label": "7/14(일) THE BOYZ 16시 + DPR 16시", "curve": curve(d_index[date(2024, 7, 14)])},
        "base": {"label": "일요일 기본 패턴(모델)", "curve": [int(round(x)) for x in base[DAY_TYPES.index('sunday')]]},
    }
    arrivals = {}
    for key, d in (("a_day", date(2024, 7, 21)), ("b_day", date(2024, 7, 14))):
        sub = raw[raw["in"].dt.date == d]
        h = ((sub["in"].dt.hour * 60 + sub["in"].dt.minute) // SLOT_MIN).value_counts().sort_index()
        arrivals[key] = [int(h.get(k, 0)) for k in range(NSLOT)]
    sun_days = [i for i, d in enumerate(days) if day_type(d) == "sunday"]
    profiles = {t: [int(round(x)) for x in base[i]] for i, t in enumerate(DAY_TYPES)}
    observed_mean = {t: [int(round(x)) for x in occ[[i for i, tt in enumerate(types) if tt == t]].mean(axis=0)] for t in DAY_TYPES}

    coef_per_1000 = {"A": round(float(ev[0]), 1), "B": round(float(ev[1]), 1), "C": round(float(ev.mean()), 1)}
    insights = {
        "daily_peaks": daily,
        "profiles_model": profiles,
        "profiles_observed": observed_mean,
        "case_study": case,
        "arrivals": arrivals,
        "stay_distribution": stay_dist,
        "stay_median_min": float(stay.median()),
        "records": int(len(raw)),
        "monthly": mf["monthly_by_year"],
        "congestion": lots,
        "coef_per_1000_seats": coef_per_1000,
        "n_sundays": len(sun_days),
    }

    # ------------------------------------------------ 예정 공연(웹 표시용)
    today = datetime.now(KST).date()
    upcoming = shows[(shows["date"] >= today - timedelta(days=60)) & (shows["date"] <= today + timedelta(days=150))]
    by_date: dict[str, list] = {}
    for r in upcoming.sort_values(["date", "start"]).itertuples():
        by_date.setdefault(str(r.date), []).append({
            "evtSeq": int(r.evtSeq), "title": r.title, "venue": r.venue, "start": int(r.start), "dur": int(r.dur),
            "cls": r.cls, "clsSrc": r.clsSrc, "clsNote": r.clsNote, "timeSrc": r.timeSrc,
            "url": f"https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoView.es?mid=a20301010100&evtSeq={int(r.evtSeq)}",
        })

    generated = datetime.now(KST).isoformat(timespec="minutes")
    model = {
        "version": 1,
        "generatedAt": generated,
        "capacity": CAPACITY,
        "capacityNote": "동2문·남2문·북2문 주차장(한국체육산업개발 실시간 주차현황 API 집계 범위)",
        "slotMinutes": SLOT_MIN,
        "dayTypes": DAY_TYPES,
        "base": {t: [round(float(x), 1) for x in base[i]] for i, t in enumerate(DAY_TYPES)},
        "floor": {t: round(v, 1) for t, v in floors.items()},
        "eventCoef": {"A": round(float(ev[0]), 2), "B": round(float(ev[1]), 2), "C": round(float(ev.mean()), 2)},
        "eventCoefUnit": "좌석 1,000석당 추가 점유대수(공연 중 최대)",
        "curve": {"leadHours": params[0], "power": params[1], "tailHours": params[2], "extraHours": params[3]},
        "monthFactor": mf["factor"],
        "weather": {"rainLeisureFactor": 0.75, "note": "강수 시 공원 나들이 수요 25% 감소 가정(시범 계수)"},
        "levels": LEVELS,
        "holidays": sorted(HOLIDAYS),
        "venues": VENUES,
        "lots": {k: {**v, "spaces": LOT_SPACES.get(k if k in LOT_SPACES else k[:2])} for k, v in LOTS.items()},
        "lotFullShare": {k: v["full_share"] for k, v in lots["lots"].items()},
        "classes": json.loads(TAGS_JSON.read_text(encoding="utf-8"))["classes"],
        "training": {"source": "올림픽공원 입출차 정보(2024-07, 215,528건)", "days": len(days), "from": str(days[0]), "to": str(days[-1])},
        "backtest": bt,
        "live": {"url": "https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=PARKING21803504",
                 "field": "parking_sum", "note": "한국체육산업개발 올림픽공원 실시간 주차현황(동2·남2·북2문)"},
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "model.json").write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "events.json").write_text(json.dumps({"generatedAt": generated, "byDate": by_date}, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "insights.json").write_text(json.dumps(insights, ensure_ascii=False), encoding="utf-8")

    print("curve params (lead, power, tail, extra):", params)
    print("event coef per 1000 seats:", coef_per_1000)
    print("floors:", {k: round(v) for k, v in floors.items()})
    for k, v in bt.items():
        if isinstance(v, dict):
            print(f"  {k:26s}", v)
    print("month factors:", mf["factor"])
    for i, d in enumerate(days):
        if ev_effect[i].max() > 50:
            print(f"   {d} {types[i]:8s} obs_peak={occ[i].max():6.0f} loo_peak={preds[i].max():6.0f} base_peak={base_only[i].max():6.0f} ev_max={ev_effect[i].max():6.0f}")
    print("shows total:", len(shows), " upcoming dates:", len(by_date))
    return 0


if __name__ == "__main__":
    sys.exit(main())

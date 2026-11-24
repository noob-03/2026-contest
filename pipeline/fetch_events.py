"""올림픽공원 공연·행사 일정(공공데이터 '올림픽공원 공연정보'의 원천 데이터)을 월별로 수집한다.

한국체육산업개발이 공공데이터포털에 개방한 '올림픽공원 공연정보'(data.go.kr/data/3037877)는
올림픽공원 누리집 공연/행사 안내(조이올팍)와 같은 원천을 사용한다. 이 스크립트는 누리집의 월별 일정
목록(JSON)을 받아 data/events/events.json 으로 합친다. 서비스키가 필요 없어 매일 자동 갱신에 쓴다.

사용법:
    python pipeline/fetch_events.py                  # 지난 36개월 ~ 향후 6개월
    python pipeline/fetch_events.py 202401 202703    # 기간 지정(YYYYMM)
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

URL = "https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoListAjax.es"
OUT = Path(__file__).resolve().parent.parent / "data" / "events" / "events.json"
KEEP = ["evtSeq", "title", "plc", "beginDt", "endDt", "tm", "ndTm", "seeAge", "tktPrc",
        "spns", "evtLink", "fileNm", "regDate"]


def months(start: str, end: str):
    y, m = int(start[:4]), int(start[4:])
    ey, em = int(end[:4]), int(end[4:])
    while (y, m) <= (ey, em):
        yield f"{y}{m:02d}"
        m += 1
        if m == 13:
            y, m = y + 1, 1


def fetch_month(ym: str, tries: int = 4) -> list[dict]:
    body = json.dumps({"nowYM": ym, "plcCd": ""}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(URL, data=body, headers={
                "Content-Type": "application/json;charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "User-Agent": "Mozilla/5.0 (compatible; olparkcast-pipeline/1.0)"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = []
            for part in data[:2]:  # [0]=진행·예정 공연, [1]=해당 월의 지난 공연
                items.extend(part or [])
            return items
        except Exception as exc:
            if i == tries - 1:
                raise
            time.sleep(2 + 2 * i)
    return []


def main(argv: list[str]) -> int:
    today = date.today()
    if len(argv) == 2:
        start, end = argv
    else:
        sy, sm = today.year - 3, today.month
        ey, em = today.year + (today.month + 6 - 1) // 12, (today.month + 6 - 1) % 12 + 1
        start, end = f"{sy}{sm:02d}", f"{ey}{em:02d}"
    existing = {}
    if OUT.exists():
        for ev in json.loads(OUT.read_text(encoding="utf-8")):
            existing[ev["evtSeq"]] = ev
    n_new = 0
    for ym in months(start, end):
        try:
            items = fetch_month(ym)
        except Exception as exc:
            print(f"[warn] {ym}: {exc}", file=sys.stderr)
            continue
        for it in items:
            rec = {k: it.get(k) for k in KEEP}
            rec["plc"] = (rec.get("plc") or "").strip()
            if rec["evtSeq"] not in existing:
                n_new += 1
            existing[rec["evtSeq"]] = rec
        time.sleep(0.4)
    events = sorted(existing.values(), key=lambda e: (e["beginDt"], e["evtSeq"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(events, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[ok] 공연 {len(events)}건 저장(신규 {n_new}) → {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

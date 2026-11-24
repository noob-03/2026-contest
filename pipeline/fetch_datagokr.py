"""공공데이터포털(data.go.kr)의 한국체육산업개발 파일데이터를 내려받아 UTF-8 CSV로 저장한다.

사용법:
    python pipeline/fetch_datagokr.py            # 등록된 전체 데이터셋
    python pipeline/fetch_datagokr.py 15138735   # 특정 데이터셋만

파일데이터는 서비스키 없이 포털의 다운로드 절차(selectFileDataDownload → fileDownload)로 받을 수 있다.
"""
from __future__ import annotations

import http.cookiejar
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://www.data.go.kr"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"

# publicDataPk → (저장 파일명, 데이터셋명)
DATASETS = {
    "15138735": ("parking_inout_2024-07.csv", "한국체육산업개발주식회사_올림픽공원 입출차 정보"),
    "15131671": ("parking_monthly.csv", "한국체육산업개발주식회사_월별주차현황"),
    "15164156": ("parking_congestion.csv", "한국체육산업개발주식회사_주차장 혼잡도 정보"),
}

_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj))
_opener.addheaders = [("User-Agent", "Mozilla/5.0 (compatible; olparkcast-pipeline/1.0)"),
                      ("Accept-Language", "ko-KR,ko;q=0.9")]


def _request(url: str, data: dict | None = None, referer: str | None = None, tries: int = 6):
    last = None
    for i in range(tries):
        try:
            body = urllib.parse.urlencode(data).encode() if data is not None else None
            req = urllib.request.Request(url, data=body)
            if referer:
                req.add_header("Referer", referer)
            if data is not None:
                req.add_header("X-Requested-With", "XMLHttpRequest")
                req.add_header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
            with _opener.open(req, timeout=120) as resp:
                return resp.read(), resp.headers
        except Exception as exc:  # 포털이 간헐적으로 연결을 끊으므로 재시도
            last = exc
            time.sleep(2 + 2 * i)
    raise RuntimeError(f"요청 실패: {url}: {last}")


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp949", errors="replace")


def download(pk: str) -> Path:
    fname, title = DATASETS[pk]
    page = f"{BASE}/data/{pk}/fileData.do"
    html, _ = _request(page)
    html = html.decode("utf-8", "replace")
    m = re.search(r"fn_fileDataDown\('(\d+)',\s*'([^']+)',\s*'([^']*)',\s*'([^']*)'", html)
    if not m:
        raise RuntimeError(f"{pk}: 다운로드 정보를 찾지 못했습니다")
    _, detail_pk, atch, sn = m.groups()
    meta, _ = _request(f"{BASE}/tcs/dss/selectFileDataDownload.do", data={
        "publicDataDetailPk": detail_pk, "publicDataPk": pk, "atchFileId": atch,
        "fileDetailSn": sn or "1", "publicDataTyCode": "PR0051"}, referer=page)
    meta = json.loads(meta.decode("utf-8", "replace"))
    if not meta.get("status"):
        raise RuntimeError(f"{pk}: {meta.get('error') or '다운로드 거부'}")
    atch_id, file_sn = meta["atchFileId"], meta["fileDetailSn"]
    name = meta.get("dataSetFileDetailInfo", {}).get("dataNm") or title
    limit, _ = _request(f"{BASE}/cmm/cmm/check-limit.json",
                        data={"atchFileId": atch_id, "fileDetailSn": file_sn}, referer=page)
    if b"needCaptcha\":true" in limit.replace(b" ", b""):
        raise RuntimeError(f"{pk}: 다운로드 횟수 제한(캡차) — 잠시 후 다시 시도하세요")
    query = urllib.parse.urlencode({"atchFileId": atch_id, "fileDetailSn": file_sn, "dataNm": name})
    raw, headers = _request(f"{BASE}/cmm/cmm/fileDownload.do?{query}", referer=page)
    disp = headers.get("Content-Disposition", "")
    src = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", disp)
    src_name = urllib.parse.unquote(src.group(1)) if src else name
    try:
        src_name = src_name.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    text = _decode(raw).replace("\r\n", "\n")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out = RAW_DIR / fname
    out.write_text(text, encoding="utf-8")
    print(f"[ok] {pk} {title} → {out.relative_to(RAW_DIR.parent.parent)} (원본: {src_name}, {len(raw):,} bytes)")
    return out


def main(argv: list[str]) -> int:
    targets = argv or list(DATASETS)
    failed = 0
    for pk in targets:
        try:
            download(pk)
        except Exception as exc:
            failed += 1
            print(f"[fail] {pk}: {exc}", file=sys.stderr)
        time.sleep(3)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

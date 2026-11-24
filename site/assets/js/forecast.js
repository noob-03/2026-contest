// 올팍캐스트 예보 엔진 — pipeline/build_model.py 와 같은 식을 브라우저에서 계산한다.
//   점유대수(슬롯) = 하한 + (요일유형 기본값 − 하한) × 월 계수 × 날씨 계수
//                 + Σ 공연 [좌석수/1000 × 관객유형 계수 × 도착·체류·퇴장 곡선]
//                 (+ 오늘은 실시간 주차대수와의 차이를 시간이 지날수록 줄여 가며 반영)

export const LEVEL_KEYS = ['free', 'normal', 'busy', 'full'];
export const LEVEL_LABEL = { free: '여유', normal: '보통', busy: '혼잡', full: '만차 위험' };
export const DOW = ['일', '월', '화', '수', '목', '금', '토'];

export function levelOf(ratio) {
  if (ratio >= 0.9) return 'full';
  if (ratio >= 0.7) return 'busy';
  if (ratio >= 0.5) return 'normal';
  return 'free';
}

export function pad(n) { return String(n).padStart(2, '0'); }
export function fmtMin(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
export function parseYmd(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** 한국 시간 기준 현재 시각 { ds:'YYYY-MM-DD', min: 0~1439 } */
export function nowKST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { ds: `${get('year')}-${get('month')}-${get('day')}`, min: Number(get('hour')) * 60 + Number(get('minute')) };
}
export function addDays(ds, n) {
  const d = parseYmd(ds);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export class Forecaster {
  constructor(model, events) {
    this.m = model;
    this.byDate = (events && events.byDate) || {};
    this.holidays = new Set(model.holidays || []);
    this.slotMin = model.slotMinutes;
    this.nSlot = (24 * 60) / this.slotMin;
    this.cap = model.capacity;
    this._curveCache = new Map();
  }

  dayType(ds) {
    const wd = parseYmd(ds).getDay();
    if (this.holidays.has(ds) || wd === 0) return 'sunday';
    if (wd === 6) return 'saturday';
    return 'weekday';
  }

  isHoliday(ds) { return this.holidays.has(ds); }

  /** 공연 1회의 슬롯별 상대 영향(0~1) — 파이썬 show_curve 와 동일(슬롯 내 5점 평균) */
  curve(startMin, durMin) {
    const key = `${startMin}|${durMin}`;
    if (this._curveCache.has(key)) return this._curveCache.get(key);
    const { leadHours: lead, power, tailHours: tail, extraHours: extra } = this.m.curve;
    const s = startMin / 60;
    const e = s + durMin / 60 + extra;
    const out = new Float64Array(this.nSlot);
    const offs = [3, 9, 15, 21, 27].map((x) => (x * this.slotMin) / 30);
    for (let k = 0; k < this.nSlot; k++) {
      let acc = 0;
      for (const o of offs) {
        const t = (k * this.slotMin + o) / 60;
        let v = 0;
        if (t >= s - lead && t < s) v = ((t - (s - lead)) / lead) ** power;
        else if (t >= s && t < e) v = 1;
        else if (t >= e && t < e + tail) v = 1 - (t - e) / tail;
        acc += v;
      }
      out[k] = acc / offs.length;
    }
    this._curveCache.set(key, out);
    return out;
  }

  showsOn(ds) {
    return (this.byDate[ds] || []).map((sh) => {
      const venue = this.m.venues[sh.venue] || this.m.venues['기타'];
      const coef = this.m.eventCoef[sh.cls] ?? this.m.eventCoef.C;
      return { ...sh, seats: venue.seats, venueInfo: venue, peakCars: Math.round((venue.seats / 1000) * coef) };
    });
  }

  /**
   * 하루 예보.
   * @param {string} ds YYYY-MM-DD
   * @param {{rain?: (ds:string, slot:number)=>number, live?: {value:number, min:number}}} opts
   *   rain: 해당 슬롯 강수 가능성(0~1). live: 오늘 실시간 주차대수와 측정 시각(분)
   */
  forecast(ds, opts = {}) {
    const type = this.dayType(ds);
    const month = Number(ds.slice(5, 7));
    const mf = this.m.monthFactor[month - 1];
    const floor = this.m.floor[type];
    const base = this.m.base[type];
    const rainK = this.m.weather.rainLeisureFactor;
    const shows = this.showsOn(ds);
    const curves = shows.map((sh) => this.curve(sh.start, sh.dur));
    const slots = [];
    for (let k = 0; k < this.nSlot; k++) {
      const b = Math.max(0, base[k]);
      const leisure = Math.max(0, b - floor);
      const rainP = opts.rain ? opts.rain(ds, k) : null;
      const wK = rainP == null ? 1 : 1 - (1 - rainK) * Math.min(1, Math.max(0, (rainP - 0.3) / 0.4));
      const baseVal = Math.min(b, floor) + leisure * mf * wK;
      const parts = shows.map((sh, i) => (sh.seats / 1000) * (this.m.eventCoef[sh.cls] ?? 0) * curves[i][k]);
      const ev = parts.reduce((a, c) => a + c, 0);
      slots.push({ k, min: k * this.slotMin, base: baseVal, event: ev, parts, rainP, total: baseVal + ev, adj: 0 });
    }

    let nowcast = null;
    if (opts.live && Number.isFinite(opts.live.value)) {
      const nowSlot = Math.min(this.nSlot - 1, Math.floor(opts.live.min / this.slotMin));
      const predNow = slots[nowSlot].total;
      const delta = opts.live.value - predNow;
      // 차이의 일부(40%)는 그날 내내 유지되는 수준 차이로, 나머지는 2시간 반감으로 사라지는 일시적 차이로 본다.
      for (const s of slots) {
        if (s.k < nowSlot) continue;
        const hours = ((s.k - nowSlot) * this.slotMin) / 60;
        const w = 0.4 + 0.6 * Math.pow(0.5, hours / 2);
        s.adj = delta * w;
      }
      slots[nowSlot].adj = delta;
      nowcast = { nowSlot, predNow, delta, value: opts.live.value };
    }
    for (const s of slots) {
      s.final = Math.max(0, s.total + s.adj);
      s.ratio = s.final / this.cap;
      s.level = levelOf(s.ratio);
    }
    const peakSlot = slots.reduce((a, s) => (s.k >= 12 && s.final > a.final ? s : a), slots[12]);
    return { ds, type, month, mf, shows, slots, peak: peakSlot, nowcast };
  }

  /** from~to(시) 사이에서 길이 len 슬롯 동안 평균 점유가 가장 낮은 구간 */
  bestWindow(fc, fromH = 7, toH = 21, len = 4, minStartMin = null) {
    const ks = fc.slots.filter((s) => s.min >= fromH * 60 && s.min + len * this.slotMin <= toH * 60 && (minStartMin == null || s.min >= minStartMin));
    let best = null;
    for (const s of ks) {
      const win = fc.slots.slice(s.k, s.k + len);
      const avg = win.reduce((a, x) => a + x.final, 0) / win.length;
      if (!best || avg < best.avg - 1e-6) best = { start: s.min, end: s.min + len * this.slotMin, avg, level: levelOf(avg / this.cap) };
    }
    return best;
  }

  /** 기준 이상 혼잡 구간 목록 [{start,end,maxLevel}] */
  busyRanges(fc, minLevel = 'busy', fromH = 6) {
    const rank = (l) => LEVEL_KEYS.indexOf(l);
    const out = [];
    let cur = null;
    for (const s of fc.slots) {
      if (s.min < fromH * 60) continue;
      if (rank(s.level) >= rank(minLevel)) {
        if (!cur) cur = { start: s.min, end: s.min + this.slotMin, maxLevel: s.level, peak: s.final };
        else { cur.end = s.min + this.slotMin; if (rank(s.level) > rank(cur.maxLevel)) cur.maxLevel = s.level; cur.peak = Math.max(cur.peak, s.final); }
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** 공연 관람객 도착 권장 시각 계산 */
  arrivalAdvice(fc, show) {
    const startSlot = Math.floor(show.start / this.slotMin);
    const before = fc.slots.filter((s) => s.k < startSlot && s.min >= show.start - 6 * 60);
    const full = before.find((s) => s.ratio >= 0.9);
    const busy = before.find((s) => s.ratio >= 0.7);
    if (full) return { kind: 'full', fullAt: full.min, arriveBy: Math.max(show.start - 6 * 60, full.min - 30) };
    if (busy) return { kind: 'busy', busyAt: busy.min, arriveBy: Math.max(show.start - 6 * 60, busy.min - 30) };
    return { kind: 'ok', arriveBy: show.start - 60 };
  }

  /** 날짜의 최대 혼잡(06~24시) */
  dayPeak(ds, opts) {
    const fc = this.forecast(ds, opts);
    return { level: fc.peak.level, ratio: fc.peak.ratio, min: fc.peak.min, fc };
  }
}

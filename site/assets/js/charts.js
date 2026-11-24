// 가벼운 SVG 차트 모음(외부 라이브러리 없음).
// 규칙: 막대 ≤24px·윗면 4px 라운드·밑면 직각, 선 2px, 격자 1px 실선, 값은 툴팁+표로 제공.

const NS = 'http://www.w3.org/2000/svg';
const tooltipEl = () => document.getElementById('tooltip');

export function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function text(parent, x, y, str, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

/** 위쪽 모서리만 둥근 막대 경로 */
function colPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
/** 오른쪽 끝만 둥근 가로 막대 */
function rowPath(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

// ---------------------------------------------------------------- 툴팁
export function showTooltip(rows, clientX, clientY) {
  const tt = tooltipEl();
  tt.replaceChildren();
  for (const r of rows) {
    if (r.title) {
      const d = document.createElement('div');
      d.className = 'tt-title';
      d.textContent = r.title;
      tt.appendChild(d);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    if (r.color) {
      const i = document.createElement('i');
      i.style.background = r.color;
      key.appendChild(i);
    }
    key.appendChild(document.createTextNode(r.label));
    const val = document.createElement('b');
    val.textContent = r.value;
    row.append(key, val);
    tt.appendChild(row);
  }
  tt.hidden = false;
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const rect = tt.getBoundingClientRect();
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + rect.width > W - 8) x = clientX - rect.width - pad;
  if (y + rect.height > H - 8) y = clientY - rect.height - pad;
  tt.style.left = `${Math.max(8, x)}px`;
  tt.style.top = `${Math.max(8, y)}px`;
}
export function hideTooltip() { tooltipEl().hidden = true; }

function widthOf(container, fallback = 640) {
  return Math.max(280, Math.floor(container.clientWidth || fallback));
}

// ---------------------------------------------------------------- 시간대별 막대(혼잡 예보)
/**
 * @param {HTMLElement} container
 * @param {{slots:Array, cap:number, from:number, to:number, nowMin?:number, colorOf:(s)=>string,
 *          tooltip:(s)=>Array, ariaLabel:string, height?:number}} o
 */
export function forecastColumns(container, o) {
  container.replaceChildren();
  const W = widthOf(container);
  const H = o.height || (W < 480 ? 210 : 250);
  const m = { t: 16, r: 8, b: 26, l: 40 };
  const data = o.slots.filter((s) => s.min >= o.from * 60 && s.min < o.to * 60);
  const maxV = Math.max(o.cap * 1.05, ...data.map((s) => s.final)) * 1.06;
  const yMax = Math.ceil(maxV / (o.cap * 0.25)) * (o.cap * 0.25);
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const band = iw / data.length;
  const bw = Math.max(3, Math.min(24, band - 2));
  const y = (v) => m.t + ih - (v / yMax) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel, focusable: 'false' }, container);
  const g = el('g', { class: 'grid' }, svg);
  for (let p = 0; p <= yMax / o.cap + 1e-9; p += 0.25) {
    const yy = y(p * o.cap);
    if (p > 0 && Math.abs(p - 1) > 1e-9) el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy }, g);
    if (p === 0 || Math.abs(p * 100 % 50) < 1e-6) text(svg, m.l - 6, yy + 4, `${Math.round(p * 100)}%`, { 'text-anchor': 'end' });
  }
  // 막대
  const bars = [];
  const nowSlotMin = o.nowMin != null ? Math.floor(o.nowMin / 30) * 30 : null;
  data.forEach((s, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    const top = y(Math.min(s.final, yMax));
    const p = el('path', { d: colPath(x, top, bw, m.t + ih - top), fill: o.colorOf(s), class: 'bar' }, svg);
    if (nowSlotMin != null && s.min < nowSlotMin) p.setAttribute('opacity', '.3'); // 지난 시간대
    bars.push(p);
  });
  // 기준선(수용 한계)
  const yCap = y(o.cap);
  el('line', { x1: m.l, x2: W - m.r, y1: yCap, y2: yCap, class: 'ref-line' }, svg);
  text(svg, W - m.r, yCap - 5, `수용 한계 ${o.cap.toLocaleString()}대`, { 'text-anchor': 'end', class: 'ref-label' });
  el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'baseline' }, svg);
  // x 라벨
  data.forEach((s, i) => {
    if (s.min % 120 === 0) text(svg, m.l + i * band + band / 2, H - 8, String(s.min / 60).padStart(2, '0'), { 'text-anchor': 'middle' });
  });
  // 현재 시각
  if (o.nowMin != null && o.nowMin >= o.from * 60 && o.nowMin < o.to * 60) {
    const xi = m.l + ((o.nowMin - o.from * 60) / ((o.to - o.from) * 60)) * iw;
    el('line', { x1: xi, x2: xi, y1: m.t - 4, y2: m.t + ih, class: 'now-line' }, svg);
    text(svg, xi + 4, m.t + 6, '지금', { class: 'now-label' });
  }
  // 상호작용: 슬롯 전체 폭이 히트 영역
  let active = -1;
  const activate = (i, cx, cy) => {
    active = i;
    bars.forEach((b, j) => b.classList.toggle('dim', j !== i));
    showTooltip(o.tooltip(data[i]), cx, cy);
  };
  const clear = () => { active = -1; bars.forEach((b) => b.classList.remove('dim')); hideTooltip(); };
  data.forEach((s, i) => {
    const r = el('rect', { x: m.l + i * band, y: m.t, width: band, height: ih, class: 'hit' }, svg);
    r.addEventListener('pointermove', (e) => activate(i, e.clientX, e.clientY));
    r.addEventListener('pointerleave', clear);
  });
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return clear();
    let i = active < 0 ? Math.max(0, data.findIndex((s) => s.min >= (o.nowMin ?? 12 * 60))) : active;
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (e.key === 'ArrowRight') i = Math.min(data.length - 1, i + 1);
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = data.length - 1;
    const bb = bars[i].getBoundingClientRect();
    activate(i, bb.left + bb.width / 2, bb.top);
  });
  svg.addEventListener('blur', clear);
}

// ---------------------------------------------------------------- 꺾은선(여러 계열)
/**
 * @param {{series:Array<{name,color,values:number[]}>, xLabels:string[], xTickEvery?:number,
 *          yFormat?:(v)=>string, height?:number, ariaLabel:string, xTitle?:(i)=>string, endLabels?:boolean}} o
 */
export function lineChart(container, o) {
  container.replaceChildren();
  // 범례(계열 2개 이상이면 항상 표시)
  if (o.series.length >= 2) {
    const ul = document.createElement('ul');
    ul.className = 'legend chart-legend';
    for (const s of o.series) {
      const li = document.createElement('li');
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.style.background = s.color;
      li.append(ln, document.createTextNode(s.name));
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
  const W = widthOf(container);
  const H = o.height || (W < 480 ? 220 : 260);
  const n = o.xLabels.length;
  const all = o.series.flatMap((s) => s.values).filter(Number.isFinite);
  const rawMax = Math.max(...all);
  const step = niceStep(rawMax / 4);
  const yMax = Math.ceil(rawMax / step) * step;
  // 끝 라벨은 선 끝이 충분히 떨어져 있을 때만(겹치면 범례·툴팁에 맡긴다)
  const ihGuess = H - 14 - 26;
  const ends = o.series.map((s) => ihGuess - (s.values[n - 1] / yMax) * ihGuess).sort((a, b) => a - b);
  const separated = ends.every((v, i) => i === 0 || v - ends[i - 1] >= 14);
  const endLab = o.endLabels !== false && o.series.length <= 4 && W >= 420 && separated;
  const m = { t: 14, r: endLab ? 96 : 12, b: 26, l: 46 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + ih - (v / yMax) * ih;
  const fmt = o.yFormat || ((v) => Math.round(v).toLocaleString());
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel, focusable: 'false' }, container);
  const g = el('g', { class: 'grid' }, svg);
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    if (v > 0) el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, g);
    text(svg, m.l - 6, y(v) + 4, compact(v), { 'text-anchor': 'end' });
  }
  el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'baseline' }, svg);
  const fit = Math.max(2, Math.floor(iw / 46));
  const every = Math.max(o.xTickEvery || 1, Math.ceil(n / fit));
  o.xLabels.forEach((lab, i) => { if (i % every === 0) text(svg, x(i), H - 8, lab, { 'text-anchor': 'middle' }); });

  for (const s of o.series) {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    if (s.area) el('path', { d: `${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: s.color, class: 'series-area' }, svg);
    el('path', { d, stroke: s.color, class: 'series-line' }, svg);
  }
  if (endLab) {
    const ends = o.series.map((s) => ({ s, yy: y(s.values[n - 1]) }));
    for (const e of ends) {
      el('circle', { cx: x(n - 1), cy: y(e.s.values[n - 1]), r: 4, fill: e.s.color, class: 'dot' }, svg);
      text(svg, x(n - 1) + 8, e.yy + 4, e.s.short || e.s.name, { class: 'end-label' });
    }
  }
  // 크로스헤어
  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
  const dots = o.series.map((s) => el('circle', { r: 4, fill: s.color, class: 'dot', visibility: 'hidden' }, svg));
  const overlay = el('rect', { x: m.l, y: m.t, width: iw, height: ih, class: 'hit' }, svg);
  let active = -1;
  const show = (i, cx, cy) => {
    active = i;
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    o.series.forEach((s, j) => { dots[j].setAttribute('cx', x(i)); dots[j].setAttribute('cy', y(s.values[i])); dots[j].setAttribute('visibility', 'visible'); });
    const rows = [{ title: o.xTitle ? o.xTitle(i) : o.xLabels[i] }];
    o.series.forEach((s) => rows.push({ label: s.name, value: fmt(s.values[i]), color: s.color }));
    showTooltip(rows, cx, cy);
  };
  const hide = () => { active = -1; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTooltip(); };
  overlay.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    show(i, e.clientX, e.clientY);
  });
  overlay.addEventListener('pointerleave', hide);
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return hide();
    const i = active < 0 ? 0 : Math.max(0, Math.min(n - 1, active + (e.key === 'ArrowRight' ? 1 : -1)));
    const r = svg.getBoundingClientRect();
    show(i, r.left + (x(i) / W) * r.width, r.top + 20);
  });
  svg.addEventListener('blur', hide);
}

// ---------------------------------------------------------------- 가로 막대
/** @param {{items:Array<{label,value,display,color?,note?}>, color:string, max?:number, ariaLabel:string}} o */
export function hbarChart(container, o) {
  container.replaceChildren();
  const W = widthOf(container);
  const rowH = 30;
  const m = { t: 4, r: 64, b: 4, l: Math.min(150, Math.max(70, W * 0.3)) };
  const H = m.t + m.b + rowH * o.items.length;
  const max = o.max || Math.max(...o.items.map((d) => d.value));
  const iw = W - m.l - m.r;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel, focusable: 'false' }, container);
  el('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'baseline' }, svg);
  o.items.forEach((d, i) => {
    const yy = m.t + i * rowH;
    const bh = Math.min(18, rowH - 10);
    const w = (d.value / max) * iw;
    text(svg, m.l - 8, yy + rowH / 2 + 4, d.label, { 'text-anchor': 'end', class: 'hbar-label' });
    const p = el('path', { d: rowPath(m.l, yy + (rowH - bh) / 2, Math.max(w, 1), bh), fill: d.color || o.color, class: 'bar' }, svg);
    text(svg, m.l + w + 6, yy + rowH / 2 + 4, d.display, { class: 'hbar-value' });
    const hit = el('rect', { x: 0, y: yy, width: W, height: rowH, class: 'hit' }, svg);
    hit.addEventListener('pointermove', (e) => { p.setAttribute('opacity', '.8'); showTooltip([{ title: d.label }, { label: d.note || '값', value: d.display }], e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', () => { p.removeAttribute('opacity'); hideTooltip(); });
  });
}

// ---------------------------------------------------------------- 7일 전망용 미니 막대
export function sparkBars(svgParent, values, cap, colorOf, w = 220, h = 26) {
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' }, svgParent);
  const n = values.length;
  const band = w / n;
  const bw = Math.max(1, band - 1);
  const max = Math.max(cap * 1.1, ...values.map((v) => v.final));
  values.forEach((v, i) => {
    const bh = Math.max(1, (v.final / max) * (h - 2));
    el('path', { d: colPath(i * band, h - bh, bw, bh, 1.5), fill: colorOf(v) }, svg);
  });
  return svg;
}

// ---------------------------------------------------------------- 보조
export function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const f = raw / p;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * p;
}
export function compact(v) {
  if (v >= 10000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`;
  return Math.round(v).toLocaleString();
}

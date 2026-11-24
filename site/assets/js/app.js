import { Forecaster, LEVEL_KEYS, LEVEL_LABEL, DOW, levelOf, fmtMin, parseYmd, nowKST, addDays, pad } from './forecast.js';
import { forecastColumns, lineChart, hbarChart, sparkBars } from './charts.js';

const LIVE_REFRESH_MS = 5 * 60 * 1000;
const PARK = { lat: 37.5207, lon: 127.1214 };
const STATE = { model: null, events: null, insights: null, fc: null, live: null, liveError: null, weather: null, date: null, calMonth: null, opsDays: 30, view: null, routed: false };
const PURPOSE_LABEL = { show: '공연 관람', walk: '산책·나들이', sports: '운동·수영', kids: '아이와 함께' };
const VIEW_TITLE = { home: '올팍캐스트 · 올림픽공원 혼잡 예보', forecast: '혼잡 예보', plan: '방문 플래너', calendar: '공연 캘린더', ops: '운영 리포트', insights: '데이터 인사이트', about: '서비스 소개' };

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const lvColor = (lv) => css(`--lv-${lv}`);
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const pct = (r) => `${Math.round(r * 100)}%`;
const cars = (v) => `${Math.round(v).toLocaleString()}대`;
const mdLabel = (ds) => { const d = parseYmd(ds); return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`; };
/** 목록용 짧은 공연명: 앞의 [서울]·연도, 끝의 ' - 서울' 을 뗀다 */
const shortTitle = (t) => t.replace(/^\s*[[［(（<〈【][^\]］)）>〉】]{1,8}[\]］)）>〉】]\s*/, '').replace(/^\s*\d{4}\s+/, '')
  .replace(/\s*[-–—]\s*(in\s+)?seoul\s*$|\s*[-–—]\s*서울\s*$/i, '').trim() || t;
/** 짧은 시간 범위: 10:00~12:00 → 10~12시 (둘 다 정시일 때만 줄인다) */
const rangeShort = (a, b) => (a % 60 === 0 && b % 60 === 0 ? `${a / 60}~${b / 60}시` : `${fmtMin(a)}~${fmtMin(b)}`);
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

// ---------------------------------------------------------------- 혼잡 단계 아이콘(항상 글자와 함께 표시)
const ICONS = {
  free: '<circle cx="16" cy="16" r="7" fill="var(--lv-free)"/><g stroke="var(--lv-free)" stroke-width="2.2" stroke-linecap="round"><path d="M16 3v3M16 26v3M3 16h3M26 16h3M6.8 6.8l2.1 2.1M23.1 23.1l2.1 2.1M6.8 25.2l2.1-2.1M23.1 8.9l2.1-2.1"/></g>',
  normal: '<circle cx="12" cy="12" r="6" fill="var(--lv-normal)"/><path d="M9 26h14.5a5 5 0 0 0 0-10 6.5 6.5 0 0 0-12.4 2A4 4 0 0 0 9 26Z" fill="var(--muted)"/>',
  busy: '<path d="M7 20h17a5.5 5.5 0 0 0 0-11 7.5 7.5 0 0 0-14.3 2.3A4.4 4.4 0 0 0 7 20Z" fill="var(--lv-busy)"/><g stroke="var(--lv-busy)" stroke-width="2.2" stroke-linecap="round"><path d="M11 24l-1.5 4M17 24l-1.5 4M23 24l-1.5 4"/></g>',
  full: '<path d="M6 19h18a5.5 5.5 0 0 0 0-11 7.5 7.5 0 0 0-14.3 2.3A4.4 4.4 0 0 0 6 19Z" fill="var(--lv-full)"/><path d="M17 19l-4 6h4l-2 5 6-8h-4l2-3z" fill="var(--lv-normal)"/>',
};
function levelIcon(lv, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('class', 'lv-icon');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[lv];
  return s;
}
function levelBadge(lv, extra) {
  return h('span', { class: `badge ${lv}` }, levelIcon(lv, 16), LEVEL_LABEL[lv], extra ? h('span', { class: 'muted', text: ` ${extra}` }) : null);
}
function clsBadge(cls) {
  const info = STATE.model.classes[cls];
  return h('span', { class: `cls ${cls}`, title: info?.desc || '' }, info?.name || cls);
}

// ---------------------------------------------------------------- 데이터 로드
async function loadJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function fetchLive() {
  const url = STATE.model.live.url;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    const data = await r.json();
    const v = Number(Array.isArray(data) ? data[0]?.parking_sum : data?.parking_sum);
    if (!Number.isFinite(v)) throw new Error('값 없음');
    const now = nowKST();
    STATE.live = { value: v, ds: now.ds, min: now.min, at: new Date() };
    STATE.liveError = null;
  } catch (e) {
    STATE.liveError = e.message || String(e);
  }
}

async function fetchWeather() {
  // 1순위: 파이프라인이 만든 기상청 단기예보(data/weather.json). 없으면 Open-Meteo.
  try {
    if (!STATE.model.weatherFeed) throw new Error('기상청 예보 파일 없음');
    const w = await loadJSON(STATE.model.weatherFeed);
    if (w && w.hourly && Date.now() - Date.parse(w.generatedAt) < 12 * 3600e3) {
      STATE.weather = { source: w.source, hourly: new Map(Object.entries(w.hourly)), daily: w.daily || {} };
      return;
    }
  } catch (e) { /* 없음 */ }
  try {
    const q = new URLSearchParams({
      latitude: PARK.lat, longitude: PARK.lon, timezone: 'Asia/Seoul', forecast_days: '8',
      hourly: 'precipitation_probability,precipitation,temperature_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    });
    const w = await loadJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
    const hourly = new Map();
    w.hourly.time.forEach((t, i) => {
      hourly.set(t.slice(0, 13), { p: (w.hourly.precipitation_probability[i] ?? 0) / 100, mm: w.hourly.precipitation[i] ?? 0, temp: w.hourly.temperature_2m[i] });
    });
    const daily = {};
    w.daily.time.forEach((d, i) => {
      daily[d] = { code: w.daily.weather_code[i], tmax: w.daily.temperature_2m_max[i], tmin: w.daily.temperature_2m_min[i], pmax: (w.daily.precipitation_probability_max[i] ?? 0) / 100 };
    });
    STATE.weather = { source: 'Open-Meteo', hourly, daily };
  } catch (e) {
    STATE.weather = null;
  }
}

function rainFn() {
  if (!STATE.weather) return null;
  return (ds, k) => {
    const hour = Math.floor((k * STATE.model.slotMinutes) / 60);
    const rec = STATE.weather.hourly.get(`${ds}T${String(hour).padStart(2, '0')}`);
    if (!rec) return null;
    return Math.max(rec.p, rec.mm >= 0.5 ? 0.8 : 0);
  };
}

function forecastFor(ds) {
  const now = nowKST();
  const opts = { rain: rainFn() };
  if (STATE.live && ds === now.ds && STATE.live.ds === now.ds) opts.live = { value: STATE.live.value, min: STATE.live.min };
  return STATE.fc.forecast(ds, opts);
}

// ---------------------------------------------------------------- 라우팅
function route() {
  const [tab, ...args] = decodeURIComponent(location.hash.replace('#', '')).split('/');
  const arg = args[0];
  const cur = VIEW_TITLE[tab] ? tab : 'home';
  const changed = STATE.view !== cur;
  STATE.view = cur;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== cur; });
  document.querySelectorAll('.gnb-nav a, .tabbar a, .menu-list a').forEach((a) => {
    const t = a.dataset.tab || a.getAttribute('href').slice(1);
    if (t === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = cur === 'home' ? VIEW_TITLE.home : `${VIEW_TITLE[cur]} · 올팍캐스트`;
  closeMenu(false);
  if (changed && STATE.routed) window.scrollTo(0, 0); // 다른 화면으로 옮길 때만 맨 위로
  STATE.routed = true;
  if (cur === 'home') renderHome();
  else if (cur === 'forecast') {
    if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) STATE.date = arg;
    renderForecast();
  } else if (cur === 'plan') renderPlan(args);
  else if (cur === 'calendar') renderCalendar(args);
  else if (cur === 'ops') renderOps();
  else if (cur === 'insights') renderInsights();
  else if (cur === 'about') renderAbout();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}

function downloadBlob(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

/** 공연 영향 등으로 혼잡이 이어지는 구간 중 '지금 이후'만 */
function rangesFrom(fc, minLevel, fromMin) {
  return STATE.fc.busyRanges(fc, minLevel).filter((b) => fromMin == null || b.end > fromMin);
}

/** 가장 한산한 2시간(07~21시). 남은 시간이 부족하면 1시간 단위로 24시까지 찾는다.
 *  calm=false 이면 '한산'하다고 부를 수 없는(이용률 70% 이상) 구간이다. */
function quietWindow(fc, fromMin, fromH = 7, toH = 21) {
  const w = STATE.fc.bestWindow(fc, fromH, toH, 4, fromMin) || STATE.fc.bestWindow(fc, fromH, 24, 2, fromMin);
  return w ? { ...w, calm: w.level === 'free' || w.level === 'normal' } : null;
}

/** 오늘은 지금 이후 남은 시간대 중 최대, 다른 날은 하루 최대 */
function remainingPeak(fc, isToday, nowMin) {
  if (!isToday) return fc.peak;
  const nowSlot = Math.floor(nowMin / 30);
  const rest = fc.slots.filter((s) => s.k >= nowSlot && s.min < 24 * 60);
  return rest.length ? rest.reduce((a, s) => (s.final > a.final ? s : a), rest[0]) : fc.peak;
}

function levelLegendItems() {
  const range = { free: '50% 미만', normal: '50~70%', busy: '70~90%', full: '90% 이상' };
  return LEVEL_KEYS.map((lv) => {
    const sw = h('span', { class: 'sw' });
    sw.style.background = lvColor(lv);
    return h('li', {}, sw, `${LEVEL_LABEL[lv]} ${range[lv]}`);
  });
}

function slotTooltip(fc, isToday) {
  return (s) => {
    const past = isToday && s.min + 30 <= nowKST().min;
    const rows = [{ title: `${mdLabel(fc.ds)} ${fmtMin(s.min)}~${fmtMin(s.min + 30)}${past ? ' (지난 시간)' : ''}` },
      { label: `예상 ${LEVEL_LABEL[s.level]}`, value: `${pct(s.ratio)} · ${cars(s.final)}` },
      { label: '평소 방문', value: cars(s.base) }];
    if (s.event >= 5) rows.push({ label: '공연 영향', value: `+${cars(s.event)}` });
    if (Math.abs(s.adj) >= 5) rows.push({ label: '실시간 보정', value: `${s.adj > 0 ? '+' : '−'}${cars(Math.abs(s.adj))}` });
    if (s.rainP != null && s.rainP >= 0.3) rows.push({ label: '강수 가능성', value: pct(s.rainP) });
    return rows;
  };
}

// ---------------------------------------------------------------- 홈(첫 화면)
const HERO_WORD = { free: '여유로워요', normal: '조금 붐벼요', busy: '붐벼요', full: '만차 위험' };
const periodOf = (min) => (min < 12 * 60 ? '오전' : min < 14 * 60 ? '점심 무렵' : min < 18 * 60 ? '오후' : min < 21 * 60 ? '저녁' : '밤');

/** 첫 화면이 보여 줄 날: 오늘, 밤 10시가 넘으면 내일 */
function heroDay() {
  const now = nowKST();
  const late = now.min >= 22 * 60;
  return { now, ds: late ? addDays(now.ds, 1) : now.ds, isToday: !late, when: late ? '내일' : '오늘' };
}

// 혼잡 단계별 하늘(낮/밤 화면 모드). 맑을수록 여유, 폭풍일수록 만차 위험.
const SCENE = {
  day: {
    free: { top: '#4aa8f7', bot: '#e4f4ff', sun: '#ffc531', cloud: ['#ffffff', '#f2f7fd'], far: '#a8dcbb', near: ['#82cb9c', '#5fb381'], land: '#7c98c7', land2: '#6984b5', rib: '#a9bde2', tree: ['#3f9b64', '#58b47b'], trunk: '#7a5a3a', lot: '#d9e0ea', stall: '#ffffff' },
    normal: { top: '#86bcef', bot: '#eef5fc', sun: '#ffcf4d', cloud: ['#ffffff', '#e7edf6'], far: '#b1d9be', near: ['#8bc7a0', '#6ab287'], land: '#889ec4', land2: '#7389b2', rib: '#b3c3e1', tree: ['#47a06b', '#60b582'], trunk: '#7a5a3a', lot: '#d9e0ea', stall: '#ffffff' },
    busy: { top: '#8592ab', bot: '#dde2ea', cloud: ['#c3cad7', '#a9b2c3'], rain: '#6b7ca2', far: '#a2bcaa', near: ['#86aa94', '#6c937b'], land: '#75849e', land2: '#66748d', rib: '#98a6bf', tree: ['#5a8f6d', '#6e9f80'], trunk: '#6a5040', lot: '#cdd3dd', stall: '#eef1f5' },
    full: { top: '#232a47', bot: '#59627f', cloud: ['#4a5370', '#3a425d'], rain: '#a9b8dc', bolt: '#ffd84a', far: '#45604f', near: ['#3a5444', '#2d4436'], land: '#323c58', land2: '#2a3350', rib: '#4a5680', tree: ['#2f5a41', '#386a4c'], trunk: '#3a2e28', lot: '#3a425a', stall: '#5d6683', dark: true },
  },
  night: {
    free: { top: '#0a1538', bot: '#27397a', moon: '#f5efd2', cloud: ['#2f3f73', '#26355f'], far: '#1c3a37', near: ['#163128', '#10261f'], land: '#24315c', land2: '#1d2850', rib: '#34467e', tree: ['#14402c', '#1a4c35'], trunk: '#2a2320', lot: '#232c46', stall: '#3a4666', stars: 38, dark: true },
    normal: { top: '#0f1a3d', bot: '#33416f', moon: '#f0ead0', cloud: ['#4a5680', '#3d4870'], far: '#1e3a37', near: ['#183229', '#112820'], land: '#27345f', land2: '#202b52', rib: '#384a82', tree: ['#16422e', '#1c4e37'], trunk: '#2a2320', lot: '#252e48', stall: '#3c4868', stars: 18, dark: true },
    busy: { top: '#161b2e', bot: '#3a4157', cloud: ['#3d4459', '#4b5269'], rain: '#8b9cc6', far: '#1f3530', near: ['#1a2e26', '#13241e'], land: '#262f4a', land2: '#20283f', rib: '#36415f', tree: ['#1b3c2c', '#214634'], trunk: '#2a2320', lot: '#262c40', stall: '#3b4257', dark: true },
    full: { top: '#0c0f1d', bot: '#2a2e44', cloud: ['#262b40', '#32384f'], rain: '#9aa9d0', bolt: '#ffe066', far: '#1a2c27', near: ['#16261f', '#101d18'], land: '#1f263d', land2: '#191f33', rib: '#2d3654', tree: ['#173325', '#1c3c2c'], trunk: '#241e1b', lot: '#20253a', stall: '#353b52', dark: true },
  },
};

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** 올림픽공원 풍경(세계평화의문·KSPO DOME·주차장) — 고정 도형만 쓰는 장식용 SVG 문자열.
 *  주차장에 선 차의 수가 예상 이용률을 나타낸다. */
function skyScene(lv, night, ratio, bigShow) {
  const P = SCENE[night ? 'night' : 'day'][lv];
  const R = seededRandom(424);
  const o = ['<svg viewBox="0 0 2400 760" preserveAspectRatio="xMaxYMax slice" xmlns="http://www.w3.org/2000/svg" focusable="false">',
    `<defs><linearGradient id="skyG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.top}"/><stop offset="1" stop-color="${P.bot}"/></linearGradient>`,
    `<radialGradient id="glowG"><stop offset="0" stop-color="${P.sun || P.moon || '#ffd36b'}" stop-opacity=".55"/><stop offset="1" stop-color="${P.sun || P.moon || '#ffd36b'}" stop-opacity="0"/></radialGradient></defs>`,
    '<rect width="2400" height="760" fill="url(#skyG)"/>'];
  if (P.stars) {
    o.push('<g fill="#ffffff">');
    for (let i = 0; i < P.stars; i++) o.push(`<circle cx="${Math.round(380 + R() * 2000)}" cy="${Math.round(40 + R() * 360)}" r="${(0.8 + R() * 1.6).toFixed(1)}" opacity="${(0.35 + R() * 0.6).toFixed(2)}"/>`);
    o.push('</g>');
  }
  if (P.sun) o.push(`<circle class="sunglow" cx="2300" cy="170" r="150" fill="url(#glowG)"/><circle cx="2300" cy="170" r="${lv === 'free' ? 66 : 58}" fill="${P.sun}"/>`);
  if (P.moon) o.push(`<circle class="sunglow" cx="2300" cy="165" r="120" fill="url(#glowG)"/><circle cx="2300" cy="165" r="46" fill="${P.moon}"/><circle cx="2284" cy="151" r="8" fill="#000" opacity=".07"/><circle cx="2316" cy="179" r="11" fill="#000" opacity=".05"/>`);
  const cloud = (x, y, s, fill, cls) => `<g class="cloud ${cls}"><g transform="translate(${x} ${y}) scale(${s})" fill="${fill}"><circle cx="40" cy="40" r="26"/><circle cx="80" cy="30" r="34"/><circle cx="118" cy="44" r="22"/><rect x="14" y="40" width="128" height="26" rx="13"/></g></g>`;
  const clouds = {
    free: [[1960, 300, 0.8, 0, 'c1'], [2120, 80, 0.6, 1, 'c2'], [1250, 34, 0.7, 1, 'c3']],
    normal: [[1940, 255, 1.0, 0, 'c1'], [2190, 330, 0.8, 1, 'c2'], [2210, 120, 0.9, 0, 'c3'], [1300, 26, 0.8, 1, 'c1']],
    busy: [[1900, 150, 1.5, 1, 'c1'], [2120, 56, 1.7, 0, 'c2'], [2180, 250, 1.3, 1, 'c3'], [1250, 16, 1.2, 0, 'c2'], [1640, 36, 1.0, 1, 'c3']],
    full: [[1880, 110, 1.9, 1, 'c1'], [2120, 36, 2.1, 0, 'c2'], [2160, 232, 1.6, 1, 'c3'], [1200, 6, 1.5, 0, 'c2'], [1600, 16, 1.4, 1, 'c3']],
  }[lv];
  for (const [x, y, s, f, c] of clouds) o.push(cloud(x, y, s, P.cloud[f], c));
  if (P.rain) {
    o.push(`<g class="rain" stroke="${P.rain}" stroke-width="2.2" stroke-linecap="round" opacity="${lv === 'full' ? 0.75 : 0.55}">`);
    for (let i = 0, n = lv === 'full' ? 64 : 34; i < n; i++) {
      const x = Math.round(1900 + R() * 500);
      const y = Math.round(250 + R() * 220);
      o.push(`<line x1="${x}" y1="${y}" x2="${x - 6}" y2="${y + 20}"/>`);
    }
    o.push('</g>');
  }
  if (P.bolt) o.push(`<path class="bolt" d="M2040 262l-46 104h38l-30 92 84-128h-40l32-68z" fill="${P.bolt}"/>`);
  if (lv === 'free' && !night) o.push('<g stroke="#2d3c5a" stroke-width="3" fill="none" stroke-linecap="round" opacity=".5"><path d="M2040 232q9-9 18 0q9-9 18 0"/><path d="M2100 204q7-7 14 0q7-7 14 0"/><path d="M1996 196q6-6 12 0q6-6 12 0"/></g>');
  // 먼 언덕
  o.push(`<path d="M0 540C300 500 560 500 820 530C1080 560 1300 575 1560 540C1800 508 2050 480 2400 505V760H0Z" fill="${P.far}"/>`);
  for (const [x, y, r] of [[1230, 552, 12], [1262, 556, 15], [1296, 554, 11], [420, 520, 13], [452, 522, 10]]) o.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${P.tree[1]}" opacity=".7"/>`);
  // 대형 공연이 있는 날: 어두운 하늘엔 서치라이트, 밝은 하늘엔 깃발
  if (bigShow && P.dark) o.push('<g class="beams" fill="#ffe7a3" opacity=".1"><path d="M2150 480 1990 40h70z"/><path d="M2220 480 2380 60h-70z"/></g>');
  // 나홀로나무 언덕(올림픽공원의 상징 같은 풍경)
  o.push(`<path d="M1580 600C1650 552 1730 532 1810 530C1890 532 1970 552 2040 600Z" fill="${P.near[0]}"/>`
    + `<path d="M1803 534 1806 470h8l3 64z" fill="${P.trunk}"/>`
    + `<g fill="${P.tree[0]}"><circle cx="1810" cy="452" r="44"/><circle cx="1770" cy="470" r="30"/><circle cx="1850" cy="470" r="32"/><circle cx="1788" cy="428" r="30"/><circle cx="1834" cy="430" r="30"/></g>`
    + `<circle cx="1796" cy="436" r="17" fill="${P.tree[1]}" opacity=".8"/>`);
  // KSPO DOME
  o.push(`<rect x="2020" y="548" width="330" height="16" rx="5" fill="${P.land2}"/><path d="M2035 552C2060 462 2310 462 2335 552Z" fill="${P.land}"/>`
    + `<path d="M2185 487V552M2110 497C2117 515 2122 533 2124 552M2260 497C2253 515 2248 533 2246 552M2070 516C2080 528 2085 540 2088 552M2300 516C2290 528 2285 540 2282 552M2042 538H2328" stroke="${P.rib}" stroke-width="3" fill="none" stroke-linecap="round"/>`);
  if (bigShow && !P.dark) {
    o.push('<path d="M2060 500Q2185 452 2310 500" stroke="#8a94a8" stroke-width="1.5" fill="none"/>');
    const flags = ['#ff6a1a', '#ffb21e', '#1f3bd6', '#17935a', '#d03b3b', '#ffffff'];
    for (let i = 0; i < 11; i++) {
      const t = (i + 0.5) / 11;
      const x = 2060 + 250 * t;
      const y = (1 - t) ** 2 * 500 + 2 * (1 - t) * t * 452 + t * t * 500;
      o.push(`<path d="M${(x - 7).toFixed(1)} ${y.toFixed(1)}h14l-7 13z" fill="${flags[i % flags.length]}"/>`);
    }
  }
  // 가까운 언덕
  o.push(`<path d="M0 610C320 570 600 580 900 606C1200 632 1500 650 1800 612C2000 586 2200 570 2400 585V760H0Z" fill="${P.near[0]}"/>`);
  o.push(`<path d="M0 672C380 636 720 646 1040 668C1360 690 1760 706 2100 670C2240 656 2330 648 2400 652V760H0Z" fill="${P.near[1]}"/>`);
  for (const [x, base, r, c] of [[140, 600, 26, 0], [200, 596, 18, 1], [330, 590, 30, 0], [700, 594, 22, 1], [760, 598, 28, 0], [1120, 622, 24, 0], [1170, 624, 16, 1], [1420, 632, 26, 0], [1484, 632, 18, 1]]) {
    o.push(`<rect x="${x - 4}" y="${base - r}" width="8" height="${r}" fill="${P.trunk}"/><circle cx="${x}" cy="${base - r * 1.25}" r="${r}" fill="${P.tree[c]}"/>`);
  }
  // 주차장(동2·남2·북2문을 한데 그린 그림) — 24칸 중 이용률만큼 차가 선다
  o.push(`<rect x="2005" y="582" width="4" height="24" fill="#8a94a8"/><rect x="1996" y="560" width="22" height="22" rx="5" fill="#1f3bd6"/><path d="M2003 576v-11h5a3.4 3.4 0 0 1 0 6.8h-5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linejoin="round"/>`);
  o.push(`<rect x="2010" y="600" width="376" height="62" rx="12" fill="${P.lot}"/><path d="M2018 631H2378" stroke="${P.stall}" stroke-width="2" stroke-dasharray="10 8"/>`);
  o.push(`<g stroke="${P.stall}" stroke-width="2">`);
  for (let i = 0; i <= 12; i++) { const x = 2016 + i * 30; o.push(`<path d="M${x} 606v20M${x} 636v20"/>`); }
  o.push('</g>');
  const order = Array.from({ length: 24 }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const carColors = ['#ff6a1a', '#ffffff', '#1f3bd6', '#2b303b', '#ffb21e', '#d7dce4', '#17935a', '#d03b3b', '#7a8599'];
  const nCars = Math.max(1, Math.min(24, Math.round(ratio * 24)));
  for (const idx of order.slice(0, nCars)) {
    const x = 2016 + (idx % 12) * 30 + 4;
    const y = idx < 12 ? 608 : 638;
    o.push(`<rect x="${x}" y="${y}" width="22" height="16" rx="5" fill="${carColors[Math.floor(R() * carColors.length)]}"/><rect x="${x + 4}" y="${y + 3}" width="14" height="5" rx="2" fill="#0b1220" opacity=".25"/>`);
  }
  o.push('</svg>');
  return o.join('');
}

function renderHome() {
  const { now, ds, isToday, when } = heroDay();
  const fc = forecastFor(ds);
  const pk = remainingPeak(fc, isToday, now.min);
  const best = quietWindow(fc, isToday ? Math.ceil(now.min / 30) * 30 : null);
  const big = fc.shows.filter((s) => s.peakCars >= 150 && (!isToday || s.start + s.dur + 60 > now.min)).sort((a, b) => b.peakCars - a.peakCars)[0];
  renderHomeHero({ fc, pk, best, now, isToday, when, big });
  fillQuickPlan(ds);
  renderHomeChart(fc, isToday, when);
  renderHomeWeek(now.ds);
  renderHomeShows(now.ds, now.min);
  renderHomeStory();
}

function renderHomeHero({ fc, pk, best, now, isToday, when, big }) {
  const cap = STATE.model.capacity;
  const lv = pk.level;
  const night = currentTheme() === 'dark';
  const P = SCENE[night ? 'night' : 'day'][lv];
  const hero = $('#homeHero');
  hero.classList.toggle('dark', !!P.dark);
  hero.classList.toggle('day', !P.dark);
  hero.style.background = P.bot;
  hero.style.setProperty('--scrim', P.top);
  $('#heroScene').innerHTML = skyScene(lv, night, pk.ratio, !!big && big.peakCars >= 300); // 고정 도형만 포함(외부 문자열 없음)
  const d = parseYmd(fc.ds);
  $('#heroEyebrow').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일 · 올림픽공원 혼잡 예보`;
  const word = h('span', { class: 'lv-word', text: HERO_WORD[lv] });
  word.style.setProperty('--lv-color', lvColor(lv));
  const pre = lv === 'free' ? (isToday && now.min >= 9 * 60 ? '남은 시간 ' : '종일 ') : `${periodOf(pk.min)}에 `;
  $('#h-home').replaceChildren(`${when} 올림픽공원은`, h('br'), pre, word);

  const reach = pk.ratio >= 1 ? `수용 한계를 넘을(${pct(pk.ratio)})` : `이용률 ${pct(pk.ratio)}까지 오를`;
  let lead;
  if (big && lv !== 'free') lead = `${big.venue} ‘${shortTitle(big.title)}’(${fmtMin(big.start)}) 영향으로 ${fmtMin(pk.min)}쯤 주차장이 ${reach} 전망이에요.`;
  else if (big) lead = `${big.venue} ‘${shortTitle(big.title)}’(${fmtMin(big.start)}) 공연이 있지만 주차장은 여유로울 전망이에요.`;
  else if (lv === 'free') lead = `큰 공연이 없는 날이에요. 가장 붐비는 ${fmtMin(pk.min)}에도 주차장 이용률은 ${pct(pk.ratio)} 정도예요.`;
  else lead = `큰 공연은 없지만 ${fmtMin(pk.min)}쯤 주차장이 ${reach} 전망이에요.`;
  if (big && big.cls === 'A' && lv !== 'free') lead += ' 대중교통을 권해요.';
  if (isToday && fc.nowcast && Math.abs(fc.nowcast.delta) >= 150) {
    const dd = Math.round(fc.nowcast.delta);
    lead = `지금 평소보다 ${cars(Math.abs(dd))} ${dd > 0 ? '더' : '덜'} 차 있어요(실시간 반영). ${lead}`;
  }
  const w = STATE.weather?.daily?.[fc.ds];
  if (w && w.pmax >= 0.6) lead += ` 비 소식(강수확률 ${pct(w.pmax)})이 있어 나들이 수요를 낮춰 계산했어요.`;
  $('#heroLead').textContent = lead;

  const stats = [];
  if (STATE.live) stats.push(['지금 주차', STATE.live.value.toLocaleString(), `대 · ${pct(STATE.live.value / cap)}`]);
  else {
    const s = forecastFor(now.ds).slots[Math.min(47, Math.floor(now.min / 30))];
    stats.push(['지금 예상', Math.round(s.final).toLocaleString(), `대 · ${pct(s.ratio)}`]);
  }
  stats.push([isToday ? '가장 붐비는 시간' : '내일 가장 붐빌 때', fmtMin(pk.min), pct(pk.ratio)]);
  const avoid = rangesFrom(fc, 'busy', isToday ? now.min : null)[0];
  if ((lv === 'busy' || lv === 'full') && avoid) {
    const from = isToday ? Math.max(avoid.start, Math.floor(now.min / 30) * 30) : avoid.start;
    stats.push(['피하면 좋은 시간', rangeShort(from, avoid.end), `최대 ${pct(avoid.peak / cap)}`]);
  } else stats.push([best && best.calm ? '한산한 시간' : '덜 붐비는 시간', best ? rangeShort(best.start, best.end) : '—', best ? `평균 ${pct(best.avg / cap)}` : '']);
  $('#heroStats').replaceChildren(...stats.map(([k, v, s]) => h('li', {}, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v, s ? h('small', { text: s }) : null))));
}

function setupQuickPlan() {
  const form = $('#quickPlan');
  form.addEventListener('change', (e) => { if (e.target.id === 'qpDate') fillQpShows(); syncQuickPlan(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const purpose = $('#qpPurpose').value;
    const parts = ['plan', $('#qpDate').value, purpose, 'car'];
    if (purpose === 'show' && $('#qpShow').value) parts.push($('#qpShow').value);
    location.hash = parts.join('/');
  });
}

function fillQuickPlan(defaultDs) {
  const sel = $('#qpDate');
  if (sel.options.length) return; // 처음 한 번만(사용자가 고른 값 유지)
  const today = nowKST().ds;
  for (let i = 0; i < 30; i++) {
    const ds = addDays(today, i);
    const n = new Set(STATE.fc.showsOn(ds).map((s) => s.evtSeq)).size;
    sel.append(h('option', { value: ds, text: `${mdLabel(ds)}${i === 0 ? ' 오늘' : i === 1 ? ' 내일' : ''}${n ? ` · 공연 ${n}건` : ''}` }));
  }
  sel.value = defaultDs;
  fillQpShows();
  if (!$('#qpShow').value) $('#qpPurpose').value = 'walk';
  syncQuickPlan();
}

function fillQpShows() {
  const sel = $('#qpShow');
  sel.replaceChildren();
  const shows = STATE.fc.showsOn($('#qpDate').value).sort((a, b) => b.peakCars - a.peakCars || a.start - b.start);
  if (!shows.length) sel.append(h('option', { value: '', text: '이날은 공연이 없어요' }));
  for (const s of shows) sel.append(h('option', { value: `${s.evtSeq}-${s.start}`, text: `${fmtMin(s.start)} ${s.venue} · ${shortTitle(s.title)}` }));
}

function syncQuickPlan() {
  const show = $('#qpPurpose').value === 'show';
  $('#qpShowField').hidden = !show;
  $('#quickPlan').classList.toggle('no-show', !show);
}

function renderHomeChart(fc, isToday, when) {
  const cap = STATE.model.capacity;
  $('#h-today').replaceChildren(`${when}, `, h('em', { text: '몇 시' }), '가 붐빌까요?');
  $('#homeChartSub').textContent = `${mdLabel(fc.ds)} · 동2·남2·북2문 주차장(${cap.toLocaleString()}면) 예상 이용률 · 30분 단위${isToday && fc.nowcast ? ' · 실시간 보정 반영' : ''}`;
  $('#homeLegend').replaceChildren(...levelLegendItems());
  $('#homeMore').href = `#forecast/${fc.ds}`;
  forecastColumns($('#homeChart'), {
    slots: fc.slots, cap, from: 6, to: 24, nowMin: isToday ? nowKST().min : null, colorOf: (s) => lvColor(s.level), tooltip: slotTooltip(fc, isToday),
    ariaLabel: `${mdLabel(fc.ds)} 시간대별 주차장 예상 이용률. 최대 ${fmtMin(fc.peak.min)} ${pct(fc.peak.ratio)}. 자세한 값은 혼잡 예보 화면의 표로 보기에서 확인할 수 있습니다.`,
  });
}

function renderHomeWeek(today) {
  const box = $('#homeWeek');
  box.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const ds = addDays(today, i);
    const fc = forecastFor(ds);
    const d = parseYmd(ds);
    const pk = i === 0 ? remainingPeak(fc, true, nowKST().min) : fc.peak;
    const weekend = d.getDay() === 0 || d.getDay() === 6 || STATE.fc.isHoliday(ds);
    const top = [...fc.shows].sort((a, b) => b.peakCars - a.peakCars)[0];
    const ev = top && top.peakCars >= 60 ? shortTitle(top.title) : '';
    box.append(h('a', {
      class: `week-card${i === 0 ? ' today' : ''}`, href: `#forecast/${ds}`,
      'aria-label': `${mdLabel(ds)} ${i === 0 ? '남은 시간 ' : ''}최대 ${LEVEL_LABEL[pk.level]}, ${fmtMin(pk.min)} ${pct(pk.ratio)}${ev ? `, ${ev}` : ''}`,
    },
    h('span', { class: `wd${weekend ? ' weekend' : ''}`, text: i === 0 ? '오늘' : i === 1 ? '내일' : `${DOW[d.getDay()]}요일` }),
    h('span', { class: 'dt', text: `${d.getMonth() + 1}.${d.getDate()}` }),
    h('span', { class: 'ic' }, levelIcon(pk.level, 54)),
    h('span', { class: 'lvname', text: LEVEL_LABEL[pk.level] }),
    h('span', { class: 'pk', text: `최대 ${pct(pk.ratio)} · ${fmtMin(pk.min)}` }),
    h('span', { class: 'evname', text: ev || '대형 공연 없음' })));
  }
}

function renderHomeShows(today, nowMin) {
  const list = $('#homeShows');
  list.replaceChildren();
  const rows = [];
  const seen = new Set(); // 같은 공연은 가장 가까운 날 한 줄만
  for (let i = 0; i < 60 && rows.length < 6; i++) {
    const ds = addDays(today, i);
    for (const s of STATE.fc.showsOn(ds).sort((a, b) => a.start - b.start)) {
      if (rows.length >= 6) break;
      if (seen.has(s.evtSeq) || s.peakCars < 60 || (ds === today && s.start + s.dur < nowMin)) continue;
      seen.add(s.evtSeq);
      rows.push({ ds, s });
    }
  }
  if (!rows.length) {
    list.append(h('li', { class: 'empty', text: '앞으로 60일 동안 주차에 영향이 큰 공연이 없어요.' }));
    return;
  }
  const maxCars = Math.max(...rows.map((r) => r.s.peakCars));
  const peakOf = new Map();
  for (const { ds, s } of rows) {
    if (!peakOf.has(ds)) peakOf.set(ds, forecastFor(ds).peak);
    const pk = peakOf.get(ds);
    const d = parseYmd(ds);
    const bar = h('i');
    bar.style.width = `${Math.max(4, (s.peakCars / maxCars) * 100)}%`;
    bar.style.background = 'var(--brand)';
    list.append(h('li', {}, h('a', { class: 'show-row', href: `#plan/${ds}/show/car/${s.evtSeq}-${s.start}`, title: `${s.title} — 추천 동선 보기` },
      h('span', { class: 'when' }, h('b', { text: `${d.getMonth() + 1}.${pad(d.getDate())}` }), h('span', { text: `${DOW[d.getDay()]}요일 · ${fmtMin(s.start)}` })),
      h('span', { class: 'what' }, h('span', { class: 'meta' }, h('span', { text: s.venueInfo.label }), clsBadge(s.cls), runLabel(s.evtSeq, ds)), h('strong', { text: shortTitle(s.title) })),
      h('span', { class: 'impact' }, h('span', { class: 'bar', 'aria-hidden': 'true' }, bar),
        h('span', {}, '주차 수요 최대 ', h('b', { text: `+${cars(s.peakCars)}` }), h('span', { class: `badge ${pk.level}` }, levelIcon(pk.level, 14), `이날 ${LEVEL_LABEL[pk.level]}`))),
      h('span', { class: 'go', 'aria-hidden': 'true', text: '→' }))));
  }
}

/** 여러 날 하는 공연: 4일 이하면 'N일 공연', 길면 마지막 날짜 */
function runLabel(evtSeq, fromDs) {
  const dates = Object.keys(STATE.events.byDate).filter((d) => d >= fromDs && STATE.events.byDate[d].some((s) => s.evtSeq === evtSeq)).sort();
  if (dates.length < 2) return null;
  const last = parseYmd(dates[dates.length - 1]);
  return h('span', { text: dates.length <= 4 ? `${dates.length}일 공연` : `${last.getMonth() + 1}.${pad(last.getDate())}까지` });
}

function renderHomeStory() {
  const md = STATE.model;
  const bt = md.backtest;
  const seats = 15; // KSPO DOME 15,000석
  const [a, b, c] = ['A', 'B', 'C'].map((k) => Math.round(md.eventCoef[k] * seats));
  $('#storyLead').textContent = `똑같이 KSPO DOME 1만 5천 석을 채운 공연이라도, 중장년 팬이 많은 공연은 10~20대 팬덤 공연보다 주차 수요가 ${(a / b).toFixed(1)}배 커요. 올팍캐스트는 실제 입출차 기록으로 이 차이를 학습해 예보합니다.`;
  const bars = h('div', { class: 'story-bars', role: 'img', 'aria-label': `KSPO DOME 공연 1회 추가 주차 수요: 자가용 집중형 ${a}대, 혼합형 ${c}대, 대중교통 중심형 ${b}대` },
    [['자가용 집중형', a], ['혼합형', c], ['대중교통 중심형', b]].map(([n, v], i) => {
      const bar = h('i', { class: i ? 'b' : null });
      bar.style.width = `${(v / a) * 100}%`;
      return h('div', { 'aria-hidden': 'true' }, h('span', { text: n }), h('span', {}, bar), h('b', { text: `+${v.toLocaleString()}` }));
    }));
  $('#homeStory').replaceChildren(
    h('div', {}, h('span', { class: 'k', text: '분석한 입출차 기록' }), h('span', { class: 'v' }, STATE.insights.records.toLocaleString(), h('small', { text: '건' })),
      h('span', { class: 'd', text: '2024년 7월 올림픽공원 입출차 정보로 30분 단위 주차장 점유를 복원했어요.' })),
    h('div', {}, h('span', { class: 'k', text: 'KSPO DOME 공연 1회가 더하는 주차' }), h('span', { class: 'v' }, `+${a.toLocaleString()}`, h('small', { text: '대' })), bars),
    h('div', {}, h('span', { class: 'k', text: '예보 평균 오차' }), h('span', { class: 'v' }, bt.model_all.mae_pct_capacity.toFixed(1), h('small', { text: '%' })),
      h('span', { class: 'd', text: `수용량 대비 · 공연을 반영하지 않은 기준선보다 오차 ${Math.round((1 - bt.model_all.mae_cars / bt.baseline_all.mae_cars) * 100)}% 감소(${bt.model_all.days}일 교차검증)` })));
}

// ---------------------------------------------------------------- 혼잡 예보
function renderForecast() {
  const today = nowKST().ds;
  if (!STATE.date) STATE.date = today;
  const ds = STATE.date;
  const fc = forecastFor(ds);
  renderDateStrip(today, ds);
  renderHero(fc, today);
  renderLive(fc, today);
  renderForecastChart(fc, today);
  renderDayShows(fc);
  renderTips(fc);
  renderWeek(today);
}

function renderDateStrip(today, sel) {
  const strip = $('#dateStrip');
  strip.replaceChildren();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  if (!days.includes(sel)) days.push(sel);
  for (const ds of days) {
    const d = parseYmd(ds);
    const pk = forecastFor(ds).peak;
    const label = ds === today ? '오늘' : ds === addDays(today, 1) ? '내일' : `${DOW[d.getDay()]}요일`;
    const weekend = d.getDay() === 0 || d.getDay() === 6 || STATE.fc.isHoliday(ds);
    strip.append(h('button', {
      class: `date-chip${weekend ? ' weekend' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(ds === sel),
      onclick: () => { location.hash = `forecast/${ds}`; },
    }, h('span', { class: 'd', text: label }), h('span', { class: 'n', text: `${d.getMonth() + 1}.${d.getDate()}` }),
    h('span', { class: 'lv' }, levelIcon(pk.level, 14), LEVEL_LABEL[pk.level])));
  }
  const selChip = strip.querySelector('[aria-selected="true"]');
  if (selChip) strip.scrollLeft = Math.max(0, selChip.offsetLeft - strip.clientWidth / 2 + selChip.offsetWidth / 2);
}

function renderHero(fc, today) {
  const card = $('#heroCard');
  card.replaceChildren();
  const isToday = fc.ds === today;
  const pk = remainingPeak(fc, isToday, nowKST().min);
  const when = fc.ds === today ? '오늘' : fc.ds === addDays(today, 1) ? '내일' : mdLabel(fc.ds);
  const fromMin = isToday ? Math.ceil(nowKST().min / 30) * 30 : null;
  const best = quietWindow(fc, fromMin);
  const busy = rangesFrom(fc, 'busy', isToday ? nowKST().min : null);
  const top = h('div', { class: 'hero-top' },
    h('div', { class: `hero-icon ${pk.level}` }, levelIcon(pk.level, 44)),
    h('div', {},
      h('p', { class: 'hero-kicker', text: `${when} 올림픽공원 혼잡 예보${when === mdLabel(fc.ds) ? '' : ` · ${mdLabel(fc.ds)}`}` }),
      h('h2', { class: 'hero-title' }, isToday ? '남은 시간 최대 ' : '최대 ', levelBadge(pk.level), ` ${fmtMin(pk.min)}쯤 ${pct(pk.ratio)}`)));
  const facts = h('dl', { class: 'hero-facts' },
    h('div', {}, h('dt', { text: '가장 붐비는 시간' }), h('dd', { text: fmtMin(pk.min) })),
    h('div', {}, h('dt', { text: best && best.calm ? '한산한 시간' : '덜 붐비는 시간' }), h('dd', { text: best ? `${fmtMin(best.start)}~${fmtMin(best.end)}` : '—' })),
    h('div', {}, h('dt', { text: '혼잡 시간대' }), h('dd', { text: busy.length ? busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).slice(0, 2).join(', ') : '없음' })));
  const bigShows = fc.shows.filter((s) => s.peakCars >= 150).sort((a, b) => b.peakCars - a.peakCars);
  let note;
  if (bigShows.length) {
    const s = bigShows[0];
    note = `${s.venue}에서 ‘${s.title}’ 공연(${fmtMin(s.start)})이 있어 공연 전후로 주차 수요가 최대 ${cars(s.peakCars)}가량 늘어날 전망이에요.`;
  } else if (fc.shows.length) {
    note = `소규모 공연 ${fc.shows.length}회가 있지만 주차 영향은 크지 않을 전망이에요.`;
  } else {
    note = '대형 공연이 없는 날이에요. 평소 패턴대로 오전 10~11시에 가장 붐벼요.';
  }
  if (isToday && fc.nowcast && Math.abs(fc.nowcast.delta) >= 150) {
    const d = Math.round(fc.nowcast.delta);
    note = `지금 주차장이 평소 이 시각보다 ${cars(Math.abs(d))} ${d > 0 ? '더 차 있어요' : '덜 차 있어요'}(실시간 ${cars(fc.nowcast.value)}). 남은 시간 예보에 반영했어요. ` + (bigShows.length ? note : '');
  }
  const w = STATE.weather?.daily?.[fc.ds];
  if (w && w.pmax >= 0.6) note += ` 비 예보(강수확률 ${pct(w.pmax)})가 있어 나들이 수요를 낮춰 계산했어요.`;
  card.append(top, facts, h('p', { class: 'hero-note', text: note }));
}

function renderLive(fc, today) {
  const card = $('#liveCard');
  card.replaceChildren();
  const cap = STATE.model.capacity;
  const head = h('div', { class: 'live-head' },
    h('h2', { class: 'card-title' }, h('span', { class: `live-dot${STATE.live ? '' : ' off'}` }), '지금 주차 현황'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '실시간 정보 새로고침', title: '새로고침', onclick: async () => { await fetchLive(); renderForecast(); updateLivePill(); } }, '↻'));
  card.append(head);
  if (!STATE.live) {
    card.append(h('p', { class: 'card-sub', text: `실시간 주차현황을 불러오지 못했어요${STATE.liveError ? ` (${STATE.liveError})` : ''}. 예보는 과거 데이터로 계산한 값입니다.` }));
    return;
  }
  const r = STATE.live.value / cap;
  const lv = levelOf(r);
  const meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(cap), 'aria-valuenow': String(STATE.live.value), 'aria-label': '주차장 이용률' });
  const fill = h('span');
  fill.style.width = `${Math.min(100, r * 100)}%`;
  fill.style.background = lvColor(lv);
  meter.append(fill);
  const t = STATE.live.at;
  card.append(
    h('div', { class: 'live-num' }, STATE.live.value.toLocaleString(), h('small', { text: `/ ${cap.toLocaleString()}대` })),
    h('div', {}, levelBadge(lv, `이용률 ${pct(r)}`)),
    meter,
    h('div', { class: 'meter-scale' }, h('span', { text: '0' }), h('span', { text: '50%' }), h('span', { text: '70%' }), h('span', { text: '90%' }), h('span', { text: '100%' })),
  );
  const fcToday = fc.ds === today ? fc : forecastFor(today);
  const nc = fcToday.nowcast;
  let msg = `동2·남2·북2문 주차장 기준, ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')} 갱신(5분마다 자동).`;
  if (nc) {
    const diff = Math.round(nc.delta);
    if (Math.abs(diff) >= 150) msg += ` 평소 이 시각 예상(${cars(nc.predNow)})보다 ${cars(Math.abs(diff))} ${diff > 0 ? '많아요 — 오늘 남은 시간 예보를 높여서 보정했어요.' : '적어요 — 남은 시간 예보를 낮춰서 보정했어요.'}`;
    else msg += ' 평소 예상과 비슷한 수준이에요.';
  }
  card.append(h('p', { class: 'card-sub', text: msg }));
  if (r >= 0.9) card.append(h('p', { class: 'callout warn', text: '지금은 주차장이 거의 찼어요. 남3문(소마미술관 지하)·남4문·서2문(올림픽파크텔) 주차장이나 대중교통을 이용하세요.' }));
}

function renderForecastChart(fc, today) {
  const isToday = fc.ds === today;
  $('#chartTitle').textContent = `${isToday ? '오늘' : mdLabel(fc.ds)} 시간대별 혼잡 예보`;
  $('#chartSub').textContent = `동2·남2·북2문 주차장(${STATE.model.capacity.toLocaleString()}면) 예상 이용률 · 30분 단위${isToday && fc.nowcast ? ' · 실시간 보정 반영' : ''}`;
  $('#levelLegend').replaceChildren(...levelLegendItems());
  forecastColumns($('#forecastChart'), {
    slots: fc.slots, cap: STATE.model.capacity, from: 6, to: 24,
    nowMin: isToday ? nowKST().min : null, colorOf: (s) => lvColor(s.level), tooltip: slotTooltip(fc, isToday),
    ariaLabel: `${mdLabel(fc.ds)} 시간대별 주차장 예상 이용률. 최대 ${fmtMin(fc.peak.min)} ${pct(fc.peak.ratio)}. 표로 보기에서 전체 값을 확인할 수 있습니다.`,
  });
  const rows = fc.slots.filter((s) => s.min >= 360).map((s) => h('tr', {},
    h('td', { text: `${fmtMin(s.min)}~${fmtMin(s.min + 30)}` }), h('td', { class: 'num', text: Math.round(s.final).toLocaleString() }),
    h('td', { class: 'num', text: pct(s.ratio) }), h('td', { text: LEVEL_LABEL[s.level] }), h('td', { class: 'num', text: s.event >= 1 ? `+${Math.round(s.event).toLocaleString()}` : '' })));
  $('#forecastTable').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: '시간' }), h('th', { class: 'num', text: '예상 대수' }), h('th', { class: 'num', text: '이용률' }), h('th', { text: '단계' }), h('th', { class: 'num', text: '공연 영향' }))), h('tbody', {}, rows)));
}

function venueTransit(venue) {
  return venue === 'KSPO DOME' ? '5·9호선 올림픽공원역 3번 출구' : '5·9호선 올림픽공원역 3·4번 출구';
}

function renderDayShows(fc) {
  const box = $('#dayShows');
  box.replaceChildren();
  if (!fc.shows.length) {
    box.append(h('div', { class: 'empty', text: '이날 예정된 공연·행사가 없어요. (올림픽공원 공연정보 기준)' }));
    return;
  }
  // 같은 공연의 여러 회차는 묶는다
  const groups = new Map();
  for (const s of fc.shows) {
    const g = groups.get(s.evtSeq) || { ...s, starts: [] };
    g.starts.push(s.start);
    groups.set(s.evtSeq, g);
  }
  for (const g of [...groups.values()].sort((a, b) => b.peakCars - a.peakCars)) {
    const main = fc.shows.find((s) => s.evtSeq === g.evtSeq && s.start === g.starts[g.starts.length - 1]);
    const adv = STATE.fc.arrivalAdvice(fc, main);
    const advText = adv.kind === 'full' ? `자가용은 ${fmtMin(adv.arriveBy)} 전 도착 권장 (${fmtMin(adv.fullAt)}경 만차 위험)`
      : adv.kind === 'busy' ? `자가용은 ${fmtMin(adv.arriveBy)} 전 도착 권장 (${fmtMin(adv.busyAt)}경 혼잡)`
        : '주차 여유 — 공연 1시간 전 도착이면 충분';
    box.append(h('div', { class: 'show' },
      h('div', { class: 'show-top' }, h('span', { text: g.venueInfo.label }), clsBadge(g.cls)),
      h('a', { class: 'show-title', href: g.url, target: '_blank', rel: 'noopener', text: g.title }),
      h('div', { class: 'show-meta' },
        h('span', {}, '시작 ', h('b', { text: g.starts.map(fmtMin).join(', ') })),
        h('span', {}, '주차 수요 ', h('b', { text: `최대 +${cars(g.peakCars)}` })),
        h('span', {}, '지하철 ', h('b', { text: venueTransit(g.venue) }))),
      h('div', { class: 'show-meta' }, h('span', { text: advText }))));
  }
}

function renderTips(fc) {
  const ul = $('#dayTips');
  ul.replaceChildren();
  const tips = [];
  const now = nowKST();
  const fromMin = fc.ds === now.ds ? Math.ceil(now.min / 30) * 30 : null;
  const best = quietWindow(fc, fromMin);
  const busy = STATE.fc.busyRanges(fc, 'busy').filter((b) => fromMin == null || b.end > fromMin);
  const big = fc.shows.filter((s) => s.peakCars >= 300).sort((a, b) => b.peakCars - a.peakCars)[0];
  if (big) {
    const end = big.start + big.dur;
    tips.push(['🚇', `대형 공연일이에요. ${big.cls === 'A' ? '자가용 관객이 많은 공연이라 ' : ''}대중교통(${venueTransit(big.venue)})을 이용하세요.`]);
    tips.push(['↗', `공연이 끝나는 ${fmtMin(end)} 무렵부터 30~60분은 출차·지하철이 붐벼요. 8호선은 몽촌토성역(1번 출구), 9호선은 한성백제역(2번 출구)을 이용하면 올림픽공원역 혼잡을 피할 수 있어요.`]);
  }
  if (busy.length) tips.push(['!', `${busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(', ')}에는 차량 방문을 피하세요(이용률 70% 이상 예상).`]);
  if (best && best.calm) tips.push(['☀', `산책·나들이는 ${fmtMin(best.start)}~${fmtMin(best.end)}가 가장 한산해요(평균 ${pct(best.avg / STATE.model.capacity)}).`]);
  else if (best) tips.push(['☁', `남은 시간은 계속 붐벼요. 그나마 ${fmtMin(best.start)}~${fmtMin(best.end)}가 덜 붐벼요(평균 ${pct(best.avg / STATE.model.capacity)}).`]);
  const lots = Object.entries(STATE.model.lotFullShare).filter(([k]) => STATE.model.lots[k]).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([k]) => `${k}(${STATE.model.lots[k].gate})`);
  tips.push(['P', `만차 기록이 적은 주차구역: ${lots.join(', ')} — 주차장 혼잡도 기록 분석 결과예요.`]);
  tips.push(['♿', '휠체어 이용 시 동2문으로 들어와 그래피티의 벽 주차장에 주차하면 올림픽공원역 방향 경사로로 만남의광장에 바로 갈 수 있어요.']);
  for (const [ic, t] of tips) ul.append(h('li', {}, h('span', { class: 'tip-ic', 'aria-hidden': 'true', text: ic }), h('span', { text: t })));
}

function renderWeek(today) {
  const box = $('#weekOutlook');
  box.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const ds = addDays(today, i);
    const fc = forecastFor(ds);
    const d = parseYmd(ds);
    const names = [...new Map(fc.shows.map((s) => [s.evtSeq, s])).values()].sort((a, b) => b.peakCars - a.peakCars).map((s) => s.title);
    const row = h('button', { class: 'week-row', type: 'button', onclick: () => { location.hash = `forecast/${ds}`; window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      h('span', { class: 'wd' }, i === 0 ? '오늘' : `${DOW[d.getDay()]}요일`, h('small', { text: `${d.getMonth() + 1}월 ${d.getDate()}일` })),
      h('span', {}, h('span', { class: 'ev', text: names.length ? names.slice(0, 2).join(' · ') : '대형 공연 없음' })),
      levelBadge(fc.peak.level, `${fmtMin(fc.peak.min)}`));
    const mid = row.children[1];
    mid.className = 'mid';
    sparkBars(mid, fc.slots.filter((s) => s.min >= 360), STATE.model.capacity, (s) => lvColor(s.level));
    box.append(row);
  }
}

// ---------------------------------------------------------------- 방문 플래너
function addDateOption(ds, isToday) {
  const n = new Set(STATE.fc.showsOn(ds).map((s) => s.evtSeq)).size;
  $('#planDate').append(h('option', { value: ds, text: `${mdLabel(ds)}${isToday ? ' 오늘' : ''}${n ? ` · 공연 ${n}건` : ''}` }));
}

/** 공유 링크 형식: #plan/날짜/목적/이동수단/공연번호-시작분 */
function renderPlan(args = []) {
  const today = nowKST().ds;
  const dateSel = $('#planDate');
  if (!dateSel.options.length) {
    for (let i = 0; i < 45; i++) addDateOption(addDays(today, i), i === 0);
    const firstShow = Array.from(dateSel.options).find((o) => STATE.fc.showsOn(o.value).some((s) => s.peakCars >= 300));
    if (firstShow) dateSel.value = firstShow.value;
    $('#planForm').addEventListener('change', (e) => { if (e.target.id === 'planDate') fillShows(); computePlan(); });
    fillShows();
  }
  const [ds, purpose, mode, showKey] = args;
  if (ds && /^\d{4}-\d{2}-\d{2}$/.test(ds) && ds >= today) {
    if (![...dateSel.options].some((o) => o.value === ds)) addDateOption(ds, false);
    dateSel.value = ds;
    fillShows();
  }
  if (purpose && PURPOSE_LABEL[purpose]) {
    const r = document.querySelector(`input[name="purpose"][value="${purpose}"]`);
    if (r) r.checked = true;
  }
  if (mode === 'car' || mode === 'transit') $('#planMode').value = mode;
  if (showKey) {
    const v = showKey.replace('-', '|');
    if ([...$('#planShow').options].some((o) => o.value === v)) $('#planShow').value = v;
  }
  computePlan();
}

function planHash() {
  const purpose = new FormData($('#planForm')).get('purpose');
  const parts = ['plan', $('#planDate').value, purpose, $('#planMode').value];
  if (purpose === 'show' && $('#planShow').value) parts.push($('#planShow').value.replace('|', '-'));
  return `#${parts.join('/')}`;
}

// ---------------------------------------------------------------- 캘린더 파일(.ics)
function icsDate(ds, min) { // 한국 시간(UTC+9, 서머타임 없음) → UTC
  const [y, m, d] = ds.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + (min - 540) * 60000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00Z`;
}
function icsEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) { // RFC 5545: 한 줄 75바이트 이하(여기서는 73바이트로 접음)
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > 73) { out.push(cur); cur = ` ${ch}`; bytes = 1 + b; } else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.join('\r\n');
}
function buildIcs(ev) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OlParkCast//Olympic Park crowd forecast//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(ev.ds, ev.start)}`, `DTEND:${icsDate(ev.ds, ev.end)}`,
    `SUMMARY:${icsEsc(ev.summary)}`, `LOCATION:${icsEsc(ev.location)}`, `DESCRIPTION:${icsEsc(ev.description)}`, `URL:${ev.url}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(ev.alarm)}`, `TRIGGER:-PT${ev.alarmMin}M`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'];
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

async function sharePlan(title) {
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  toast((await copyText(url)) ? '링크를 복사했어요. 메신저에 붙여 넣어 공유하세요.' : `이 주소를 복사해 공유하세요: ${url}`);
}

function fillShows() {
  const ds = $('#planDate').value;
  const sel = $('#planShow');
  sel.replaceChildren();
  const shows = STATE.fc.showsOn(ds).sort((a, b) => b.peakCars - a.peakCars || a.start - b.start);
  if (!shows.length) sel.append(h('option', { value: '', text: '이날은 공연이 없어요' }));
  for (const s of shows) sel.append(h('option', { value: `${s.evtSeq}|${s.start}`, text: `${fmtMin(s.start)} ${s.venue} — ${s.title}` }));
}

function computePlan() {
  const purpose = new FormData($('#planForm')).get('purpose');
  const ds = $('#planDate').value;
  const mode = $('#planMode').value;
  $('#planShowField').hidden = purpose !== 'show';
  const fc = forecastFor(ds);
  const out = $('#planResult');
  out.replaceChildren();
  const cap = STATE.model.capacity;
  const steps = [];
  let headline = '';
  let sub = '';
  let planEvent = null; // 캘린더에 넣을 일정
  const parkLoc = '올림픽공원(서울 송파구 올림픽로 424)';
  const lotsLow = Object.entries(STATE.model.lotFullShare).filter(([k]) => STATE.model.lots[k]).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([k]) => k);
  const lotChip = (k) => h('span', { class: 'lot' }, k, h('small', { text: `${STATE.model.lots[k]?.gate || ''}${STATE.model.lotFullShare[k] != null ? ` · 만차기록 ${pct(STATE.model.lotFullShare[k])}` : ''}` }));
  const outside = '남3문(소마미술관 지하)·남4문·서1문·서2문(올림픽파크텔) 주차장';

  if (purpose === 'show') {
    const [seq, st] = ($('#planShow').value || '|').split('|');
    const show = fc.shows.find((s) => String(s.evtSeq) === seq && String(s.start) === st);
    if (!show) {
      out.append(h('article', { class: 'card' }, h('p', { class: 'empty', text: '선택한 날짜에 공연이 없어요. 날짜를 바꿔 보세요.' })));
      return;
    }
    const end = show.start + show.dur;
    const adv = STATE.fc.arrivalAdvice(fc, show);
    if (mode === 'car') {
      headline = adv.kind === 'ok' ? `${fmtMin(adv.arriveBy)}까지 도착하면 충분해요` : `${fmtMin(adv.arriveBy)} 전에 도착하세요`;
      sub = adv.kind === 'full' ? `${fmtMin(adv.fullAt)}쯤 주차장이 90% 이상 찰 것으로 예상돼요. 가능하면 대중교통을 이용하세요.` : adv.kind === 'busy' ? `${fmtMin(adv.busyAt)}부터 혼잡(70% 이상)이 예상돼요.` : '공연 전후에도 주차 여유가 있을 전망이에요.';
      steps.push(['도착 시간', `${fmtMin(adv.arriveBy)} 이전 도착 권장. 공연 시작은 ${fmtMin(show.start)}, 예상 종료는 ${fmtMin(end)}이에요.`]);
      steps.push(['출입문·주차장', h('span', {}, `${show.venueInfo.label}와 가까운 출입문은 ${show.venueInfo.gates.join('·')}, 가까운 주차구역은 `, ...show.venueInfo.lots.map(lotChip), '. 만차 기록이 적은 구역: ', ...lotsLow.map(lotChip))]);
      steps.push(['만차일 때', `${outside}을 이용하세요. 대형 공연일에는 선불·사전정산·일주차권이 없고 관람권 할인도 없어요(소형 10분당 600원, 하루 최대 20,000원).`]);
      steps.push(['귀가', `공연 종료(${fmtMin(end)}) 직후 30~60분은 출차가 몰려요. 20~30분 여유를 두고 출차하면 대기가 줄어요.`]);
      planEvent = {
        start: adv.arriveBy, end: show.start, summary: `올림픽공원 도착 목표 · ${show.title}`,
        location: `${show.venueInfo.label}, ${parkLoc}`,
        description: [`공연 시작 ${fmtMin(show.start)} · 예상 종료 ${fmtMin(end)}`, sub,
          `가까운 출입문 ${show.venueInfo.gates.join('·')} / 주차구역 ${show.venueInfo.lots.join('·')} / 만차 기록이 적은 구역 ${lotsLow.join('·')}`,
          `만차 시: ${outside}`, '귀가: 종료 직후 30~60분은 출차가 몰려요.'].join('\n'),
      };
    } else {
      const arrive = show.start - (show.cls === 'B' ? 90 : 60);
      headline = `${fmtMin(arrive)}쯤 도착을 권장해요`;
      sub = show.cls === 'B' ? '팬덤 공연은 입장 대기·MD 구매로 일찍 붐벼요.' : '입장 대기를 고려해 여유 있게 도착하세요.';
      steps.push(['지하철', `${venueTransit(show.venue)}이 가장 가까워요.`]);
      steps.push(['버스', '동1문(올림픽공원역) 정류장: 3214·3220·3319·3412·3413, 경기 30-5 등']);
      steps.push(['귀가 분산', `공연 종료(${fmtMin(end)}) 직후 올림픽공원역에 관객이 몰려요. 8호선은 몽촌토성역(1번 출구), 9호선은 한성백제역(2번 출구)으로 걸어가면 승강장 혼잡을 피할 수 있어요.`]);
      planEvent = {
        start: arrive, end: show.start, summary: `올림픽공원 도착 · ${show.title}`,
        location: `${show.venueInfo.label}, ${parkLoc}`,
        description: [`공연 시작 ${fmtMin(show.start)} · 예상 종료 ${fmtMin(end)}`, sub, `지하철: ${venueTransit(show.venue)}`,
          '귀가 분산: 8호선 몽촌토성역(1번 출구), 9호선 한성백제역(2번 출구)'].join('\n'),
      };
    }
  } else {
    const ranges = { walk: [7, 20], sports: [6, 22], kids: [9, 18] }[purpose];
    const nowMin = ds === nowKST().ds ? Math.ceil(nowKST().min / 30) * 30 : null;
    const best = quietWindow(fc, nowMin, ranges[0], ranges[1]);
    const busy = rangesFrom(fc, 'normal', nowMin);
    headline = !best ? '오늘은 방문 가능한 시간이 지났어요' : best.calm ? `${fmtMin(best.start)}~${fmtMin(best.end)}이 가장 한산해요` : `${fmtMin(best.start)}~${fmtMin(best.end)}이 그나마 덜 붐벼요`;
    sub = best ? `이 시간대 예상 이용률 평균 ${pct(best.avg / cap)} (${LEVEL_LABEL[best.level]})${best.calm ? '' : ' — 다른 날을 고려해 보세요'}` : '';
    if (busy.length) steps.push(['피하면 좋은 시간', `${busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(', ')} (이용률 50% 이상 예상)`]);
    const subway = '8호선 몽촌토성역 1번 출구(세계평화의문·몽촌토성), 5·9호선 올림픽공원역 3·4번 출구(만남의광장·장미광장), 9호선 한성백제역 2번 출구(남4문·한성백제박물관)';
    if (purpose === 'walk') {
      steps.push(['출입문', '평화의광장·몽촌토성 산책은 8호선 몽촌토성역(1번 출구) 쪽 세계평화의문, 장미광장·들꽃마루는 동2문 쪽이 가까워요.']);
      if (mode === 'car') steps.push(['주차', h('span', {}, '만차 기록이 적은 구역을 노리세요: ', ...lotsLow.map(lotChip), `. 공연이 있는 날 오후에는 ${outside}이 대안이에요.`)]);
      else steps.push(['지하철', `가고 싶은 곳과 가까운 역을 고르세요: ${subway}.`]);
    } else if (purpose === 'sports') {
      steps.push(['평일 오전 피크', '평일은 오전 10~11시(수영장·스포츠센터 이용 시간)에 가장 붐벼요. 9시 이전이나 13시 이후가 여유로워요.']);
      if (mode === 'car') steps.push(['가까운 주차장', h('span', {}, '올림픽수영장은 ', lotChip('P4'), '(117대), 올림픽테니스경기장은 ', lotChip('P11'), '(190대)이 가까워요.')]);
      else steps.push(['지하철', '올림픽수영장·올림픽테니스경기장은 5·9호선 올림픽공원역이 가장 가까워요.']);
    } else {
      steps.push(['가족 나들이', '서울백제어린이박물관·피크닉장·88호수수변무대는 북2문(P4·P5), 88잔디마당·장미광장은 동2문이 가까워요.']);
      steps.push(['주말 낮 주의', '봄·가을 주말 13~15시는 주차구역 만차 기록이 가장 많은 시간대예요. 오전 10시 이전 도착을 권장해요.']);
      if (mode === 'transit') steps.push(['지하철', `${subway}.`]);
    }
    if (fc.shows.some((s) => s.peakCars >= 300)) steps.push(['공연 있는 날', `이날은 대형 공연이 있어 공연 시작 전후(${fc.shows.filter((s) => s.peakCars >= 300).map((s) => fmtMin(s.start)).join(', ')})로 주차장이 붐벼요.`]);
    if (best) {
      planEvent = {
        start: best.start, end: best.end, summary: `올림픽공원 ${PURPOSE_LABEL[purpose]} (한산한 시간대)`, location: parkLoc,
        description: [`예상 이용률 평균 ${pct(best.avg / cap)}(${LEVEL_LABEL[best.level]})`,
          busy.length ? `피하면 좋은 시간: ${busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(', ')}` : '',
          `만차 기록이 적은 주차구역: ${lotsLow.join('·')}`].filter(Boolean).join('\n'),
      };
    }
  }
  steps.push(['교통약자', '휠체어 이용 시 동2문 → 그래피티의 벽 주차장 → 올림픽공원역 방향 경사로로 만남의광장에 진입할 수 있어요.']);

  history.replaceState(null, '', planHash());
  const shareTitle = `올팍캐스트 · ${mdLabel(ds)} ${PURPOSE_LABEL[purpose]} 추천 동선`;
  const actions = h('div', { class: 'plan-actions' },
    h('button', { class: 'btn', type: 'button', onclick: () => sharePlan(shareTitle) }, '링크 공유'),
    planEvent ? h('button', {
      class: 'btn ghost', type: 'button',
      onclick: () => {
        const ics = buildIcs({ ...planEvent, ds, uid: `${ds}-${purpose}-${planEvent.start}@olparkcast`, url: location.href,
          description: `${planEvent.description}\n\n${location.href}`, alarm: '올림픽공원 출발 준비 — 올팍캐스트 예보를 확인하세요', alarmMin: 60 });
        downloadBlob(ics, `olparkcast-${ds.replace(/-/g, '')}.ics`, 'text/calendar;charset=utf-8');
        toast('캘린더 파일을 내려받았어요. 열면 일정과 1시간 전 알림이 추가돼요.');
      },
    }, '캘린더에 추가') : null);

  const hero = h('article', { class: 'card plan-hero' },
    h('p', { class: 'hero-kicker', text: `${mdLabel(ds)} · ${PURPOSE_LABEL[purpose]} · ${mode === 'car' ? '자가용' : '대중교통'}` }),
    h('div', { class: 'big', text: headline }),
    sub ? h('p', { class: 'card-sub', text: sub }) : null,
    h('div', {}, levelBadge(fc.peak.level, `이날 최대 ${fmtMin(fc.peak.min)} ${pct(fc.peak.ratio)}`)),
    actions);
  const stepsCard = h('article', { class: 'card' }, h('h2', { class: 'card-title', text: '추천 동선' }),
    h('ol', { class: 'steps' }, steps.map(([t, body]) => h('li', {}, h('strong', { text: t }), body instanceof Node ? body : h('span', { text: body })))));
  const chartCard = h('article', { class: 'card' }, h('h2', { class: 'card-title', text: `${mdLabel(ds)} 시간대별 예보` }), h('div', { class: 'chart', id: 'planChart' }));
  out.append(hero, stepsCard, chartCard);
  forecastColumns($('#planChart'), {
    slots: fc.slots, cap, from: 6, to: 24, nowMin: ds === nowKST().ds ? nowKST().min : null,
    colorOf: (s) => lvColor(s.level), height: 200,
    tooltip: (s) => [{ title: `${fmtMin(s.min)}~${fmtMin(s.min + 30)}` }, { label: LEVEL_LABEL[s.level], value: `${pct(s.ratio)} · ${cars(s.final)}` }],
    ariaLabel: `${mdLabel(ds)} 시간대별 예상 이용률`,
  });
}

// ---------------------------------------------------------------- 공연 캘린더
function renderCalendar(args = []) {
  const today = nowKST().ds;
  if (!STATE.calMonth) STATE.calMonth = today.slice(0, 7);
  const [y, m] = STATE.calMonth.split('-').map(Number);
  $('#calLabel').textContent = `${y}년 ${m}월`;
  const grid = $('#calendarGrid');
  grid.replaceChildren(...DOW.map((d) => h('div', { class: 'cal-head', text: d })));
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const clsColor = { A: css('--s2'), B: css('--s1'), C: css('--s3') };
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const inMonth = d.getMonth() === m - 1;
    if (i >= 35 && !inMonth && d.getDay() === 0) break;
    const shows = [...new Map(STATE.fc.showsOn(ds).map((s) => [s.evtSeq, s])).values()].sort((a, b) => b.peakCars - a.peakCars);
    const pk = (ds >= today ? forecastFor(ds) : STATE.fc.forecast(ds, {})).peak;
    const cell = h('button', {
      class: `cal-cell${inMonth ? '' : ' out'}${ds === today ? ' today' : ''}`, type: 'button', disabled: inMonth ? null : 'disabled',
      'aria-label': `${mdLabel(ds)} 최대 ${LEVEL_LABEL[pk.level]}${shows.length ? `, 공연 ${shows.length}건` : ''}`,
      onclick: () => { location.hash = `forecast/${ds}`; window.scrollTo({ top: 0 }); },
    }, h('span', { class: 'dn' }, h('span', { text: String(d.getDate()) }), ds >= today ? levelIcon(pk.level, 16) : null));
    for (const s of shows.slice(0, 2)) {
      const dot = h('i');
      dot.style.background = clsColor[s.cls];
      cell.append(h('span', { class: 'ev', title: s.title }, dot, s.title));
    }
    if (shows.length) cell.append(h('span', { class: 'evn', text: `공연 ${shows.length}` }));
    grid.append(cell);
  }
  const leg = $('#clsLegend');
  leg.replaceChildren(...['A', 'B', 'C'].map((c) => {
    const sw = h('span', { class: 'sw' });
    sw.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:3px;background:${clsColor[c]};margin-right:6px`;
    return h('span', {}, sw, h('b', { text: `${STATE.model.classes[c].name} ` }), STATE.model.classes[c].desc);
  }), h('span', { class: 'muted', text: '날씨 아이콘 = 그날 예상 최대 혼잡 단계' }));
  const sub = $('#calSubscribe');
  renderSubscribe(sub);
  if (args[0] === 'subscribe') { // 첫 화면 '혼잡 예보 구독' 바로가기
    history.replaceState(null, '', '#calendar');
    requestAnimationFrame(() => {
      sub.scrollIntoView({ block: 'center' });
      sub.classList.remove('flash');
      void sub.offsetWidth;
      sub.classList.add('flash');
    });
  }
}

// ---------------------------------------------------------------- 만차 위험일 캘린더 구독(파이프라인이 매일 만드는 data/risk-days.ics)
function renderSubscribe(el) {
  const url = new URL('data/risk-days.ics', location.href).href;
  const webcal = url.replace(/^https?:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  el.replaceChildren(
    h('h2', { class: 'card-title', text: '혼잡 예보 캘린더 구독' }),
    h('p', { class: 'card-sub', text: '혼잡(이용률 70% 이상)·만차 위험(90% 이상)이 예상되는 시간대가 휴대폰 캘린더에 일정으로 들어옵니다. 공연정보가 바뀌면 매일 자동으로 갱신돼요.' }),
    h('div', { class: 'url' }, h('code', { text: url }),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => toast((await copyText(url)) ? '구독 주소를 복사했어요' : url) }, '주소 복사')),
    h('div', { class: 'plan-actions' },
      h('a', { class: 'btn', href: webcal }, '캘린더 앱으로 구독'),
      h('a', { class: 'btn ghost', href: google, target: '_blank', rel: 'noopener' }, 'Google 캘린더에 추가')));
}

// ---------------------------------------------------------------- 운영 리포트(기관용)
function opsActions(fc, full, busy, shows) {
  const acts = [];
  const peak = Math.max(...fc.slots.map((s) => s.final));
  const over = Math.round(peak - STATE.model.capacity);
  const big = shows.filter((s) => s.peakCars >= 150);
  if (over > 0) acts.push(`수요 초과 약 ${over.toLocaleString()}대 — 남3·남4·서2문 주차장 안내, 만차 30분 전부터 만차 안내 방송·전광판`);
  else if (full.length) acts.push(`${full.map((r) => `${fmtMin(r.start)}~${fmtMin(r.end)}`).join(', ')} 만차 위험 — 주차요원 증원, 출입문 진입 안내 준비`);
  else if (busy.length) acts.push(`${busy.map((r) => `${fmtMin(r.start)}~${fmtMin(r.end)}`).join(', ')} 혼잡 — 출입문 안내 인력 배치`);
  if (big.some((s) => s.cls === 'A')) acts.push('자가용 집중형 공연 — 기획사와 예매자 대상 대중교통 이용 사전 안내');
  if (new Set(big.map((s) => s.venue)).size >= 2) acts.push('동시 공연 — 공연장별 진입·귀가 동선 분리');
  const late = big.filter((s) => s.start + s.dur >= 20 * 60);
  if (late.length) acts.push(`공연 종료(${fmtMin(Math.max(...late.map((s) => s.start + s.dur)))}) 후 귀가 분산 안내(몽촌토성역·한성백제역)`);
  const d = parseYmd(fc.ds);
  const springFall = [3, 4, 5, 6, 9, 10, 11].includes(d.getMonth() + 1);
  // 공연을 뺀 평소 수요만으로도 낮 시간이 붐비는 봄·가을 주말(혼잡도 기록상 만차가 몰리는 때)
  const leisureBusy = fc.slots.some((s) => s.min >= 11 * 60 && s.min < 16 * 60 && s.base / STATE.model.capacity >= 0.55);
  if ((fc.type !== 'weekday') && springFall && leisureBusy) acts.push('봄·가을 주말 나들이 수요 — 낮 시간(13~15시) 주차구역 만차 주의');
  return acts.length ? acts : ['평시 운영'];
}

function opsRows(n) {
  const today = nowKST().ds;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ds = addDays(today, i);
    const fc = STATE.fc.forecast(ds, {}); // 계획용 기본 예보(실시간·날씨 보정 제외)
    const full = STATE.fc.busyRanges(fc, 'full');
    const busy = STATE.fc.busyRanges(fc, 'busy');
    const shows = [...new Map(fc.shows.map((s) => [s.evtSeq, s])).values()].sort((a, b) => b.peakCars - a.peakCars);
    const peak = fc.slots.reduce((a, s) => (s.min >= 360 && s.final > a.final ? s : a), fc.slots[12]);
    rows.push({ ds, fc, peak, full, busy, shows, over: Math.max(0, Math.round(peak.final - STATE.model.capacity)), actions: opsActions(fc, full, busy, shows) });
  }
  return rows;
}

function renderOps() {
  const n = STATE.opsDays;
  document.querySelectorAll('input[name="opsDays"]').forEach((r) => { r.checked = Number(r.value) === n; });
  const rows = opsRows(n);
  const fullDays = rows.filter((r) => r.peak.ratio >= 0.9);
  const busyDays = rows.filter((r) => r.peak.ratio >= 0.7 && r.peak.ratio < 0.9);
  const top = rows.reduce((a, r) => (r.peak.final > a.peak.final ? r : a), rows[0]);
  const aDays = rows.filter((r) => r.shows.some((s) => s.cls === 'A' && s.peakCars >= 150));
  const tiles = [
    ['만차 위험일', `${fullDays.length}일`, '최대 이용률 90% 이상'],
    ['혼잡일', `${busyDays.length}일`, '최대 이용률 70~90%'],
    ['가장 붐비는 날', pct(top.peak.ratio), `${mdLabel(top.ds)} ${fmtMin(top.peak.min)}쯤`],
    ['자가용 집중형 공연일', `${aDays.length}일`, '사전 대중교통 안내 권장'],
  ];
  $('#opsStats').replaceChildren(...tiles.map(([l, v, d]) => h('div', { class: 'stat' }, h('div', { class: 'label', text: l }), h('div', { class: 'value', text: v }), h('div', { class: 'desc', text: d }))));
  const listed = rows.filter((r) => r.peak.ratio >= 0.7);
  const box = $('#opsTable');
  if (!listed.length) {
    box.replaceChildren(h('p', { class: 'empty', text: `향후 ${n}일 동안 이용률 70% 이상이 예상되는 날이 없어요.` }));
  } else {
    box.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ['날짜', '최대 예상', '혼잡 시간대(70%↑)', '수용 초과', '주요 공연', '권장 조치'].map((t, i) => h('th', { class: i === 3 ? 'num' : null, text: t })))),
      h('tbody', {}, listed.map((r) => h('tr', {},
        h('td', { class: 'nowrap day', 'data-label': '날짜' }, h('a', { href: `#forecast/${r.ds}`, text: mdLabel(r.ds) })),
        h('td', { class: 'nowrap', 'data-label': '최대 예상' }, levelBadge(r.peak.level, `${pct(r.peak.ratio)} · ${fmtMin(r.peak.min)}`)),
        h('td', { 'data-label': '혼잡 시간대', text: r.busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(', ') || '—' }),
        h('td', { class: 'num', 'data-label': '수용 초과', text: r.over ? `${r.over.toLocaleString()}대` : '—' }),
        h('td', { class: 'evs', 'data-label': '주요 공연' }, r.shows.filter((s) => s.peakCars >= 60).slice(0, 3).map((s) => h('div', {}, `${fmtMin(s.start)} ${s.venue} `, clsBadge(s.cls), ` ${s.title}`))),
        h('td', { class: 'act', 'data-label': '권장 조치' }, r.actions.map((a) => h('div', { text: `· ${a}` }))))))));
  }
  $('#opsNote').textContent = `예보 기준: 2024년 7월 입출차 기록으로 학습한 모델 + 올림픽공원 공연정보(${STATE.events.generatedAt.slice(0, 10)} 갱신). 당일 운영에는 '혼잡 예보' 화면의 실시간 보정 값을 함께 확인하세요.`;
  renderSubscribe($('#opsSubscribe'));
}

function opsCsv() {
  const rows = opsRows(STATE.opsDays);
  const esc = (v) => { // 스프레드시트 수식 실행 방지(공연명 등 외부 문자열)
    const t = String(v);
    return `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
  };
  const head = ['날짜', '요일', '최대이용률(%)', '최대시각', '예상최대대수', '수용초과대수', '혼잡시간대(70%이상)', '만차위험시간대(90%이상)', '공연(시작·공연장·관객유형·제목)', '권장조치'];
  const body = rows.map((r) => [r.ds, DOW[parseYmd(r.ds).getDay()], Math.round(r.peak.ratio * 100), fmtMin(r.peak.min), Math.round(r.peak.final), r.over,
    r.busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(' / '), r.full.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(' / '),
    r.shows.map((s) => `${fmtMin(s.start)} ${s.venue} ${STATE.model.classes[s.cls].name} ${s.title}`).join(' / '), r.actions.join(' / ')]);
  const csv = `﻿${[head, ...body].map((row) => row.map(esc).join(',')).join('\r\n')}\r\n`;
  downloadBlob(csv, `olparkcast-ops-${nowKST().ds.replace(/-/g, '')}-${STATE.opsDays}d.csv`, 'text/csv;charset=utf-8');
  toast('CSV 파일을 내려받았어요');
}

function setupOps() {
  document.querySelectorAll('input[name="opsDays"]').forEach((r) => r.addEventListener('change', () => { STATE.opsDays = Number(r.value); renderOps(); }));
  $('#opsCsv').addEventListener('click', opsCsv);
  $('#opsPrint').addEventListener('click', () => window.print());
}

// ---------------------------------------------------------------- 데이터 인사이트
function renderInsights() {
  const ins = STATE.insights;
  const md = STATE.model;
  const bt = md.backtest;
  const stay10 = ins.stay_distribution[0];
  const tiles = [
    ['분석한 입출차 기록', `${ins.records.toLocaleString()}건`, '올림픽공원 입출차 정보(2024년 7월)'],
    ['A형 공연 1회의 주차 영향', `+${Math.round(md.eventCoef.A * 15).toLocaleString()}대`, `KSPO DOME 기준 · B형은 +${Math.round(md.eventCoef.B * 15).toLocaleString()}대`],
    ['10분 이내 회차 차량', pct(stay10.share), '전체 입차의 약 3분의 1은 승하차·회차'],
    ['예보 오차(교차검증)', `${bt.model_all.mae_pct_capacity}%`, `평균 ${bt.model_all.mae_cars}대 · 공연 미반영 대비 ${Math.round((1 - bt.model_all.mae_cars / bt.baseline_all.mae_cars) * 100)}% 개선`],
  ];
  $('#statTiles').replaceChildren(...tiles.map(([l, v, d]) => h('div', { class: 'stat' }, h('div', { class: 'label', text: l }), h('div', { class: 'value', text: v }), h('div', { class: 'desc', text: d }))));

  const times = Array.from({ length: 48 }, (_, k) => fmtMin(k * 30));
  const cs = ins.case_study;
  const rng = (arr) => arr.slice(12, 48);
  $('#caseSub').textContent = `2024년 7월 일요일 두 번의 대형 공연. 좌석 규모는 비슷했지만 자가용 집중형 공연(A)이 열린 날 주차장이 수용 한계(${md.capacity.toLocaleString()}대)에 닿았어요.`;
  const series = [
    { name: cs.a_day.label, short: 'A형 공연일', color: css('--s2'), values: rng(cs.a_day.curve) },
    { name: cs.b_day.label, short: 'B형 공연일', color: css('--s1'), values: rng(cs.b_day.curve) },
    { name: cs.base.label, short: '일요일 기본', color: css('--s3'), values: rng(cs.base.curve) },
  ];
  lineChart($('#caseChart'), { series, xLabels: times.slice(12), xTickEvery: 4, ariaLabel: '2024년 7월 21일과 14일 일요일의 시간대별 주차장 점유대수 비교', yFormat: (v) => cars(v) });
  $('#caseTable').replaceChildren(table(['시간', ...series.map((s) => s.short)], times.slice(12).map((t, i) => [t, ...series.map((s) => s.values[i].toLocaleString())])));

  const prof = ins.profiles_model;
  const ps = [
    { name: '평일', color: css('--s1'), values: prof.weekday.slice(12) },
    { name: '토요일', color: css('--s2'), values: prof.saturday.slice(12) },
    { name: '일요일·공휴일', short: '일·공휴일', color: css('--s3'), values: prof.sunday.slice(12) },
  ];
  lineChart($('#profileChart'), { series: ps, xLabels: times.slice(12), xTickEvery: 4, ariaLabel: '요일유형별 기본 혼잡 패턴', yFormat: (v) => cars(v) });
  $('#profileTable').replaceChildren(table(['시간', ...ps.map((s) => s.name)], times.slice(12).map((t, i) => [t, ...ps.map((s) => Math.round(s.values[i]).toLocaleString())])));

  const years = Object.keys(ins.monthly).sort();
  const mcol = [css('--s3'), css('--s2'), css('--s1')];
  const ms = years.map((yv, i) => ({ name: `${yv}년`, color: mcol[i % 3], values: ins.monthly[yv] }));
  lineChart($('#monthlyChart'), { series: ms, xLabels: Array.from({ length: 12 }, (_, i) => `${i + 1}월`), xTickEvery: 1, ariaLabel: '연도별 월별 주차대수', yFormat: (v) => cars(v) });
  $('#monthlyTable').replaceChildren(table(['월', ...ms.map((s) => s.name)], Array.from({ length: 12 }, (_, i) => [`${i + 1}월`, ...ms.map((s) => s.values[i].toLocaleString())])));

  const cong = ins.congestion;
  $('#lotSub').textContent = `주차장 혼잡도 정보 ${cong.records.toLocaleString()}건(${cong.period[0]}~${cong.period[1]}) 중 '만차' 비율. 만차 기록의 ${pct(cong.full_weekend / cong.full_total)}가 주말·공휴일에 몰려 있어요.`;
  const lots = Object.entries(cong.lots).sort((a, b) => b[1].full_share - a[1].full_share);
  hbarChart($('#lotChart'), { items: lots.map(([k, v]) => ({ label: `${k}${v.gate ? ` · ${v.gate}` : ''}`, value: v.full_share, display: pct(v.full_share), note: `만차 ${v.full}건 / 기록 ${v.records}건` })), color: css('--s1'), max: 0.6, ariaLabel: '주차구역별 만차 기록 비율' });
  hbarChart($('#stayChart'), { items: ins.stay_distribution.map((b) => ({ label: b.label, value: b.share, display: pct(b.share), note: `${b.count.toLocaleString()}대` })), color: css('--s1'), ariaLabel: '주차 시간 분포' });

  $('#btSub').textContent = `${bt.method}. 기간 ${bt.period[0]}~${bt.period[1]}. 비교 기준: ${bt.baseline_desc}.`;
  const row = (name, a, b) => [name, `${a.mae_cars}대 (${a.mae_pct_capacity}%)`, `${b.mae_cars}대 (${b.mae_pct_capacity}%)`, `${a.peak_mae_cars}대`, `${b.peak_mae_cars}대`, `${a.level_accuracy_pct}%`, `${b.level_accuracy_pct}%`];
  $('#backtestTable').replaceChildren(table(['대상', '평균 오차·모델', '평균 오차·기준', '최대치 오차·모델', '최대치 오차·기준', '단계 일치·모델', '단계 일치·기준'], [
    row(`전체 ${bt.model_all.days}일`, bt.model_all, bt.baseline_all),
    row(`공연 있는 날 ${bt.model_event_days.days}일`, bt.model_event_days, bt.baseline_event_days),
    row(`대형 공연일 ${bt.model_big_event_days.days}일`, bt.model_big_event_days, bt.baseline_big_event_days),
  ], [1, 2, 3, 4, 5, 6]));
}

function table(head, rows, numCols = null) {
  const isNum = (i) => (numCols ? numCols.includes(i) : i > 0);
  return h('table', {}, h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: isNum(i) ? 'num' : null, text: t })))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: isNum(i) ? 'num' : null, text: c }))))));
}

// ---------------------------------------------------------------- 소개
function renderAbout() {
  const src = [
    ['올림픽공원 입출차 정보', '한국체육산업개발(주)', '파일(CSV)', '시간대별 기본 패턴·공연 영향 학습(215,528건)', 'https://www.data.go.kr/data/15138735/fileData.do'],
    ['올림픽공원 실시간 주차현황', '한국체육산업개발(주)', 'API', '오늘 예보 실시간 보정, 현재 주차대수', 'https://www.data.go.kr/data/15168686/openapi.do'],
    ['올림픽공원 공연정보', '한국체육산업개발(주)', 'API/누리집', '공연장·시작시각·공연시간 → 공연 영향 계산', 'https://www.data.go.kr/data/3037877/openapi.do'],
    ['월별주차현황', '한국체육산업개발(주)', '파일(CSV)', '계절(월) 계수', 'https://www.data.go.kr/data/15131671/fileData.do'],
    ['주차장 혼잡도 정보', '한국체육산업개발(주)', '파일(CSV)', '먼저 차는 주차구역 분석·추천', 'https://www.data.go.kr/data/15164156/fileData.do'],
    ['차량입출차·공연·날씨 연계 데이터(2025)', '한국체육산업개발(주)', 'API', '연간 재학습(키 발급 후 연동 예정)', 'https://www.data.go.kr/data/15164822/openapi.do'],
    ['단기예보(날씨)', '기상청 / Open-Meteo', 'API', '강수 시 나들이 수요 보정', 'https://www.data.go.kr/data/15084084/openapi.do'],
  ];
  $('#sourceTable').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['데이터', '제공', '형태', '서비스에서의 쓰임'].map((t) => h('th', { text: t })))),
    h('tbody', {}, src.map(([n, o, f, u, link]) => h('tr', {}, h('td', {}, h('a', { href: link, target: '_blank', rel: 'noopener', text: n })), h('td', { text: o }), h('td', { text: f }), h('td', { text: u }))))));
  $('#buildInfo').textContent = `모델 생성 ${STATE.model.generatedAt} · 공연정보 ${STATE.events.generatedAt} · 날씨 ${STATE.weather ? STATE.weather.source : '불러오지 못함'}`;
}

// ---------------------------------------------------------------- 공통
/** 상단 바의 실시간 주차 표시 */
function updateLivePill() {
  const pill = $('#livePill');
  const dot = pill.querySelector('.live-dot');
  const val = pill.querySelector('.lp-val');
  const cap = STATE.model.capacity;
  let label;
  if (STATE.live) {
    const r = STATE.live.value / cap;
    const lv = levelOf(r);
    const t = STATE.live.at;
    dot.classList.remove('off');
    dot.style.setProperty('--dot', lvColor(lv));
    val.textContent = `${STATE.live.value.toLocaleString()}대`;
    label = `실시간 주차 ${STATE.live.value.toLocaleString()}대 / ${cap.toLocaleString()}대 (이용률 ${pct(r)}, ${LEVEL_LABEL[lv]}) · ${t.getHours()}:${pad(t.getMinutes())} 갱신`;
  } else {
    dot.classList.add('off');
    dot.style.removeProperty('--dot');
    val.textContent = '연결 안 됨';
    label = '실시간 주차현황을 불러오지 못했어요. 예보는 과거 데이터로 계산합니다.';
  }
  pill.title = label;
  pill.setAttribute('aria-label', label);
  $('#dataStamp').textContent = ` · 공연정보 ${STATE.events.generatedAt.slice(0, 10)} 갱신`;
}

const THEME_ICON = {
  dark: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/>',
  light: '<path d="M20 14.6A8.3 8.3 0 0 1 9.4 4a8.3 8.3 0 1 0 10.6 10.6Z"/>',
};
function syncThemeIcon() {
  const t = currentTheme();
  const b = $('#themeBtn');
  b.querySelector('svg').innerHTML = THEME_ICON[t];
  const label = t === 'dark' ? '밝은 화면으로 전환' : '어두운 화면으로 전환';
  b.setAttribute('aria-label', label);
  b.title = label;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0b0e16' : '#ffffff');
}

function setupTheme() {
  syncThemeIcon();
  $('#themeBtn').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('olpark-theme', next); } catch (e) { /* 저장 불가 */ }
    syncThemeIcon();
    route();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (document.documentElement.dataset.theme) return;
    syncThemeIcon();
    route();
  });
}

// ---------------------------------------------------------------- 전체 메뉴·상단 바·나타나기 효과
let menuOpener = null;
function openMenu(opener) {
  const sheet = $('#menuSheet');
  menuOpener = opener;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  ['#menuBtn', '#tabMenu'].forEach((id) => $(id).setAttribute('aria-expanded', 'true'));
  (sheet.querySelector('.menu-list a[aria-current]') || sheet.querySelector('.menu-list a')).focus();
}
function closeMenu(restoreFocus) {
  const sheet = $('#menuSheet');
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  document.body.style.overflow = '';
  ['#menuBtn', '#tabMenu'].forEach((id) => $(id).setAttribute('aria-expanded', 'false'));
  if (restoreFocus && menuOpener) menuOpener.focus();
}

let revealObserver = null;
function observeReveal() {
  const els = document.querySelectorAll('.reveal:not(.in)');
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  revealObserver = revealObserver || new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      en.target.classList.add('in');
      revealObserver.unobserve(en.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
  els.forEach((e) => revealObserver.observe(e));
}

function setupChrome() {
  const sheet = $('#menuSheet');
  $('#menuBtn').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('#tabMenu').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('#menuClose').addEventListener('click', () => closeMenu(true));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeMenu(true); });
  sheet.querySelectorAll('.menu-list a').forEach((a) => a.addEventListener('click', () => closeMenu(false)));
  document.addEventListener('keydown', (e) => {
    if (sheet.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('a, button')];
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  const gnb = $('#gnb');
  const onScroll = () => gnb.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  // 본문 바로가기: 주소(#)를 바꾸지 않고 초점만 옮긴다(주소가 바뀌면 화면 전환으로 처리되기 때문)
  $('.skip').addEventListener('click', (e) => { e.preventDefault(); $('#main').focus(); });
  setupQuickPlan();
  observeReveal();
}

// ---------------------------------------------------------------- 오프라인(공연장 주변 통신 혼잡 대비)
function updateNetBanner() {
  const b = $('#netBanner');
  if (navigator.onLine) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = `오프라인 상태예요. 마지막으로 저장된 예보(공연정보 ${STATE.events ? STATE.events.generatedAt.slice(0, 10) : ''} 기준)를 보여 드려요. 연결되면 실시간 주차현황을 다시 불러와요.`;
}
window.addEventListener('offline', updateNetBanner);
window.addEventListener('online', async () => { updateNetBanner(); if (STATE.model) { await fetchLive(); updateLivePill(); route(); } });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 지원 안 함 */ }); });
}

let resizeTimer;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => { // 모바일 주소창 높이 변화로는 다시 그리지 않음
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(route, 200);
});
window.addEventListener('hashchange', route);
$('#calPrev').addEventListener('click', () => { const [y, m] = STATE.calMonth.split('-').map(Number); const d = new Date(y, m - 2, 1); STATE.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; renderCalendar(); });
$('#calNext').addEventListener('click', () => { const [y, m] = STATE.calMonth.split('-').map(Number); const d = new Date(y, m, 1); STATE.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; renderCalendar(); });

async function main() {
  document.body.classList.add('loading');
  try {
    const [model, events, insights] = await Promise.all([loadJSON('data/model.json'), loadJSON('data/events.json'), loadJSON('data/insights.json')]);
    Object.assign(STATE, { model, events, insights });
    STATE.fc = new Forecaster(model, events);
  } catch (e) {
    $('#main').prepend(h('div', { class: 'callout warn', text: `데이터를 불러오지 못했어요: ${e.message}` }));
    document.body.classList.remove('loading');
    return;
  }
  setupTheme();
  setupOps();
  setupChrome();
  updateNetBanner();
  route();
  updateLivePill();
  document.body.classList.remove('loading');
  await Promise.all([fetchLive(), fetchWeather()]);
  updateLivePill();
  route();
  setInterval(async () => {
    await fetchLive();
    updateLivePill();
    if (document.hidden) return;
    if (STATE.view === 'forecast') renderForecast();
    else if (STATE.view === 'home') renderHome();
  }, LIVE_REFRESH_MS);
}
main();

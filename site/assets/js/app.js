import { Forecaster, LEVEL_KEYS, LEVEL_LABEL, DOW, levelOf, fmtMin, parseYmd, nowKST, addDays } from './forecast.js';
import { forecastColumns, lineChart, hbarChart, sparkBars } from './charts.js';

const LIVE_REFRESH_MS = 5 * 60 * 1000;
const PARK = { lat: 37.5207, lon: 127.1214 };
const STATE = { model: null, events: null, insights: null, fc: null, live: null, liveError: null, weather: null, date: null, calMonth: null };

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
  const [tab, arg] = (location.hash.replace('#', '') || 'forecast').split('/');
  const views = ['forecast', 'plan', 'calendar', 'insights', 'about'];
  const cur = views.includes(tab) ? tab : 'forecast';
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== cur; });
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (cur === 'forecast') {
    if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) STATE.date = arg;
    renderForecast();
  } else if (cur === 'plan') renderPlan();
  else if (cur === 'calendar') renderCalendar();
  else if (cur === 'insights') renderInsights();
  else if (cur === 'about') renderAbout();
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
  let pk = fc.peak;
  const isToday = fc.ds === today;
  if (isToday) { // 오늘은 지금 이후 남은 시간대 중 최대
    const nowSlot = Math.floor(nowKST().min / 30);
    const rest = fc.slots.filter((s) => s.k >= nowSlot && s.min < 24 * 60);
    if (rest.length) pk = rest.reduce((a, s) => (s.final > a.final ? s : a), rest[0]);
  }
  const when = fc.ds === today ? '오늘' : fc.ds === addDays(today, 1) ? '내일' : mdLabel(fc.ds);
  const best = STATE.fc.bestWindow(fc, 7, 21, 4, fc.ds === today ? Math.ceil(nowKST().min / 30) * 30 : null);
  const busy = STATE.fc.busyRanges(fc, 'busy');
  const top = h('div', { class: 'hero-top' },
    h('div', { class: `hero-icon ${pk.level}` }, levelIcon(pk.level, 44)),
    h('div', {},
      h('p', { class: 'hero-kicker', text: `${when} 올림픽공원 혼잡 예보${when === mdLabel(fc.ds) ? '' : ` · ${mdLabel(fc.ds)}`}` }),
      h('h2', { class: 'hero-title' }, isToday ? '남은 시간 최대 ' : '최대 ', levelBadge(pk.level), ` ${fmtMin(pk.min)}쯤 ${pct(pk.ratio)}`)));
  const facts = h('dl', { class: 'hero-facts' },
    h('div', {}, h('dt', { text: '가장 붐비는 시간' }), h('dd', { text: fmtMin(pk.min) })),
    h('div', {}, h('dt', { text: '한산한 시간' }), h('dd', { text: best ? `${fmtMin(best.start)}~${fmtMin(best.end)}` : '—' })),
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
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '실시간 정보 새로고침', title: '새로고침', onclick: async () => { await fetchLive(); renderForecast(); updateFreshness(); } }, '↻'));
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
  const legend = $('#levelLegend');
  legend.replaceChildren(...LEVEL_KEYS.map((lv) => {
    const sw = h('span', { class: 'sw' });
    sw.style.background = lvColor(lv);
    const range = { free: '50% 미만', normal: '50~70%', busy: '70~90%', full: '90% 이상' }[lv];
    return h('li', {}, sw, `${LEVEL_LABEL[lv]} ${range}`);
  }));
  const tooltip = (s) => {
    const past = isToday && s.min + 30 <= nowKST().min;
    const rows = [{ title: `${mdLabel(fc.ds)} ${fmtMin(s.min)}~${fmtMin(s.min + 30)}${past ? ' (지난 시간)' : ''}` },
      { label: `예상 ${LEVEL_LABEL[s.level]}`, value: `${pct(s.ratio)} · ${cars(s.final)}` },
      { label: '평소 방문', value: cars(s.base) }];
    if (s.event >= 5) rows.push({ label: '공연 영향', value: `+${cars(s.event)}` });
    if (Math.abs(s.adj) >= 5) rows.push({ label: '실시간 보정', value: `${s.adj > 0 ? '+' : '−'}${cars(Math.abs(s.adj))}` });
    if (s.rainP != null && s.rainP >= 0.3) rows.push({ label: '강수 가능성', value: pct(s.rainP) });
    return rows;
  };
  forecastColumns($('#forecastChart'), {
    slots: fc.slots, cap: STATE.model.capacity, from: 6, to: 24,
    nowMin: isToday ? nowKST().min : null, colorOf: (s) => lvColor(s.level), tooltip,
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
  const best = STATE.fc.bestWindow(fc, 7, 21, 4, fromMin) || STATE.fc.bestWindow(fc, 7, 24, 2, fromMin);
  const busy = STATE.fc.busyRanges(fc, 'busy').filter((b) => fromMin == null || b.end > fromMin);
  const big = fc.shows.filter((s) => s.peakCars >= 300).sort((a, b) => b.peakCars - a.peakCars)[0];
  if (big) {
    const end = big.start + big.dur;
    tips.push(['🚇', `대형 공연일이에요. ${big.cls === 'A' ? '자가용 관객이 많은 공연이라 ' : ''}대중교통(${venueTransit(big.venue)})을 이용하세요.`]);
    tips.push(['↗', `공연이 끝나는 ${fmtMin(end)} 무렵부터 30~60분은 출차·지하철이 붐벼요. 8호선은 몽촌토성역(1번 출구), 9호선은 한성백제역(2번 출구)을 이용하면 올림픽공원역 혼잡을 피할 수 있어요.`]);
  }
  if (busy.length) tips.push(['!', `${busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(', ')}에는 차량 방문을 피하세요(이용률 70% 이상 예상).`]);
  if (best) tips.push(['☀', `산책·나들이는 ${fmtMin(best.start)}~${fmtMin(best.end)}가 가장 한산해요(평균 ${pct(best.avg / STATE.model.capacity)}).`]);
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
function renderPlan() {
  const today = nowKST().ds;
  const dateSel = $('#planDate');
  if (!dateSel.options.length) {
    for (let i = 0; i < 45; i++) {
      const ds = addDays(today, i);
      const n = (STATE.fc.showsOn(ds) || []).length;
      dateSel.append(h('option', { value: ds, text: `${mdLabel(ds)}${i === 0 ? ' 오늘' : ''}${n ? ` · 공연 ${new Set(STATE.fc.showsOn(ds).map((s) => s.evtSeq)).size}건` : ''}` }));
    }
    const firstShow = Array.from(dateSel.options).find((o) => STATE.fc.showsOn(o.value).some((s) => s.peakCars >= 300));
    if (firstShow) dateSel.value = firstShow.value;
    $('#planForm').addEventListener('change', (e) => { if (e.target.id === 'planDate') fillShows(); computePlan(); });
    fillShows();
  }
  computePlan();
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
    } else {
      headline = `${fmtMin(show.start - (show.cls === 'B' ? 90 : 60))}쯤 도착을 권장해요`;
      sub = show.cls === 'B' ? '팬덤 공연은 입장 대기·MD 구매로 일찍 붐벼요.' : '입장 대기를 고려해 여유 있게 도착하세요.';
      steps.push(['지하철', `${venueTransit(show.venue)}이 가장 가까워요.`]);
      steps.push(['버스', '동1문(올림픽공원역) 정류장: 3214·3220·3319·3412·3413, 경기 30-5 등']);
      steps.push(['귀가 분산', `공연 종료(${fmtMin(end)}) 직후 올림픽공원역에 관객이 몰려요. 8호선은 몽촌토성역(1번 출구), 9호선은 한성백제역(2번 출구)으로 걸어가면 승강장 혼잡을 피할 수 있어요.`]);
    }
  } else {
    const ranges = { walk: [7, 20], sports: [6, 22], kids: [9, 18] }[purpose];
    const nowMin = ds === nowKST().ds ? Math.ceil(nowKST().min / 30) * 30 : null;
    const best = STATE.fc.bestWindow(fc, ranges[0], ranges[1], 4, nowMin);
    const busy = STATE.fc.busyRanges(fc, 'normal');
    headline = best ? `${fmtMin(best.start)}~${fmtMin(best.end)}이 가장 한산해요` : '오늘 남은 시간은 모두 붐벼요';
    sub = best ? `이 시간대 예상 이용률 평균 ${pct(best.avg / cap)} (${LEVEL_LABEL[best.level]})` : '';
    if (busy.length) steps.push(['피하면 좋은 시간', `${busy.map((b) => `${fmtMin(b.start)}~${fmtMin(b.end)}`).join(', ')} (이용률 50% 이상 예상)`]);
    if (purpose === 'walk') {
      steps.push(['출입문', '평화의광장·몽촌토성 산책은 8호선 몽촌토성역(1번 출구) 쪽 세계평화의문, 장미광장·들꽃마루는 동2문 쪽이 가까워요.']);
      steps.push(['주차', h('span', {}, `자가용이라면 만차 기록이 적은 구역을 노리세요: `, ...lotsLow.map(lotChip), `. 공연이 있는 날 오후에는 ${outside}이 대안이에요.`)]);
    } else if (purpose === 'sports') {
      steps.push(['평일 오전 피크', '평일은 오전 10~11시(수영장·스포츠센터 이용 시간)에 가장 붐벼요. 9시 이전이나 13시 이후가 여유로워요.']);
      steps.push(['가까운 주차장', h('span', {}, '올림픽수영장은 ', lotChip('P4'), '(117대), 올림픽테니스경기장은 ', lotChip('P11'), '(190대)이 가까워요.')]);
    } else {
      steps.push(['가족 나들이', '서울백제어린이박물관·피크닉장·88호수수변무대는 북2문(P4·P5), 88잔디마당·장미광장은 동2문이 가까워요.']);
      steps.push(['주말 낮 주의', '봄·가을 주말 13~15시는 주차구역 만차 기록이 가장 많은 시간대예요. 오전 10시 이전 도착을 권장해요.']);
    }
    if (fc.shows.some((s) => s.peakCars >= 300)) steps.push(['공연 있는 날', `이날은 대형 공연이 있어 공연 시작 전후(${fc.shows.filter((s) => s.peakCars >= 300).map((s) => fmtMin(s.start)).join(', ')})로 주차장이 붐벼요.`]);
  }
  steps.push(['교통약자', '휠체어 이용 시 동2문 → 그래피티의 벽 주차장 → 올림픽공원역 방향 경사로로 만남의광장에 진입할 수 있어요.']);

  const hero = h('article', { class: 'card plan-hero' },
    h('p', { class: 'hero-kicker', text: `${mdLabel(ds)} · ${({ show: '공연 관람', walk: '산책·나들이', sports: '운동·수영', kids: '아이와 함께' })[purpose]}${purpose === 'show' ? (mode === 'car' ? ' · 자가용' : ' · 대중교통') : ''}` }),
    h('div', { class: 'big', text: headline }),
    sub ? h('p', { class: 'card-sub', text: sub }) : null,
    h('div', {}, levelBadge(fc.peak.level, `이날 최대 ${fmtMin(fc.peak.min)} ${pct(fc.peak.ratio)}`)));
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
function renderCalendar() {
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
function updateFreshness() {
  const f = $('#freshness');
  const live = STATE.live ? `실시간 ${STATE.live.at.getHours()}:${String(STATE.live.at.getMinutes()).padStart(2, '0')}` : '실시간 연결 안 됨';
  f.textContent = `공연정보 ${STATE.events.generatedAt.slice(5, 10).replace('-', '/')} · ${live}`;
}

function setupTheme() {
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('olpark-theme', next); } catch (e) { /* 저장 불가 */ }
    route();
  });
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(route, 200); });
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
  route();
  updateFreshness();
  document.body.classList.remove('loading');
  await Promise.all([fetchLive(), fetchWeather()]);
  updateFreshness();
  route();
  setInterval(async () => { await fetchLive(); updateFreshness(); if (!document.hidden && (location.hash || '#forecast').startsWith('#forecast')) renderForecast(); }, LIVE_REFRESH_MS);
}
main();

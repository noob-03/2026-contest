// 올팍캐스트 서비스 워커 — 공연장 주변처럼 통신이 붐빌 때도 마지막 예보를 볼 수 있게 한다.
// 같은 출처 파일은 '네트워크 우선, 실패하면 캐시'로 처리해 온라인에서는 항상 최신 데이터를 쓴다.
// 실시간 주차현황·날씨·글꼴 같은 외부 요청은 가로채지 않는다.
const CACHE = 'olparkcast-v3';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './assets/css/style.css',
  './assets/js/app.js', './assets/js/forecast.js', './assets/js/charts.js', './assets/img/icon.svg', './assets/img/icon-192.png',
  './data/model.json', './data/events.json', './data/insights.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});

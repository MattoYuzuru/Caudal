// Only provide an offline message for navigation. Never persist API data or credentials.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname !== '/') return;

  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Caudal без сети</title><style>body{background:#f8f2e9;color:#30231f;font:16px system-ui;margin:12vh auto;padding:24px;max-width:36rem}a{color:#a52f1e}@media(prefers-color-scheme:dark){body{background:#0c1123;color:#eff2ff}a{color:#a7baff}}</style><h1>Нет подключения</h1><p>Подключитесь к интернету, чтобы открыть панель инфраструктуры.</p><a href="/">Повторить</a></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )));
});

// Only provide an offline message for navigation. Never persist API data or credentials.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname !== '/') return;

  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Caudal без сети</title><style>body{color-scheme:dark;background:#101412;color:#eff5ee;font:16px system-ui;margin:12vh auto;padding:24px;max-width:36rem}a{color:#c8f883}</style><h1>Нет подключения</h1><p>Подключитесь к интернету, чтобы открыть панель инфраструктуры.</p><a href="/">Повторить</a></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )));
});

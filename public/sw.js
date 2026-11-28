// The fallback is self-contained. Do not store portal pages or API responses in Cache Storage.
const offlinePage = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>无法连接 · 紫霄实验室</title>
    <style>
      /* Default Zixiao palette from the UI Kit; no stylesheets or fonts to load offline. */
      :root {
        color-scheme: light dark;
        background: light-dark(#fef7ff, #161217);
        color: light-dark(#1d1b20, #e9e0e7);
        font: 1rem/1.6 system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      }
      body { margin: 0; min-height: 100svh; display: grid; place-items: center; }
      main { max-width: 28rem; padding: 2rem; }
      h1 { font-size: clamp(1.5rem, 5vw, 2rem); line-height: 1.25; margin: 0; }
      p { color: light-dark(#55505c, #cfc3d0); margin: .75rem 0 1rem; }
      a {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        color: light-dark(#612aca, #e1b7f6);
        text-underline-offset: .2em;
      }
      a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>暂时无法连接门户</h1>
      <p>登录和浏览文档需要联网。请检查网络连接后重试。</p>
      <a href="">重新加载页面</a>
    </main>
  </body>
</html>`

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || request.mode !== 'navigate' || request.destination !== 'document')
    return
  const { origin, pathname } = new URL(request.url)
  if (
    origin !== self.location.origin ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/.well-known/')
  )
    return

  // Only transport failures get a fallback. Keep HTTP errors and redirects from the server.
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(offlinePage, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        }),
    ),
  )
})

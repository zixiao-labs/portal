import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import '@zixiao-labs/ui-kits-react/styles.css'
import '../portal.css'
import logo from '../../assets/zixiao-logo-2.svg?url'
import { appearanceScript, defaults, paletteCss } from '../ui/appearance'
import { Footer, Header } from '../ui/shell'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: '紫霄实验室 · Zixiao Laboratories' },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: logo },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', sizes: '192x192', href: '/pwa/icon-192.png' },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
  notFoundComponent: () => (
    <main id="main" className="workspace">
      <h1>页面未找到</h1>
      <Link to="/docs">返回文档库</Link>
    </main>
  ),
  errorComponent: () => (
    <main id="main" className="workspace">
      <h1>暂时无法打开页面</h1>
      <p>
        请刷新重试，或<Link to="/login">返回登录</Link>。
      </p>
    </main>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Don't let a worker intercept requests while Nasti is rebuilding the dev server.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error) => {
      console.warn('Portal service worker registration failed:', error)
    })
  }, [])

  return (
    // The head script sets the actual theme attributes before React hydrates.
    <html
      lang="zh-CN"
      data-zx-style={defaults.style}
      data-zx-color-mode="light"
      data-portal-palette={defaults.palette}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceScript }} />
        <style>{paletteCss}</style>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main">
          跳到主内容
        </a>
        <Header />
        {children}
        <Footer />
        <Scripts />
      </body>
    </html>
  )
}

import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router'

export const Route = createFileRoute('/account_/oauth-apps')({
  ssr: false,
  head: () => ({
    meta: [{ title: 'OAuth 应用｜紫霄实验室' }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  pendingComponent: () => (
    <main id="main" className="workspace">
      <p role="status">正在打开 OAuth 应用…</p>
    </main>
  ),
  component: lazyRouteComponent(() => import('../ui/oauth-apps'), 'OAuthAppsPage'),
})

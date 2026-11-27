import { createFileRoute } from '@tanstack/react-router'
import { AccountPage } from '../ui/account'

export const Route = createFileRoute('/account')({
  ssr: false,
  validateSearch: (search): { github?: 'linked' | 'conflict' | 'error' } =>
    search.github === 'linked' || search.github === 'conflict' || search.github === 'error'
      ? { github: search.github }
      : {},
  head: () => ({
    meta: [{ title: '个人中心｜紫霄实验室' }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  pendingComponent: () => (
    <main id="main" className="workspace">
      <p role="status">正在打开个人中心…</p>
    </main>
  ),
  component: AccountRoute,
})

function AccountRoute() {
  return <AccountPage githubResult={Route.useSearch().github} />
}

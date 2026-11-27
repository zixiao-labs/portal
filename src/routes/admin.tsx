import { createFileRoute } from '@tanstack/react-router'
import { AdminPage, type AdminView } from '../ui/admin'

export const Route = createFileRoute('/admin')({
  ssr: false,
  validateSearch: (search): { view?: AdminView } =>
    search.view === 'users' || search.view === 'repositories' || search.view === 'cli'
      ? { view: search.view }
      : {},
  head: () => ({
    meta: [{ title: '管理后台｜紫霄实验室' }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  pendingComponent: () => (
    <main id="main" className="workspace">
      <p role="status">正在打开管理后台…</p>
    </main>
  ),
  component: AdminRoute,
})

function AdminRoute() {
  return <AdminPage view={Route.useSearch().view ?? 'users'} />
}

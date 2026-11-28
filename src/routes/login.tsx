import { createFileRoute } from '@tanstack/react-router'
import { canonicalOrigin } from '../deployment.mjs'
import { LoginPage } from '../ui/login'

export const Route = createFileRoute('/login')({
  validateSearch: (search): { error?: string; mcp?: true } => ({
    ...(typeof search.error === 'string' ? { error: search.error } : {}),
    ...(search.mcp === true ? { mcp: true } : {}),
  }),
  head: () => ({
    meta: [
      { title: '登录｜紫霄实验室 Zixiao Laboratories' },
      {
        name: 'description',
        content: '登录紫霄实验室门户。支持 GitHub 登录，以及面向紫霄实验室员工的工作邮箱验证。',
      },
    ],
    links: [{ rel: 'canonical', href: `${canonicalOrigin}/login` }],
  }),
  component: LoginRoute,
})

function LoginRoute() {
  const { error, mcp } = Route.useSearch()
  return <LoginPage key={mcp ? 'mcp' : 'login'} oauthError={error} mcp={mcp} />
}

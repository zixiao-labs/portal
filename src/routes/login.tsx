import { createFileRoute, redirect } from '@tanstack/react-router'
import { canonicalOrigin } from '../deployment.mjs'
import { getLoginSessionState } from '../login-session'
import { LoginPage } from '../ui/login'

export const Route = createFileRoute('/login')({
  validateSearch: (search): { error?: string; mcp?: true; verifyEmail?: true } => ({
    ...(typeof search.error === 'string' ? { error: search.error } : {}),
    ...(search.mcp === true ? { mcp: true } : {}),
    ...(search.verifyEmail === true ? { verifyEmail: true } : {}),
  }),
  beforeLoad: async ({ search }) => {
    // MCP consent handles its own session checks, and admins can verify an existing session.
    if (search.mcp) return
    const state = await getLoginSessionState()
    if (state === 'signed-out' || (search.verifyEmail && state === 'email-required')) return
    throw redirect({ to: '/account', replace: true, statusCode: 302 })
  },
  head: ({ match }) => ({
    meta: [
      { title: '登录｜紫霄实验室 Zixiao Laboratories' },
      {
        name: 'description',
        content: '登录紫霄实验室门户。支持 GitHub 登录，以及面向紫霄实验室员工的工作邮箱验证。',
      },
      ...(match.search.mcp ? [{ name: 'robots', content: 'noindex, nofollow' }] : []),
    ],
    links: [{ rel: 'canonical', href: `${canonicalOrigin}/login` }],
  }),
  component: LoginRoute,
})

function LoginRoute() {
  const { error, mcp } = Route.useSearch()
  return <LoginPage key={mcp ? 'mcp' : 'login'} oauthError={error} mcp={mcp} />
}

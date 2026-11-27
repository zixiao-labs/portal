import type { AccountInfo } from '../account-info'
import { adminAccess, adminApi } from './admin'
import { checkCode, finishGithub, sendCode, startGithub } from './auth'
import { config } from './config'
import { checkOrigin, HttpError, json, readJson } from './http'
import { publish } from './publish'
import { removeSession, session } from './session'

export async function api(request: Request, path: string) {
  const { method } = request
  const { origin } = config()
  try {
    if (path === '/api/auth/github' && method === 'GET') return await startGithub(request)
    if (path === '/api/auth/github/callback' && method === 'GET') return await finishGithub(request)
    if (path === '/api/publish' && method === 'POST') return json(await publish(request))
    if (method === 'POST' || method === 'DELETE') checkOrigin(request, origin)
    if (path.startsWith('/api/admin/')) return await adminApi(request, path)
    if (path === '/api/auth/github/link' && method === 'POST')
      return await startGithub(request, true)
    if (path === '/api/auth/email/send' && method === 'POST')
      return await sendCode(await readJson(request, 4096))
    if (path === '/api/auth/email/verify' && method === 'POST')
      return await checkCode(request, await readJson(request, 4096))
    if (path === '/api/auth/logout' && method === 'POST')
      return json({ ok: true }, 200, [removeSession(request)])

    if (path === '/api/account' && method === 'GET') {
      const current = await session(request)
      if (!current) throw new HttpError(401, '请先登录。')
      const { user } = current
      const access = adminAccess(current)
      const account: AccountInfo = {
        email: user.email,
        employee: Boolean(user.employee),
        github: Boolean(user.github_id),
        adminAccess: access,
        ...(access === 'granted' ? { admin: true } : {}),
      }
      return json(account)
    }
    throw new HttpError(404, '未找到接口。')
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error('Portal API error:', error instanceof Error ? error.name : 'unknown')
    return json({ error: '服务暂时不可用，请稍后再试。' }, 500)
  }
}

import {
  employeeLoginEmail,
  checkCode,
  finishGithub,
  removeSession,
  sendCode,
  sessionUser,
  startGithub,
} from './auth'
import { config } from './config'
import { checkOrigin, hash, HttpError, json, opaque, readJson } from './http'
import { publish, repositoryName } from './publish'
import { store } from './store'

export async function api(request: Request, path: string) {
  const { method } = request
  const { origin } = config()
  try {
    if (path === '/api/auth/github' && method === 'GET') return startGithub()
    if (path === '/api/auth/github/callback' && method === 'GET') return await finishGithub(request)
    if (path === '/api/publish' && method === 'POST') return json(await publish(request))
    if (method === 'POST' || method === 'DELETE') checkOrigin(request, origin)
    if (path === '/api/auth/email/send' && method === 'POST')
      return await sendCode(await readJson(request, 4096))
    if (path === '/api/auth/email/verify' && method === 'POST')
      return checkCode(request, await readJson(request, 4096))
    if (path === '/api/auth/logout' && method === 'POST')
      return json({ ok: true }, 200, [removeSession(request)])

    const account = path === '/api/account' && method === 'GET'
    const create = path === '/api/tokens' && method === 'POST'
    const remove =
      method === 'DELETE' ? /^\/api\/tokens\/([A-Za-z0-9_-]{43})$/.exec(path)?.[1] : undefined
    if (!account && !create && !remove) throw new HttpError(404, '未找到接口。')
    const user = sessionUser(request)
    if (!user) throw new HttpError(401, '请先登录。')
    const db = store()
    const time = Math.floor(Date.now() / 1000)
    if (account) {
      const tokens = user.employee
        ? db
            .prepare(
              'SELECT id, repository, created, expires FROM tokens WHERE user_id=? AND expires>? ORDER BY created DESC',
            )
            .all(user.id, time)
        : []
      return json({
        email: user.email,
        employee: Boolean(user.employee),
        github: Boolean(user.github_id),
        tokens,
      })
    }
    if (remove) {
      db.prepare('DELETE FROM tokens WHERE id=? AND user_id=?').run(remove, user.id)
      return json({ ok: true })
    }
    if (!user.employee) throw new HttpError(403, '仅员工可创建发布 Token。')
    employeeLoginEmail(user.email)
    const repository = repositoryName((await readJson(request, 4096)).repository)
    const token = `zxp_${opaque()}`
    const inserted = db
      .prepare(`INSERT INTO tokens
      SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM tokens WHERE user_id=? AND expires>?) < 20`)
      .run(opaque(), hash(token), user.id, repository, time, time + 90 * 86400, user.id, time)
    if (!inserted.changes) throw new HttpError(409, '已达到 20 个有效 Token 的上限。')
    return json({ token }, 201)
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error('Portal API error:', error instanceof Error ? error.name : 'unknown')
    return json({ error: '服务暂时不可用，请稍后再试。' }, 500)
  }
}

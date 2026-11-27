import type { AccountInfo } from '../account-info'
import { adminEmails, organizationRepository, validNumericId } from '../deployment.mjs'
import { HttpError, json, readJson } from './http'
import { activeSession, session } from './session'
import { store, transaction, type User } from './store'

type Session = NonNullable<Awaited<ReturnType<typeof session>>>

function isConfiguredAdmin(user: User) {
  return Boolean(user.employee) && adminEmails(process.env.PORTAL_ADMIN_EMAILS).has(user.email)
}

export function adminAccess(current: Session): AccountInfo['adminAccess'] {
  if (isConfiguredAdmin(current.user)) return current.byEmail ? 'granted' : 'email-required'
}

export async function adminApi(request: Request, path: string) {
  const current = await session(request)
  if (!current) throw new HttpError(401, '请先登录。')
  const access = adminAccess(current)
  if (access === 'email-required') throw new HttpError(403, '请先使用工作邮箱验证码验证身份。')
  if (access !== 'granted') throw new HttpError(403, '当前账户没有管理权限。')

  const db = store()
  const write = (operation: () => void) => {
    transaction(db, () => {
      const actor = activeSession(current.tokenHash, String(current.user.id))
      if (!actor || adminAccess({ ...current, user: actor }) !== 'granted')
        throw new HttpError(403, '管理会话已失效。')
      operation()
    })
    return json({ ok: true })
  }
  const { method } = request

  if (path === '/api/admin/users' && method === 'GET') {
    const search = new URL(request.url).searchParams
    const query = (search.get('q') ?? '').trim().toLowerCase()
    const after = search.get('after')
    if (query.length > 254 || (after !== null && !validNumericId(after)))
      throw new HttpError(400, '搜索条件无效。')
    const users = db
      .prepare(`SELECT users.*, suspended_users.user_id AS suspended
        FROM users LEFT JOIN suspended_users ON suspended_users.user_id=users.id
        WHERE users.id>? AND instr(users.email, ?) > 0 ORDER BY users.id LIMIT 51`)
      .all(after ?? 0, query) as (User & { suspended: number | null })[]
    return json({
      users: users.slice(0, 50).map((user) => ({
        id: String(user.id),
        email: user.email,
        employee: Boolean(user.employee),
        github: Boolean(user.github_id),
        suspended: Boolean(user.suspended),
        admin: isConfiguredAdmin(user),
      })),
      next: users.length === 51 ? String(users[49].id) : null,
    })
  }

  const target =
    method === 'POST' &&
    /^\/api\/admin\/users\/([1-9][0-9]{0,19})\/(suspend|restore|revoke-sessions)$/.exec(path)
  if (target) {
    const [, id, action] = target
    return write(() => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(id) as User | undefined
      if (!user) throw new HttpError(404, '未找到用户。')
      if (isConfiguredAdmin(user))
        throw new HttpError(409, '请先在部署配置中移除该账户的管理员权限。')
      if (action === 'restore') {
        db.prepare('DELETE FROM suspended_users WHERE user_id=?').run(id)
      } else {
        if (action === 'suspend') {
          db.prepare('INSERT OR IGNORE INTO suspended_users VALUES (?)').run(id)
          db.prepare('DELETE FROM email_codes WHERE email=?').run(user.email)
        }
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
      }
    })
  }

  if (path === '/api/admin/repositories' && method === 'GET') {
    return json({
      repositories: db
        .prepare('SELECT id, repository FROM publish_repositories ORDER BY repository')
        .all(),
    })
  }
  if (path === '/api/admin/repositories' && method === 'POST') {
    const body = await readJson(request, 4096)
    const repository = organizationRepository(
      typeof body.repository === 'string' ? body.repository.trim() : undefined,
    )
    const id = typeof body.id === 'string' ? body.id.trim() : undefined
    if (!repository || !validNumericId(id))
      throw new HttpError(400, '请输入 zixiao-labs 组织下的仓库全名和数字 ID。')
    return write(() => {
      const result = db
        .prepare('INSERT OR IGNORE INTO publish_repositories VALUES (?, ?)')
        .run(id, repository)
      if (!result.changes)
        throw new HttpError(409, '该仓库名称或 ID 已获授权。若要更改，请先撤销原授权。')
    })
  }

  const repositoryId = method === 'DELETE' && /^\/api\/admin\/repositories\/(\d+)$/.exec(path)?.[1]
  if (validNumericId(repositoryId)) {
    return write(() => {
      db.prepare('DELETE FROM publish_repositories WHERE id=?').run(repositoryId)
    })
  }
  throw new HttpError(404, '未找到接口。')
}

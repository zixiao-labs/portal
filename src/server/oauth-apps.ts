import { z } from 'zod'
import { oauthAppsPath, oauthScopes, type OAuthApp, type OAuthScope } from '../oauth-app-info'
import { isConfiguredAdmin } from './admin'
import { isEmployeeEmail } from './auth'
import { hash, HttpError, json, opaque, readJson } from './http'
import { activeSession, session } from './session'
import { store, transaction, type User } from './store'

export const clientIdFormat = /^zxa_[A-Za-z0-9_-]{43}$/
type Actor = Pick<User, 'id' | 'employee' | 'email'>

export function employee(user: Actor) {
  return user.employee === 1 && isEmployeeEmail(user.email)
}

export function canUseOAuthScope(user: Actor, scope: OAuthScope) {
  return (
    scope === 'docs:read' || (employee(user) && (scope === 'oauth:apps' || isConfiguredAdmin(user)))
  )
}

function requireEmployee(user: Actor | undefined): Actor {
  if (!user || !employee(user)) throw new HttpError(403, '仅员工账户可以管理 OAuth 应用。')
  return user
}

function validRedirect(value: string) {
  if (!/^https?:\/\//.test(value) || /[^\x21-\x7e]|[\\#"]/.test(value)) return false
  const url = URL.parse(value)
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) &&
    !['code', 'state', 'error', 'error_description'].some((key) => url.searchParams.has(key))
  )
}

export const appRegistration = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  redirectUris: z.array(z.string().max(512).refine(validRedirect)).min(1).max(5),
  scope: z.enum(oauthScopes),
})

export type RegisteredApp = {
  client_id: string
  client_hash: string
  owner_id: number
  name: string
  redirect_uris: string
  scope: OAuthScope
}

export function registeredApp(clientId: string) {
  if (!clientIdFormat.test(clientId)) return
  return store().prepare('SELECT * FROM oauth_apps WHERE client_id=?').get(clientId) as
    | RegisteredApp
    | undefined
}

export function redirectUris(app: RegisteredApp): string[] {
  return JSON.parse(app.redirect_uris) as string[]
}

export function availableApp(clientHash: string) {
  const app = store()
    .prepare(`SELECT a.*, u.id, u.email, u.employee FROM oauth_apps a
    JOIN users u ON u.id=a.owner_id WHERE a.client_hash=?
      AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=u.id)`)
    .get(clientHash) as (RegisteredApp & Actor) | undefined
  if (app && employee(app) && canUseOAuthScope(app, app.scope)) return app
}

export function canAuthorizeApp(user: Actor, app: RegisteredApp) {
  return (
    canUseOAuthScope(user, app.scope) && (app.scope === 'docs:read' || user.id === app.owner_id)
  )
}

function describeApp(app: RegisteredApp, activeTokens = 0): OAuthApp {
  return {
    clientId: app.client_id,
    name: app.name,
    redirectUris: redirectUris(app),
    scope: app.scope,
    activeTokens,
  }
}

// Call mutations inside the caller's transaction after validating its session or bearer.
export function registerOAuthApp(actor: Actor, input: unknown) {
  requireEmployee(actor)
  const parsed = appRegistration.safeParse(input)
  if (!parsed.success)
    throw new HttpError(
      400,
      '请填写有效的应用名称、权限和回调地址（1 至 5 个 HTTPS 或本地回环地址）。',
    )
  const { name, redirectUris: uris, scope } = parsed.data
  if (!canUseOAuthScope(actor, scope)) throw new HttpError(403, '当前账户不能注册此权限。')
  const db = store()
  if (
    Number(
      db.prepare('SELECT count(*) AS total FROM oauth_apps WHERE owner_id=?').get(actor.id)?.total,
    ) >= 20
  )
    throw new HttpError(409, '已达到 20 个 OAuth 应用的上限，请先取消不再使用的注册。')
  const clientId = `zxa_${opaque()}`
  const app = db
    .prepare(`INSERT INTO oauth_apps (client_id, client_hash, owner_id, name, redirect_uris, scope)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(
      clientId,
      hash(clientId),
      actor.id,
      name,
      JSON.stringify([...new Set(uris)]),
      scope,
    ) as RegisteredApp
  return describeApp(app)
}

export function listOAuthApps(actor: Actor) {
  requireEmployee(actor)
  const time = Math.floor(Date.now() / 1000)
  const apps = store()
    .prepare(`SELECT a.*, (
    SELECT count(*) FROM mcp_grants g JOIN sessions s ON s.hash=g.session_hash
    WHERE g.client_hash=a.client_hash AND g.credential_hash IS NOT NULL
      AND g.code_challenge IS NULL AND g.expires>? AND s.expires>?
      AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=s.user_id)
  ) AS active_tokens FROM oauth_apps a WHERE a.owner_id=? ORDER BY a.rowid DESC`)
    .all(time, time, actor.id) as (RegisteredApp & { active_tokens: number })[]
  return {
    apps: apps.map((app) =>
      describeApp(app, canUseOAuthScope(actor, app.scope) ? app.active_tokens : 0),
    ),
    allowedScopes: oauthScopes.filter((scope) => canUseOAuthScope(actor, scope)),
  }
}

export function clearOAuthTokens(actor: Actor, clientId: string) {
  const app = ownedApp(actor, clientId)
  const result = store()
    .prepare(`DELETE FROM mcp_grants
    WHERE client_hash=? AND credential_hash IS NOT NULL AND expires>?`)
    .run(app.client_hash, Math.floor(Date.now() / 1000))
  return { clientId, revoked: Number(result.changes) }
}

export function unregisterOAuthApp(actor: Actor, clientId: string) {
  const app = ownedApp(actor, clientId)
  const db = store()
  db.prepare('DELETE FROM mcp_grants WHERE client_hash=?').run(app.client_hash)
  db.prepare('DELETE FROM oauth_apps WHERE client_id=?').run(app.client_id)
  return { clientId, removed: true }
}

function ownedApp(actor: Actor, clientId: string) {
  requireEmployee(actor)
  const app = registeredApp(clientId)
  if (!app || app.owner_id !== actor.id) throw new HttpError(404, '未找到 OAuth 应用。')
  return app
}

export async function oauthAppsApi(request: Request, path: string) {
  const current = await session(request)
  if (!current) throw new HttpError(401, '请先登录。')
  const actor = requireEmployee(current.user)
  const write = (operation: (user: Actor) => unknown, status = 200) =>
    json(
      transaction(store(), () =>
        operation(requireEmployee(activeSession(current.tokenHash, String(actor.id)))),
      ),
      status,
    )
  if (path === oauthAppsPath && request.method === 'GET') return json(listOAuthApps(actor))
  if (path === oauthAppsPath && request.method === 'POST') {
    const input = await readJson(request, 4096)
    return write((user) => registerOAuthApp(user, input), 201)
  }
  const [clientId, suffix, ...rest] = path.slice(oauthAppsPath.length + 1).split('/')
  if (request.method === 'DELETE' && clientIdFormat.test(clientId) && !rest.length) {
    if (suffix === 'tokens') return write((user) => clearOAuthTokens(user, clientId))
    if (suffix === undefined) return write((user) => unregisterOAuthApp(user, clientId))
  }
  throw new HttpError(404, '未找到接口。')
}

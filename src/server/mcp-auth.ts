import { createHmac } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import { oauthScopes } from '../oauth-app-info'
import { config } from './config'
import {
  checkOrigin,
  cookie,
  cookieName,
  hash,
  HttpError,
  json,
  opaque,
  readBody,
  setCookie,
} from './http'
import { availableApp, canAuthorizeApp, clientIdFormat, redirectUris } from './oauth-apps'
import { activeSession, session } from './session'
import { store, transaction } from './store'

export const mcpPath = '/api/mcp'
const oauthPath = `${mcpPath}/oauth`
const metadataPath = '/.well-known/oauth-protected-resource'
const consentAge = 10 * 60
const tokenAge = 30 * 60
const now = () => Math.floor(Date.now() / 1000)
const proofFormat = /^[A-Za-z0-9_-]{43}$/
const verifierFormat = /^[A-Za-z0-9._~-]{43,128}$/
const tokenFormat = /^zxm_[A-Za-z0-9_-]{43}$/
// Rollback keeps SQLite and PORTAL_SECRET. The previous server treats every
// recognized administrator credential as docs:repositories, so never reuse
// its HMAC namespace, even for a new credential with that same scope.
const credentialHash = (kind: 'code' | 'token', value: string) =>
  createHmac('sha256', config().secret)
    .update(`portal-oauth-v2-${kind}\0`)
    .update(value)
    .digest('hex')

function authHeaders() {
  return new Headers({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
  })
}

export function mcpMetadata(request: Request, path: string, origin: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  const endpoint = (name: string) => `${origin}${oauthPath}/${name}`
  const data =
    path === `${metadataPath}${mcpPath}` || path === metadataPath
      ? {
          resource: origin + mcpPath,
          authorization_servers: [origin],
          bearer_methods_supported: ['header'],
        }
      : path === '/.well-known/oauth-authorization-server'
        ? {
            issuer: origin,
            authorization_endpoint: endpoint('authorize'),
            token_endpoint: endpoint('token'),
            revocation_endpoint: endpoint('revoke'),
            scopes_supported: oauthScopes,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
          }
        : undefined
  if (data) {
    if (request.method === 'HEAD')
      return new Response(null, {
        headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex' },
      })
    return json(data)
  }
}

export function mcpChallenge(invalid = false) {
  const { origin } = config()
  const headers = authHeaders()
  headers.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${origin}${metadataPath}${mcpPath}"${invalid ? ', error="invalid_token"' : ''}`,
  )
  return Response.json(
    { error: invalid ? 'invalid_token' : 'authorization_required' },
    {
      status: 401,
      headers,
    },
  )
}

class OAuthError extends HttpError {
  constructor(
    public code: string,
    message: string,
    status = 400,
  ) {
    super(status, message)
  }
}

const invalidRequest = () => new OAuthError('invalid_request', 'Invalid OAuth request.')
const invalidGrant = () => new OAuthError('invalid_grant', 'Invalid or expired authorization code.')

// Also keep a pending consent from being approved under the old scope rules.
const consentType = 'portal-oauth-v2-consent+jwt'
function consentKey() {
  return createHmac('sha256', config().secret).update(consentType).digest()
}

const pendingSchema = z.object({
  jti: z.string().regex(proofFormat),
  exp: z.number(),
  client_hash: z.string().regex(proofFormat),
  redirect_uri: z.string(),
  code_challenge: z.string().regex(proofFormat),
  state: z.string().optional(),
})
type Pending = z.infer<typeof pendingSchema>

function one(params: URLSearchParams, name: string) {
  const values = params.getAll(name)
  if (values.length > 1) throw invalidRequest()
  return values[0]
}

function resourceFor(params: URLSearchParams, origin: string) {
  const resource = origin + mcpPath
  const requested = one(params, 'resource')
  // Older clients may omit RFC 8707's parameter. There is only one resource;
  // in both versions the issued credential is bound to its exact URL.
  if (requested !== undefined && requested !== resource)
    throw new OAuthError('invalid_target', 'Resource must be the Portal MCP endpoint.')
  return resource
}

function oauthRedirect(target: string, cookies: string[] = []) {
  const headers = authHeaders()
  headers.set('Location', target)
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(null, { status: 303, headers })
}

async function authorize(request: Request, origin: string) {
  const params = new URL(request.url).searchParams
  const clientId = one(params, 'client_id') ?? ''
  const redirectUri = one(params, 'redirect_uri') ?? ''
  const app = clientIdFormat.test(clientId) ? availableApp(hash(clientId)) : undefined
  if (!app || !redirectUris(app).includes(redirectUri)) throw invalidRequest()

  const state = one(params, 'state')
  if (state !== undefined && state.length > 256) throw invalidRequest()
  const reply = new URL(redirectUri)
  if (state !== undefined) reply.searchParams.set('state', state)
  const challenge = one(params, 'code_challenge') ?? ''
  try {
    if (one(params, 'response_type') !== 'code')
      throw new OAuthError('unsupported_response_type', 'Use response_type=code.')
    const scope = one(params, 'scope')
    if (scope !== undefined && scope !== app.scope)
      throw new OAuthError('invalid_scope', `This application is registered for ${app.scope}.`)
    resourceFor(params, origin)
    if (one(params, 'code_challenge_method') !== 'S256' || !proofFormat.test(challenge))
      throw new OAuthError('invalid_request', 'S256 PKCE is required.')
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error
    reply.searchParams.set('error', error.code)
    reply.searchParams.set('error_description', error.message)
    return oauthRedirect(reply.href)
  }
  const pending: Pending = {
    jti: opaque(),
    exp: now() + consentAge,
    client_hash: app.client_hash,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
  }
  const flow = await new SignJWT(pending)
    .setProtectedHeader({ alg: 'HS256', typ: consentType })
    .setIssuer(origin)
    .setAudience(origin + mcpPath)
    .sign(consentKey())
  return oauthRedirect(`${origin}/login?mcp=true`, [
    setCookie(origin, cookieName(origin, 'mcp_consent'), flow, consentAge),
  ])
}

async function readForm(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  )
    throw invalidRequest()
  return new URLSearchParams(await readBody(request, 8192))
}

async function readConsent(flow: string | undefined, origin: string) {
  if (!flow || flow.length > 4096) return
  try {
    return (
      await jwtVerify(flow, consentKey(), {
        algorithms: ['HS256'],
        typ: consentType,
        issuer: origin,
        audience: origin + mcpPath,
      })
    ).payload
  } catch {
    return
  }
}

async function consent(request: Request, origin: string) {
  const name = cookieName(origin, 'mcp_consent')
  const parsed = pendingSchema.safeParse(await readConsent(cookie(request, name), origin))
  if (!parsed.success) throw new HttpError(400, '授权请求已过期。请返回客户端重新连接。')
  const pending = parsed.data
  const unavailable = () => new HttpError(403, '此 OAuth 应用已不可用。')
  const app = availableApp(pending.client_hash)
  if (!app) throw unavailable()
  const current = await session(request)
  const emailRequired = app.scope !== 'docs:read'
  if (current && !canAuthorizeApp(current.user, app))
    throw new HttpError(403, '当前账户不能授权此应用。')
  const consentId =
    current && (!emailRequired || current.byEmail)
      ? hash(`${pending.jti}:${current.tokenHash}`)
      : undefined
  if (request.method === 'GET') {
    return json({
      appName: app.name,
      scope: app.scope,
      redirectUri: pending.redirect_uri,
      ...(consentId
        ? { stage: 'approve', id: consentId }
        : { stage: emailRequired ? 'work-email' : 'sign-in' }),
    })
  }
  if (!current || !consentId) throw new HttpError(403, '请先使用符合此应用权限要求的账户登录。')
  const form = await readForm(request)
  const decision = one(form, 'decision')
  if (one(form, 'id') !== consentId || (decision !== 'approve' && decision !== 'deny'))
    throw new HttpError(400, '授权请求已更改。请返回 MCP 客户端重新连接。')

  const db = store()
  const code = decision === 'approve' ? opaque() : undefined
  transaction(db, () => {
    const registered = availableApp(pending.client_hash)
    if (!registered) throw unavailable()
    const user = activeSession(current.tokenHash, String(current.user.id))
    if (!user || !canAuthorizeApp(user, registered)) throw new HttpError(403, '授权会话已失效。')
    const time = now()
    if (pending.exp <= time) throw new HttpError(400, '授权请求已过期。')
    db.prepare('DELETE FROM oauth_consumed_flows WHERE expires<=?').run(time)
    const consumed = db
      .prepare('INSERT OR IGNORE INTO oauth_consumed_flows VALUES (?, ?)')
      .run(pending.jti, pending.exp)
    if (!consumed.changes) throw new HttpError(409, '授权请求已处理。')
    if (!code) return
    db.prepare('DELETE FROM mcp_grants WHERE expires<=?').run(time)
    db.prepare(`INSERT INTO mcp_grants
      (flow_id, credential_hash, session_hash, client_hash, resource, redirect_uri, code_challenge, expires)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      pending.jti,
      credentialHash('code', code),
      current.tokenHash,
      pending.client_hash,
      origin + mcpPath,
      pending.redirect_uri,
      pending.code_challenge,
      pending.exp,
    )
  })
  const redirect = new URL(pending.redirect_uri)
  if (pending.state !== undefined) redirect.searchParams.set('state', pending.state)
  if (code) redirect.searchParams.set('code', code)
  else redirect.searchParams.set('error', 'access_denied')
  return oauthRedirect(redirect.href, [setCookie(origin, name, '', 0)])
}

async function exchange(request: Request, origin: string) {
  const form = await readForm(request)
  if (one(form, 'grant_type') !== 'authorization_code')
    throw new OAuthError('unsupported_grant_type', 'Only authorization_code is supported.')
  const resource = resourceFor(form, origin)
  const code = one(form, 'code') ?? ''
  const clientId = one(form, 'client_id') ?? ''
  const redirect = one(form, 'redirect_uri') ?? ''
  const verifier = one(form, 'code_verifier') ?? ''
  if (
    !proofFormat.test(code) ||
    !verifierFormat.test(verifier) ||
    !clientIdFormat.test(clientId) ||
    !redirect
  )
    throw invalidGrant()

  const db = store()
  return transaction(db, () => {
    const time = now()
    const app = availableApp(hash(clientId))
    if (!app) throw invalidGrant()
    const grant = db
      .prepare(`SELECT g.flow_id, s.expires AS session_expires, u.id, u.email, u.employee
      FROM mcp_grants g JOIN sessions s ON s.hash=g.session_hash JOIN users u ON u.id=s.user_id
      WHERE g.credential_hash=? AND g.client_hash=? AND g.resource=? AND g.redirect_uri=?
        AND g.code_challenge=? AND g.expires>? AND s.expires>?
        AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=u.id)`)
      .get(
        credentialHash('code', code),
        app.client_hash,
        resource,
        redirect,
        hash(verifier),
        time,
        time,
      ) as
      | { flow_id: string; session_expires: number; id: number; email: string; employee: number }
      | undefined
    if (!grant || !canAuthorizeApp(grant, app)) throw invalidGrant()
    const token = `zxm_${opaque()}`
    const expires = Math.min(time + tokenAge, grant.session_expires)
    db.prepare(`UPDATE mcp_grants SET credential_hash=?, code_challenge=NULL, expires=?
      WHERE flow_id=?`).run(credentialHash('token', token), expires, grant.flow_id)
    return json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expires - time,
      scope: app.scope,
    })
  })
}

async function revoke(request: Request, origin: string) {
  const form = await readForm(request)
  const token = one(form, 'token') ?? ''
  const clientId = one(form, 'client_id') ?? ''
  if (!token || !clientId) throw invalidRequest()
  if (tokenFormat.test(token)) {
    store()
      .prepare(`DELETE FROM mcp_grants
      WHERE credential_hash=? AND client_hash=? AND resource=? AND code_challenge IS NULL`)
      .run(credentialHash('token', token), hash(clientId), origin + mcpPath)
  }
  return new Response(null, { headers: authHeaders() })
}

export function mcpAccess(token: string, resource: string) {
  if (!tokenFormat.test(token)) return
  const time = now()
  const grant = store()
    .prepare(`SELECT g.client_hash, u.id, u.email, u.employee
    FROM mcp_grants g JOIN sessions s ON s.hash=g.session_hash JOIN users u ON u.id=s.user_id
    WHERE g.credential_hash=? AND g.resource=? AND g.code_challenge IS NULL
      AND g.expires>? AND s.expires>?
      AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=u.id)`)
    .get(credentialHash('token', token), resource, time, time) as
    | { client_hash: string; id: number; email: string; employee: number }
    | undefined
  const app = grant && availableApp(grant.client_hash)
  if (grant && app && canAuthorizeApp(grant, app)) return { user: grant, scope: app.scope }
}

export async function mcpOAuth(request: Request, path: string, origin: string) {
  const { method } = request
  try {
    if (path === `${oauthPath}/consent`) {
      if (method === 'POST') checkOrigin(request, origin)
      if (method === 'GET' || method === 'POST') return await consent(request, origin)
    }
    if (path === `${oauthPath}/authorize` && method === 'GET')
      return await authorize(request, origin)
    if (path === `${oauthPath}/token` && method === 'POST') return await exchange(request, origin)
    if (path === `${oauthPath}/revoke` && method === 'POST') return await revoke(request, origin)
    throw new HttpError(404, '未找到接口。')
  } catch (error) {
    if (error instanceof OAuthError)
      return json({ error: error.code, error_description: error.message }, error.status)
    if (error instanceof HttpError && path !== `${oauthPath}/consent` && error.status !== 404)
      return json({ error: 'invalid_request', error_description: error.message }, error.status)
    throw error
  }
}

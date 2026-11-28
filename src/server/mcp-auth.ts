import { createHmac } from 'node:crypto'
import { jwtVerify, SignJWT, type JWTPayload } from 'jose'
import { z } from 'zod'
import { adminAccess, isConfiguredAdmin } from './admin'
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
  readJson,
  setCookie,
} from './http'
import { activeSession, session } from './session'
import { store, transaction } from './store'

export const mcpPath = '/api/mcp'
const oauthPath = `${mcpPath}/oauth`
export const mcpScope = 'docs:repositories'
const metadataPath = '/.well-known/oauth-protected-resource'
const consentAge = 10 * 60
const tokenAge = 30 * 60
const now = () => Math.floor(Date.now() / 1000)
const proofFormat = /^[A-Za-z0-9_-]{43}$/
const verifierFormat = /^[A-Za-z0-9._~-]{43,128}$/
const tokenFormat = /^zxm_[A-Za-z0-9_-]{43}$/
const credentialHash = (value: string) =>
  createHmac('sha256', config().secret)
    .update('portal-mcp-credential\0')
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
          scopes_supported: [mcpScope],
          bearer_methods_supported: ['header'],
        }
      : path === '/.well-known/oauth-authorization-server'
        ? {
            issuer: origin,
            authorization_endpoint: endpoint('authorize'),
            token_endpoint: endpoint('token'),
            registration_endpoint: endpoint('register'),
            revocation_endpoint: endpoint('revoke'),
            scopes_supported: [mcpScope],
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
    `Bearer resource_metadata="${origin}${metadataPath}${mcpPath}", scope="${mcpScope}"${invalid ? ', error="invalid_token"' : ''}`,
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

function signer(type: string) {
  const { origin, secret } = config()
  const key = createHmac('sha256', secret).update(type).digest()
  return {
    sign: (claims: JWTPayload) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', typ: type })
        .setIssuer(origin)
        .setAudience(origin + mcpPath)
        .sign(key),
    verify: async (value: string) => {
      try {
        return (
          await jwtVerify(value, key, {
            algorithms: ['HS256'],
            typ: type,
            issuer: origin,
            audience: origin + mcpPath,
          })
        ).payload
      } catch {
        return
      }
    },
  }
}

const clientType = 'portal-mcp-client+jwt'
const consentType = 'portal-mcp-consent+jwt'

function validRedirect(value: string) {
  if (!/^https?:\/\//.test(value) || /[^\x21-\x7e]|[\\#"]/.test(value)) return false
  const url = URL.parse(value)
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) &&
    !['code', 'state', 'error'].some((key) => url.searchParams.has(key))
  )
}

// Immutable, authenticated client descriptors avoid allocating database rows to anonymous
// registrants. A client must still get explicit approval from an email-verified administrator.
const redirectUris = z.array(z.string().max(512).refine(validRedirect)).min(1).max(5)
const clientMetadata = z.object({
  redirect_uris: redirectUris,
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z
    .array(z.string())
    .refine((values) => values.includes('authorization_code'))
    .optional(),
  response_types: z
    .array(z.string())
    .refine((values) => values.includes('code'))
    .optional(),
})

async function registerClient(request: Request) {
  const parsed = clientMetadata.safeParse(await readJson(request, 8192))
  if (!parsed.success)
    throw new OAuthError(
      'invalid_client_metadata',
      'Register a public code client with HTTPS or loopback redirect URIs.',
    )
  const redirect_uris = [...new Set(parsed.data.redirect_uris)].sort()
  return json(
    {
      client_id: await signer(clientType).sign({ jti: opaque(), redirect_uris }),
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: mcpScope,
    },
    201,
  )
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
  const client = clientId.length <= 4096 ? await signer(clientType).verify(clientId) : undefined
  const redirects = redirectUris.safeParse(client?.redirect_uris)
  if (!redirects.success || !redirects.data.includes(redirectUri)) throw invalidRequest()

  const state = one(params, 'state')
  if (state !== undefined && state.length > 256) throw invalidRequest()
  const reply = new URL(redirectUri)
  if (state !== undefined) reply.searchParams.set('state', state)
  const challenge = one(params, 'code_challenge') ?? ''
  try {
    if (one(params, 'response_type') !== 'code')
      throw new OAuthError('unsupported_response_type', 'Use response_type=code.')
    const scope = one(params, 'scope')
    if (scope !== undefined && scope !== mcpScope)
      throw new OAuthError('invalid_scope', `Only ${mcpScope} is supported.`)
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
    client_hash: hash(clientId),
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
  }
  const flow = await signer(consentType).sign(pending)
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

async function consent(request: Request, origin: string) {
  const name = cookieName(origin, 'mcp_consent')
  const flow = cookie(request, name)
  const parsed = pendingSchema.safeParse(
    flow && flow.length <= 4096 ? await signer(consentType).verify(flow) : undefined,
  )
  if (!parsed.success) throw new HttpError(400, '授权请求已过期。请返回 MCP 客户端重新连接。')
  const pending = parsed.data
  const current = await session(request)
  const access = current && adminAccess(current)
  if (current && !access) throw new HttpError(403, '仅门户管理员可以授权 MCP 客户端。')
  if (request.method === 'GET') {
    return json(
      access === 'granted'
        ? { verifyEmail: false, id: pending.jti, redirectUri: pending.redirect_uri }
        : { verifyEmail: true },
    )
  }
  if (!current || access !== 'granted') throw new HttpError(403, '请先验证管理员工作邮箱。')
  const form = await readForm(request)
  const decision = one(form, 'decision')
  if (one(form, 'id') !== pending.jti || (decision !== 'approve' && decision !== 'deny'))
    throw new HttpError(400, '授权请求已更改。请返回 MCP 客户端重新连接。')

  const db = store()
  const code = decision === 'approve' ? opaque() : undefined
  transaction(db, () => {
    const user = activeSession(current.tokenHash, String(current.user.id))
    if (!user || !isConfiguredAdmin(user)) throw new HttpError(403, '管理会话已失效。')
    if (pending.exp <= now()) throw new HttpError(400, '授权请求已过期。')
    db.prepare('DELETE FROM mcp_grants WHERE expires<=?').run(now())
    const result = db
      .prepare(`INSERT INTO mcp_grants
      (flow_id, credential_hash, session_hash, client_hash, resource, redirect_uri, code_challenge, expires)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(flow_id) DO NOTHING`)
      .run(
        pending.jti,
        code ? credentialHash(code) : null,
        current.tokenHash,
        pending.client_hash,
        origin + mcpPath,
        pending.redirect_uri,
        pending.code_challenge,
        pending.exp,
      )
    if (!result.changes) throw new HttpError(409, '授权请求已处理。')
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
  if (!proofFormat.test(code) || !verifierFormat.test(verifier) || !clientId || !redirect)
    throw invalidGrant()

  const db = store()
  return transaction(db, () => {
    const time = now()
    const grant = db
      .prepare(`SELECT g.flow_id, s.expires AS session_expires, u.email, u.employee
      FROM mcp_grants g JOIN sessions s ON s.hash=g.session_hash JOIN users u ON u.id=s.user_id
      WHERE g.credential_hash=? AND g.client_hash=? AND g.resource=? AND g.redirect_uri=?
        AND g.code_challenge=? AND g.expires>? AND s.expires>?
        AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=u.id)`)
      .get(credentialHash(code), hash(clientId), resource, redirect, hash(verifier), time, time) as
      | { flow_id: string; session_expires: number; email: string; employee: number }
      | undefined
    if (!grant || !isConfiguredAdmin(grant)) throw invalidGrant()
    const token = `zxm_${opaque()}`
    const expires = Math.min(time + tokenAge, grant.session_expires)
    db.prepare(`UPDATE mcp_grants SET credential_hash=?, code_challenge=NULL, expires=?
      WHERE flow_id=?`).run(credentialHash(token), expires, grant.flow_id)
    return json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expires - time,
      scope: mcpScope,
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
      .prepare(`UPDATE mcp_grants SET credential_hash=NULL
      WHERE credential_hash=? AND client_hash=? AND resource=? AND code_challenge IS NULL`)
      .run(credentialHash(token), hash(clientId), origin + mcpPath)
  }
  return new Response(null, { headers: authHeaders() })
}

export function mcpAccess(token: string, resource: string) {
  if (!tokenFormat.test(token)) return false
  const grant = store()
    .prepare(`SELECT u.email, u.employee
    FROM mcp_grants g JOIN sessions s ON s.hash=g.session_hash JOIN users u ON u.id=s.user_id
    WHERE g.credential_hash=? AND g.resource=? AND g.code_challenge IS NULL
      AND g.expires>? AND s.expires>?
      AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=u.id)`)
    .get(credentialHash(token), resource, now(), now()) as
    | { email: string; employee: number }
    | undefined
  return Boolean(grant && isConfiguredAdmin(grant))
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
    if (path === `${oauthPath}/register` && method === 'POST') return await registerClient(request)
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

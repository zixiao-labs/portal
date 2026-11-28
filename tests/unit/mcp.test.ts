import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { api } from '../../src/server/api'
import { verifiedEmailUser } from '../../src/server/auth'
import { hash, opaque } from '../../src/server/http'
import { mcpMetadata } from '../../src/server/mcp-auth'
import { newSession } from '../../src/server/session'
import { canPublish, store } from '../../src/server/store'

const origin = 'http://localhost:3000'
const resource = `${origin}/api/mcp`
const oauth = '/api/mcp/oauth'
const callback = 'http://127.0.0.1:57321/callback'
const scope = 'docs:repositories'
const adminEmail = 'mcp-admin@zixiaolabs.com'
const testSecret = 'fake-mcp-test-secret'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const jsonBody = (body: object) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const form = (body: Record<string, string>, headers?: HeadersInit) => ({
  method: 'POST',
  headers,
  body: new URLSearchParams(body),
})

beforeAll(() => {
  vi.stubEnv('SQLITE_PATH', ':memory:')
  vi.stubEnv('PORTAL_RUNTIME_MODE', 'test')
  vi.stubEnv('PORTAL_ORIGIN', origin)
  vi.stubEnv('PORTAL_ADMIN_EMAILS', adminEmail)
  vi.stubEnv('PORTAL_SECRET', testSecret)
  vi.stubEnv('GITHUB_ORG_ID', '11')
})
afterAll(() => {
  store().close()
  vi.unstubAllEnvs()
})

async function request(input: URL | string | Request, init?: RequestInit) {
  const req = new Request(typeof input === 'string' ? new URL(input, origin) : input, init)
  const url = new URL(req.url)
  expect(url.origin).toBe(origin)
  return mcpMetadata(req, url.pathname, origin) ?? api(req, url.pathname)
}

async function browserSession(email: string, method: 'email' | 'github' = 'email') {
  return (await newSession(new Request(origin), verifiedEmailUser(email), method)).split(';')[0]
}

function cookieFrom(response: Response) {
  return response.headers.get('set-cookie')!.split(';')[0]
}

async function startFlow(overrides: Record<string, string> = {}) {
  const registration = await request(
    `${oauth}/register`,
    jsonBody({
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
    }),
  )
  expect(registration.status).toBe(201)
  const { client_id } = await registration.json()
  const verifier = opaque()
  const pending = await request(
    `${oauth}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: callback,
      code_challenge_method: 'S256',
      code_challenge: hash(verifier),
      resource,
      scope,
      state: 'client-state',
      ...overrides,
    })}`,
  )
  return { pending, client_id, verifier }
}

async function approve(pending: Response, sessionCookie: string, decision = 'approve') {
  expect(pending.headers.get('location')).toBe(`${origin}/login?mcp=true`)
  const headers = { cookie: `${sessionCookie}; ${cookieFrom(pending)}`, origin }
  const view = await request(`${oauth}/consent`, { headers })
  const { id } = await view.json()
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const approve = () => request(`${oauth}/consent`, form({ id, decision }, headers))
  const result = await approve()
  expect(result.status).toBe(303)
  const redirect = new URL(result.headers.get('location')!)
  expect(redirect.origin + redirect.pathname).toBe(callback)
  expect(redirect.searchParams.get('state')).toBe('client-state')
  expect((await approve()).status).toBe(409)
  return redirect.searchParams
}

test('a real MCP SDK client discovers OAuth and manages the same grants as the admin API', async () => {
  let registered: OAuthClientInformationMixed | undefined
  let tokens: OAuthTokens | undefined
  let authorizationUrl: URL | undefined
  let verifier = ''
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: { redirect_uris: [callback], token_endpoint_auth_method: 'none' },
    clientInformation: () => registered,
    saveClientInformation: (value) => {
      registered = value
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value
    },
    state: () => 'client-state',
    redirectToAuthorization: (url) => {
      authorizationUrl = url
    },
    codeVerifier: () => verifier,
    saveCodeVerifier: (value) => {
      verifier = value
    },
  }
  const client = new Client({ name: 'test-client', version: '1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    fetch: request,
    authProvider: provider,
  })
  await expect(client.connect(transport)).rejects.toThrow()
  expect(registered).toBeDefined()
  expect(authorizationUrl?.pathname).toBe(`${oauth}/authorize`)
  expect(authorizationUrl?.searchParams.get('resource')).toBe(resource)
  const cookie = await browserSession(adminEmail)
  const params = await approve(await request(authorizationUrl!), cookie)
  await transport.finishAuth(params.get('code')!)
  expect(tokens).toMatchObject({
    access_token: expect.stringMatching(/^zxm_/),
    scope,
    token_type: 'Bearer',
  })
  expect(tokens!.expires_in).toBeGreaterThan(0)
  expect(tokens!.expires_in).toBeLessThanOrEqual(1800)
  expect(tokens?.refresh_token).toBeUndefined()
  expect(
    store().prepare('SELECT credential_hash FROM mcp_grants WHERE code_challenge IS NULL').get()
      ?.credential_hash,
  ).toMatch(/^[a-f0-9]{64}$/)

  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      fetch: request,
      authProvider: provider,
    }),
  )
  try {
    const register = 'register_publish_repository'
    const unregister = 'unregister_publish_repository'
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([register, unregister])
    const repository = { id: '123456', repository: 'zixiao-labs/Handbook' }
    expect(
      await client.callTool({
        name: register,
        arguments: { ...repository, repository: 'other/handbook' },
      }),
    ).toMatchObject({ isError: true })
    expect(await client.callTool({ name: register, arguments: repository })).toMatchObject({
      structuredContent: { id: repository.id, repository: 'zixiao-labs/handbook' },
    })
    expect(canPublish(repository.id, 'zixiao-labs/handbook')).toBe(true)
    expect(await client.callTool({ name: register, arguments: repository })).toMatchObject({
      isError: true,
    })
    const adminList = await request('/api/admin/repositories', { headers: { cookie } })
    expect(await adminList.json()).toMatchObject({ repositories: [{ id: repository.id }] })
    const db = store()
    db.prepare('INSERT INTO collections VALUES (?, ?, ?, ?, ?)').run(
      'handbook',
      'zixiao-labs/handbook',
      repository.id,
      'a'.repeat(40),
      1,
    )
    expect(
      await client.callTool({ name: unregister, arguments: { id: repository.id } }),
    ).toMatchObject({ structuredContent: { id: repository.id, removed: true } })
    expect(canPublish(repository.id, 'zixiao-labs/handbook')).toBe(false)
    expect(db.prepare('SELECT 1 FROM collections WHERE name=?').get('handbook')).toBeDefined()
    expect(
      await client.callTool({ name: unregister, arguments: { id: repository.id } }),
    ).toMatchObject({ structuredContent: { id: repository.id, removed: false } })

    const headers = bearer(tokens!.access_token)
    expect((await request('/api/admin/repositories', { headers })).status).toBe(401)
    expect((await request('/api/cli/users', { headers })).status).toBe(401)
    expect((await request('/api/publish', { method: 'POST', headers })).status).toBe(401)
    expect((await request(resource, { headers: { cookie } })).status).toBe(401)
    expect((await request(resource, { headers: bearer(`zxc_${opaque()}`) })).status).toBe(401)
    expect(
      (await request(resource, { headers: { ...headers, origin: 'https://other.example' } }))
        .status,
    ).toBe(403)
    expect((await request(resource, { headers })).status).toBe(405)
    vi.stubEnv('PORTAL_ADMIN_EMAILS', '')
    expect((await request(resource, { headers })).status).toBe(401)
    vi.stubEnv('PORTAL_ADMIN_EMAILS', adminEmail)
    vi.stubEnv('PORTAL_SECRET', 'rotated-test-secret')
    expect((await request(resource, { headers })).status).toBe(401)
    vi.stubEnv('PORTAL_SECRET', testSecret)
    expect(
      (
        await request(
          `${oauth}/revoke`,
          form({ token: tokens!.access_token, client_id: registered!.client_id }),
        )
      ).status,
    ).toBe(200)
    expect((await request(resource, { headers })).status).toBe(401)
  } finally {
    vi.stubEnv('PORTAL_ADMIN_EMAILS', adminEmail)
    vi.stubEnv('PORTAL_SECRET', testSecret)
    await client.close()
  }
})

test('OAuth requires explicit email-admin approval, exact bindings and a single-use code', async () => {
  const challenge = await request(resource)
  expect(challenge.status).toBe(401)
  expect(challenge.headers.get('www-authenticate')).toContain(
    `${origin}/.well-known/oauth-protected-resource/api/mcp`,
  )
  const github = await browserSession(adminEmail, 'github')
  const admin = await browserSession(adminEmail)
  const member = await browserSession('member@zixiaolabs.com')
  const { pending, verifier, client_id } = await startFlow()
  const pendingCookie = cookieFrom(pending)
  const consents = (session: string, method = 'GET', source?: string) =>
    request(`${oauth}/consent`, {
      method,
      headers: {
        cookie: `${session}; ${pendingCookie}`,
        ...(source ? { origin: source } : {}),
      },
    })
  expect(await (await consents('')).json()).toEqual({ verifyEmail: true })
  expect(await (await consents(github)).json()).toEqual({ verifyEmail: true })
  expect((await consents(github, 'POST', origin)).status).toBe(403)
  expect((await consents(member)).status).toBe(403)
  expect((await consents(admin, 'POST', 'https://other.example')).status).toBe(403)
  expect(
    (
      await request(`${oauth}/consent`, {
        headers: { cookie: `${admin}; ${pendingCookie}tampered` },
      })
    ).status,
  ).toBe(400)

  const denied = await approve((await startFlow()).pending, admin, 'deny')
  expect(denied.get('error')).toBe('access_denied')
  expect(denied.has('code')).toBe(false)
  const code = (await approve(pending, admin)).get('code')!
  const exchange = (overrides: Record<string, string> = {}) =>
    request(
      `${oauth}/token`,
      form({
        grant_type: 'authorization_code',
        client_id,
        redirect_uri: callback,
        resource,
        code,
        code_verifier: verifier,
        ...overrides,
      }),
    )
  const invalidBindings: Record<string, string>[] = [
    { code_verifier: opaque() },
    { redirect_uri: `${callback}/other` },
    { client_id: 'another-client' },
  ]
  for (const overrides of invalidBindings) {
    expect(await (await exchange(overrides)).json()).toMatchObject({ error: 'invalid_grant' })
  }
  expect(await (await exchange({ resource: `${origin}/api/publish` })).json()).toMatchObject({
    error: 'invalid_target',
  })
  const { access_token } = await (await exchange()).json()
  expect(access_token).toMatch(/^zxm_/)
  expect(await (await exchange()).json()).toMatchObject({ error: 'invalid_grant' })
  expect((await request(resource, { headers: bearer(access_token) })).status).toBe(405)
  expect(
    (await request(`${oauth}/revoke`, form({ token: access_token, client_id: 'another-client' })))
      .status,
  ).toBe(200)
  expect((await request(resource, { headers: bearer(access_token) })).status).toBe(405)
  const db = store()
  const setExpiry = db.prepare(`UPDATE mcp_grants SET expires=?
    WHERE credential_hash IS NOT NULL AND code_challenge IS NULL AND client_hash=?`)
  setExpiry.run(1, hash(client_id))
  expect((await request(resource, { headers: bearer(access_token) })).status).toBe(401)
  setExpiry.run(Math.floor(Date.now() / 1000) + 60, hash(client_id))
  expect(
    (await request('/api/auth/logout', { method: 'POST', headers: { origin, cookie: admin } }))
      .status,
  ).toBe(200)
  expect((await request(resource, { headers: bearer(access_token) })).status).toBe(401)

  const wrongRedirect = (await startFlow({ redirect_uri: `${callback}/other` })).pending
  expect(wrongRedirect.status).toBe(400)
  expect(wrongRedirect.headers.get('location')).toBeNull()
  for (const [overrides, code] of [
    [{ resource: `${origin}/api/publish` }, 'invalid_target'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ scope: 'admin:users' }, 'invalid_scope'],
  ] as const) {
    const { pending } = await startFlow(overrides)
    expect(new URL(pending.headers.get('location')!).searchParams.get('error')).toBe(code)
    expect(pending.headers.get('set-cookie')).toBeNull()
  }
})

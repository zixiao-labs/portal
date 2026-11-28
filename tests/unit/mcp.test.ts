import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'
import { createHmac } from 'node:crypto'
import { oauthAppsPath, type OAuthApp, type OAuthScope } from '../../src/oauth-app-info'
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
const jsonBody = (body: object, cookie = '') => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', origin, cookie },
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

async function registerApp(cookie: string, appScope: OAuthScope = scope) {
  const registration = await request(
    oauthAppsPath,
    jsonBody({ name: 'Handbook client', redirectUris: [callback], scope: appScope }, cookie),
  )
  expect(registration.status).toBe(201)
  return (await registration.json()) as OAuthApp
}

async function startFlow(overrides: Record<string, string> = {}, app?: OAuthApp) {
  app ??= await registerApp(await browserSession(adminEmail))
  const client_id = app.clientId
  const verifier = opaque()
  const pending = await request(
    `${oauth}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: callback,
      code_challenge_method: 'S256',
      code_challenge: hash(verifier),
      resource,
      scope: app.scope,
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
  const cookie = await browserSession(adminEmail)
  const registered = {
    client_id: (await registerApp(cookie)).clientId,
    issuer: origin,
  }
  let tokens: OAuthTokens | undefined
  let authorizationUrl: URL | undefined
  let verifier = ''
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: { redirect_uris: [callback], token_endpoint_auth_method: 'none' },
    clientInformation: () => registered,
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
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      'search_documents',
      'get_document',
      register,
      unregister,
    ])
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
          form({ token: tokens!.access_token, client_id: registered.client_id }),
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
  expect(await (await consents('')).json()).toMatchObject({ stage: 'work-email' })
  expect(await (await consents(github)).json()).toMatchObject({ stage: 'work-email' })
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

function exchangeCode(flow: Awaited<ReturnType<typeof startFlow>>, code: string) {
  return request(
    `${oauth}/token`,
    form({
      grant_type: 'authorization_code',
      client_id: flow.client_id,
      redirect_uri: callback,
      code,
      code_verifier: flow.verifier,
      resource,
    }),
  )
}

async function tokenFor(app: OAuthApp, cookie: string) {
  const flow = await startFlow({}, app)
  const code = (await approve(flow.pending, cookie)).get('code')!
  const issued = await exchangeCode(flow, code)
  expect(issued.status).toBe(200)
  const { access_token, scope } = await issued.json()
  expect(scope).toBe(app.scope)
  return access_token as string
}

async function connect(token: string) {
  const client = new Client({ name: 'test-client', version: '1.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      fetch: request,
      requestInit: { headers: bearer(token) },
    }),
  )
  return client
}

test('rollback with the same database and secret cannot treat new read-only grants as admin writes', async () => {
  const admin = await browserSession(adminEmail)
  const app = await registerApp(admin, 'docs:read')
  const flow = await startFlow({}, app)
  const pending = cookieFrom(flow.pending).split('=')[1]

  // Freeze the previous release's type/key and DB predicates (f85340b).
  // That release authorized all recognized administrator bearers to write
  // repository grants and never consulted oauth_apps or its scope.
  const legacyType = 'portal-mcp-consent+jwt'
  const legacyKey = createHmac('sha256', testSecret).update(legacyType).digest()
  const verifyLegacyConsent = (value: string) =>
    jwtVerify(value, legacyKey, {
      algorithms: ['HS256'],
      typ: legacyType,
      issuer: origin,
      audience: resource,
    })
  const legacyConsent = await new SignJWT(decodeJwt(pending))
    .setProtectedHeader({ alg: 'HS256', typ: legacyType })
    .sign(legacyKey)
  await expect(verifyLegacyConsent(legacyConsent)).resolves.toMatchObject({
    payload: { client_hash: hash(app.clientId) },
  })
  await expect(verifyLegacyConsent(pending)).rejects.toThrow()
  expect(
    (
      await request(`${oauth}/consent`, {
        headers: { cookie: `${admin}; portal_mcp_consent=${legacyConsent}` },
      })
    ).status,
  ).toBe(400)

  const legacyDigest = (value: string) =>
    createHmac('sha256', testSecret).update('portal-mcp-credential\0').update(value).digest('hex')
  const db = store()
  const time = Math.floor(Date.now() / 1000)
  const adminGrant = `SELECT g.flow_id FROM mcp_grants g
    JOIN sessions s ON s.hash=g.session_hash JOIN users u ON u.id=s.user_id
    WHERE g.credential_hash=? AND g.resource=? AND g.expires>? AND s.expires>?
      AND u.employee=1 AND u.email=?
      AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=u.id)`
  const legacyCodeLookup = db.prepare(`${adminGrant}
    AND g.client_hash=? AND g.redirect_uri=? AND g.code_challenge=?`)
  const legacyTokenLookup = db.prepare(`${adminGrant} AND g.code_challenge IS NULL`)
  const legacyFindCode = (value: string) =>
    legacyCodeLookup.get(
      legacyDigest(value),
      resource,
      time,
      time,
      adminEmail,
      hash(app.clientId),
      callback,
      hash(flow.verifier),
    )
  const legacyFindToken = (value: string) =>
    legacyTokenLookup.get(legacyDigest(value), resource, time, time, adminEmail)

  // Positive controls: even with otherwise valid session, client, redirect,
  // PKCE, expiry and admin role, the two releases only accept their own digests.
  const legacyCode = opaque()
  const legacyToken = `zxm_${opaque()}`
  const seedLegacyGrant = db.prepare(`INSERT INTO mcp_grants
    (flow_id, credential_hash, session_hash, client_hash, resource, redirect_uri, code_challenge, expires)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const [value, challenge] of [
    [legacyCode, hash(flow.verifier)],
    [legacyToken, null],
  ] as const) {
    seedLegacyGrant.run(
      opaque(),
      legacyDigest(value),
      hash(admin.split('=')[1]),
      hash(app.clientId),
      resource,
      callback,
      challenge,
      time + 60,
    )
  }
  expect(legacyFindCode(legacyCode)).toBeDefined()
  expect(legacyFindToken(legacyToken)).toBeDefined()
  expect(await (await exchangeCode(flow, legacyCode)).json()).toMatchObject({
    error: 'invalid_grant',
  })
  expect((await request(resource, { headers: bearer(legacyToken) })).status).toBe(401)

  const code = (await approve(flow.pending, admin)).get('code')!
  expect(legacyFindCode(code)).toBeUndefined()
  const issued = await exchangeCode(flow, code)
  expect(issued.status).toBe(200)
  const { access_token, scope } = await issued.json()
  expect(scope).toBe('docs:read')
  expect(legacyFindToken(access_token)).toBeUndefined()
  expect((await request(resource, { headers: bearer(access_token) })).status).toBe(405)
})

test('employee apps share one lifecycle between the account API and MCP; visitors can only read', async () => {
  const owner = await browserSession('app-owner@zixiaolabs.com')
  const colleague = await browserSession('app-colleague@zixiaolabs.com')
  const visitor = await browserSession('reader@example.org', 'github')
  const registration = {
    name: 'Docs reader',
    redirectUris: [callback],
    scope: 'docs:read',
  } as const
  expect((await request(oauthAppsPath, jsonBody(registration))).status).toBe(401)
  expect((await request(oauthAppsPath, jsonBody(registration, visitor))).status).toBe(403)
  expect((await request(oauthAppsPath, { headers: { cookie: visitor } })).status).toBe(403)
  expect((await request(`${oauth}/register`, jsonBody(registration, owner))).status).toBe(404)
  const metadata = await request('/.well-known/oauth-authorization-server')
  expect(await metadata.json()).not.toHaveProperty('registration_endpoint')
  expect((await request(oauthAppsPath, jsonBody({ ...registration, scope }, owner))).status).toBe(
    403,
  )
  for (const redirect of [
    'http://example.org/callback',
    `${callback}#fragment`,
    `${callback}?error_description=x`,
  ]) {
    expect(
      (await request(oauthAppsPath, jsonBody({ ...registration, redirectUris: [redirect] }, owner)))
        .status,
    ).toBe(400)
  }

  const app = await registerApp(owner, 'docs:read')
  const path = `${oauthAppsPath}/${app.clientId}`
  const flow = await startFlow({}, app)
  expect(
    await (
      await request(`${oauth}/consent`, { headers: { cookie: cookieFrom(flow.pending) } })
    ).json(),
  ).toMatchObject({ stage: 'sign-in', appName: app.name, scope: 'docs:read' })
  const first = await tokenFor(app, visitor)
  const second = await tokenFor(app, colleague)
  const client = await connect(first)
  try {
    const db = store()
    db.prepare('INSERT INTO collections VALUES (?, ?, ?, ?, ?)').run(
      'mcp-docs',
      'zixiao-labs/mcp-docs',
      '999',
      'a'.repeat(40),
      1,
    )
    db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?)').run(
      'mcp-docs',
      'guide/install',
      'Install Portal',
      'Public setup',
      '<p>Public setup</p>',
      'markdown',
    )
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      'search_documents',
      'get_document',
    ])
    expect(
      await client.callTool({
        name: 'search_documents',
        arguments: { query: 'INSTALL', collection: 'mcp-docs' },
      }),
    ).toMatchObject({
      structuredContent: {
        documents: [{ slug: 'guide/install', url: `${origin}/docs/mcp-docs/guide/install` }],
        nextOffset: null,
      },
    })
    expect(
      await client.callTool({
        name: 'get_document',
        arguments: { collection: 'mcp-docs', slug: 'guide/install' },
      }),
    ).toMatchObject({ structuredContent: { html: '<p>Public setup</p>' } })
    expect(
      await client.callTool({
        name: 'get_document',
        arguments: { collection: 'mcp-docs', slug: 'missing' },
      }),
    ).toMatchObject({ isError: true })
    for (const name of ['register_oauth_app', 'register_publish_repository']) {
      expect(await client.callTool({ name, arguments: {} })).toMatchObject({ isError: true })
    }
    expect((await request(oauthAppsPath, { headers: bearer(first) })).status).toBe(401)
  } finally {
    await client.close()
  }
  expect(
    (await request(path, { method: 'DELETE', headers: { origin, cookie: colleague } })).status,
  ).toBe(404)
  expect(
    (await request(`${path}/tokens`, { method: 'DELETE', headers: { cookie: owner } })).status,
  ).toBe(403)
  expect(await (await request(oauthAppsPath, { headers: { cookie: owner } })).json()).toMatchObject(
    { apps: [{ clientId: app.clientId, activeTokens: 2 }] },
  )
  const approved = (await approve(flow.pending, visitor)).get('code')!

  const manager = await registerApp(owner, 'oauth:apps')
  const managerFlow = await startFlow({}, manager)
  const managerConsent = `${oauth}/consent`
  const managerHeaders = (cookie: string) => ({
    cookie: `${cookie}; ${cookieFrom(managerFlow.pending)}`,
    origin,
  })
  expect((await request(managerConsent, { headers: managerHeaders(colleague) })).status).toBe(403)
  const { id } = await (await request(managerConsent, { headers: managerHeaders(owner) })).json()
  const anotherOwnerSession = await browserSession('app-owner@zixiaolabs.com')
  expect(
    (
      await request(
        managerConsent,
        form({ id, decision: 'approve' }, managerHeaders(anotherOwnerSession)),
      )
    ).status,
  ).toBe(400)
  const control = await connect(await tokenFor(manager, owner))
  try {
    expect(await control.callTool({ name: 'list_oauth_apps' })).toMatchObject({
      structuredContent: {
        apps: expect.arrayContaining([expect.objectContaining({ clientId: app.clientId })]),
      },
    })
    expect(
      await control.callTool({ name: 'register_oauth_app', arguments: { ...registration, scope } }),
    ).toMatchObject({ isError: true })
    expect(
      await control.callTool({ name: 'register_oauth_app', arguments: registration }),
    ).toMatchObject({ structuredContent: { scope: 'docs:read', activeTokens: 0 } })
    const other = await registerApp(colleague, 'docs:read')
    expect(
      await control.callTool({
        name: 'unregister_oauth_app',
        arguments: { clientId: other.clientId },
      }),
    ).toMatchObject({ isError: true })
    expect(
      await control.callTool({
        name: 'clear_oauth_app_tokens',
        arguments: { clientId: app.clientId },
      }),
    ).toMatchObject({ structuredContent: { revoked: 3 } })
    expect(await (await exchangeCode(flow, approved)).json()).toMatchObject({
      error: 'invalid_grant',
    })
    const consentHeaders = { origin, cookie: `${visitor}; ${cookieFrom(flow.pending)}` }
    const { id: consumed } = await (
      await request(`${oauth}/consent`, { headers: consentHeaders })
    ).json()
    expect(
      (
        await request(
          `${oauth}/consent`,
          form({ id: consumed, decision: 'approve' }, consentHeaders),
        )
      ).status,
    ).toBe(409)
    for (const token of [first, second])
      expect((await request(resource, { headers: bearer(token) })).status).toBe(401)
    const replaced = await tokenFor(app, visitor)
    expect((await request(resource, { headers: bearer(replaced) })).status).toBe(405)
    const pending = await startFlow({}, app)
    expect(
      await control.callTool({
        name: 'unregister_oauth_app',
        arguments: { clientId: app.clientId },
      }),
    ).toMatchObject({ structuredContent: { removed: true } })
    expect(
      (
        await request(`${oauth}/consent`, {
          headers: { cookie: `${visitor}; ${cookieFrom(pending.pending)}` },
        })
      ).status,
    ).toBe(403)
    expect((await startFlow({}, app)).pending.status).toBe(400)
    expect((await request(resource, { headers: bearer(replaced) })).status).toBe(401)
  } finally {
    await control.close()
  }
})

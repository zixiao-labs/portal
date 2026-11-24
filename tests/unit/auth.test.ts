import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { api } from '../../src/server/api'
import { hash, opaque } from '../../src/server/http'
import { store } from '../../src/server/store'

const origin = 'http://localhost:3000'
const secret = 'a-test-secret-not-used-in-production'
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portal-auth-test-'))
  process.env.SQLITE_PATH = join(dir, 'portal.sqlite')
  process.env.PORTAL_SECRET = secret
  process.env.PORTAL_ORIGIN = origin
  process.env.PORTAL_RUNTIME_MODE = 'test'
  process.env.GITHUB_CLIENT_ID = 'fake-oauth-id'
  process.env.GITHUB_CLIENT_SECRET = 'fake-oauth-secret'
  process.env.GITHUB_ORG_ID = '123'
})

afterAll(async () => {
  store().close()
  await rm(dir, { recursive: true, force: true })
})

function post(path: string, body: object, headers?: HeadersInit) {
  return api(
    new Request(origin + path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { origin, 'content-type': 'application/json', ...headers },
    }),
    path,
  )
}

test('employee codes are bound to the browser, single-use, and issue a session', async () => {
  const email = 'test@zixiaolabs.com'
  const code = '037181'
  const browser = opaque()
  const time = Math.floor(Date.now() / 1000)
  const proof = createHmac('sha256', secret)
    .update(JSON.stringify([email, browser, code]))
    .digest('hex')
  store()
    .prepare('INSERT INTO email_codes VALUES (?, ?, ?, ?, ?, 0)')
    .run(email, proof, hash(browser), time + 600, time)
  const path = '/api/auth/email/verify'
  expect((await post(path, { email, code }, { cookie: 'portal_email=other-browser' })).status).toBe(
    400,
  )
  const headers = { cookie: `portal_email=${browser}` }
  expect((await post(path, { email, code: '000000' }, headers)).status).toBe(400)
  const response = await post(path, { email, code }, headers)
  expect(response.status).toBe(200)
  const session = response.headers.getSetCookie()[0].split(';')[0]
  expect((await post(path, { email, code }, headers)).status).toBe(400)
  const account = await api(
    new Request(`${origin}/api/account`, { headers: { cookie: session } }),
    '/api/account',
  )
  expect(await account.json()).toEqual({ email, employee: true, github: false, tokens: [] })
  expect(
    (
      await post(
        '/api/tokens',
        { repository: 'zixiao-labs/project' },
        { origin: 'http://example.org', cookie: session },
      )
    ).status,
  ).toBe(403)
  const created = await post(
    '/api/tokens',
    { repository: 'zixiao-labs/project' },
    { cookie: session },
  )
  const { token } = await created.json()
  expect(created.status).toBe(201)
  expect(
    (await post('/api/publish', { files: [] }, { Authorization: `Bearer ${token}` })).status,
  ).toBe(403)
})

test('GitHub registers a public visitor only after state, PKCE and verified primary email', async () => {
  const entry = '/api/auth/github'
  const start = await api(new Request(origin + entry), entry)
  const authorize = new URL(start.headers.get('location')!)
  expect(authorize.origin).toBe('https://github.com')
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  const cookie = start.headers.getSetCookie()[0].split(';')[0]
  const verifier = cookie.split('.')[1]
  expect(authorize.searchParams.get('code_challenge')).toBe(hash(verifier))
  const callback = '/api/auth/github/callback'
  const remote = vi.fn(async (url: string, request?: RequestInit) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      expect((request!.body as URLSearchParams).get('code_verifier')).toBe(verifier)
      return Response.json({ access_token: 'mock-access-token' })
    }
    if (url === 'https://api.github.com/user') return Response.json({ id: 1234 })
    if (url === 'https://api.github.com/user/emails?per_page=100')
      return Response.json([
        { email: 'unverified@zixiaolabs.com', primary: false, verified: false },
        { email: 'user@example.org', primary: true, verified: true },
      ])
    throw new Error('Unexpected request')
  })
  vi.stubGlobal('fetch', remote)
  try {
    const wrongState = await api(
      new Request(`${origin}${callback}?code=abc&state=wrong`, { headers: { cookie } }),
      callback,
    )
    expect(wrongState.headers.get('location')).toBe(`${origin}/login?error=github`)
    expect(remote).not.toHaveBeenCalled()
    const state = authorize.searchParams.get('state')
    const success = await api(
      new Request(`${origin}${callback}?code=abc&state=${state}`, { headers: { cookie } }),
      callback,
    )
    expect(success.headers.get('location')).toBe(`${origin}/account`)
    const session = success.headers.getSetCookie()[1].split(';')[0]
    expect(
      (await post('/api/tokens', { repository: 'zixiao-labs/project' }, { cookie: session }))
        .status,
    ).toBe(403)
  } finally {
    vi.unstubAllGlobals()
  }
})

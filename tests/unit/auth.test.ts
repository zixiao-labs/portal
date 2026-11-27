import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import nodemailer, { type SendMailOptions } from 'nodemailer'
import { api } from '../../src/server/api'
import { registerGithubUser, verifiedEmailUser } from '../../src/server/auth'
import { hash, opaque } from '../../src/server/http'
import { newSession } from '../../src/server/session'
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

function get(path: string, cookie?: string) {
  return api(new Request(origin + path, { headers: cookie ? { cookie } : {} }), path.split('?')[0])
}

test('email delivery errors are private and can be retried; the sent code logs in', async () => {
  const path = '/api/auth/email/send'
  const email = 'smtp-test@zixiaolabs.com'
  const body = { email }
  const messages: SendMailOptions[] = []
  const sendMail = vi.fn(async (message: SendMailOptions) => {
    messages.push(message)
    if (messages.length === 1) {
      throw Object.assign(new Error('SMTP response containing private information'), {
        code: 'EAUTH',
        responseCode: 535,
      })
    }
  })
  const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('SMTP_HOST', 'smtp.qiye.aliyun.com')
  vi.stubEnv('SMTP_USER', 'portal@zixiaolabs.com')
  vi.stubEnv('SMTP_FROM_NAME', '紫霄实验室')
  vi.stubEnv('SMTP_PASSWORD', '')
  try {
    const invalid = await post(path, body)
    expect(invalid.status).toBe(503)
    expect(invalid.headers.getSetCookie()).toEqual([])
    expect(log.mock.calls).toEqual([
      ['Portal SMTP configuration error:', 'SMTP_PASSWORD must be a non-empty, single-line value'],
    ])
    expect(createTransport).not.toHaveBeenCalled()

    vi.stubEnv('SMTP_PASSWORD', 'test#password@%ZZ:/=')
    expect((await post(path, { email: 'reader@example.org' })).status).toBe(403)
    expect(createTransport).not.toHaveBeenCalled()

    const failed = await post(path, body)
    expect(failed.status).toBe(503)
    expect(failed.headers.getSetCookie()).toEqual([])
    expect(await failed.json()).toEqual({ error: '暂时无法发送邮件，请稍后再试。' })
    expect(log.mock.calls[1]).toEqual(['Portal SMTP send failed:', 'EAUTH (535)'])
    expect(
      store().prepare('SELECT email FROM email_codes WHERE email=?').get(email),
    ).toBeUndefined()

    const sent = await post(path, body)
    expect(sent.status).toBe(200)
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'smtp.qiye.aliyun.com',
        port: 465,
        secure: true,
        auth: { user: 'portal@zixiaolabs.com', pass: 'test#password@%ZZ:/=' },
      }),
    )
    const message = messages[1]
    expect(message).toMatchObject({
      from: { name: '紫霄实验室', address: 'portal@zixiaolabs.com' },
      to: email,
      subject: '紫霄实验室登录验证码',
    })
    expect(message.text).toMatch(/验证码为 \d{6}，10 分钟内有效/)
    expect((await post(path, body)).status).toBe(429)
    expect(sendMail).toHaveBeenCalledTimes(2)

    const cookie = sent.headers.getSetCookie()[0].split(';')[0]
    const code = message.text!.toString().match(/\d{6}/)![0]
    const verified = await post('/api/auth/email/verify', { email, code }, { cookie })
    expect(verified.status).toBe(200)
    expect(verified.headers.getSetCookie()[0]).toMatch(/^portal_session=/)
  } finally {
    vi.unstubAllEnvs()
    log.mockRestore()
    createTransport.mockRestore()
  }
})

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
  expect(response.headers.getSetCookie()[0]).toContain('; HttpOnly; SameSite=Lax')
  const jwt = session.slice('portal_session='.length)
  expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'HS256', typ: 'portal-session+jwt' })
  const { sub, iat, exp, ...claims } = decodeJwt(jwt)
  expect(claims).toEqual({
    iss: origin,
    aud: 'portal-web',
    auth_method: 'email',
    jti: expect.any(String),
  })
  expect(exp! - iat!).toBe(7 * 86400)
  expect((await post(path, { email, code }, headers)).status).toBe(400)
  expect(await (await get('/api/account', session)).json()).toEqual({
    email,
    employee: true,
    github: false,
  })
  const forged = jwt.split('.')
  forged[2] = (forged[2][0] === 'A' ? 'B' : 'A') + forged[2].slice(1)
  const fakeSession = `portal_session=${forged.join('.')}`
  const legacy = opaque()
  // A persisted hash alone must not authorize an unsigned cookie or a tampered JWT.
  for (const [token, cookie] of [
    [legacy, `portal_session=${legacy}`],
    [forged.join('.'), fakeSession],
  ]) {
    store().prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), sub!, exp!)
    expect((await get('/api/account', cookie)).status).toBe(401)
  }
  expect(
    (await post('/api/auth/logout', {}, { origin: 'http://example.org', cookie: session })).status,
  ).toBe(403)
  expect((await post('/api/auth/logout', {}, { cookie: session })).status).toBe(200)
  expect((await get('/api/account', session)).status).toBe(401)
})

const callback = '/api/auth/github/callback'

test('GitHub registers a public visitor only after state, PKCE and verified primary email', async () => {
  const start = await get('/api/auth/github')
  const authorize = new URL(start.headers.get('location')!)
  expect(authorize.origin).toBe('https://github.com')
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  const cookie = start.headers.getSetCookie()[0].split(';')[0]
  const verifier = cookie.slice('portal_oauth='.length)
  expect(authorize.searchParams.get('code_challenge')).toBe(hash(verifier))
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
    const wrongState = await get(`${callback}?code=abc&state=${opaque()}`, cookie)
    expect(wrongState.headers.get('location')).toBe(`${origin}/login?error=github`)
    expect(remote).not.toHaveBeenCalled()
    const state = authorize.searchParams.get('state')
    const success = await get(`${callback}?code=abc&state=${state}`, cookie)
    expect(success.headers.get('location')).toBe(`${origin}/account`)
    const session = success.headers.getSetCookie()[1].split(';')[0]
    expect(await (await get('/api/account', session)).json()).toEqual({
      email: 'user@example.org',
      employee: false,
      github: true,
    })
    expect((await post('/api/auth/github/link', {}, { cookie: session })).status).toBe(403)
    expect((await get(`${callback}?code=abc&state=${state}`, cookie)).headers.get('location')).toBe(
      `${origin}/login?error=github`,
    )
    expect(remote).toHaveBeenCalledTimes(3)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('employee linking requires the same active browser session, rejects collisions and keeps the work email', async () => {
  const email = 'link@zixiaolabs.com'
  const employee = verifiedEmailUser(email)
  const original = await newSession(new Request(origin), employee, 'email')
  const session = original.split(';')[0]
  const otherSession = (await newSession(new Request(origin), employee, 'email')).split(';')[0]
  const path = '/api/auth/github/link'
  expect((await post(path, {})).status).toBe(401)
  expect((await post(path, {}, { origin: 'https://example.org', cookie: session })).status).toBe(
    403,
  )
  expect((await get(path, session)).status).toBe(404)

  const start = async () => {
    const response = await post(path, {}, { cookie: session })
    expect(response.status).toBe(200)
    const authorize = new URL((await response.json()).url)
    expect(authorize.searchParams.get('prompt')).toBe('select_account')
    const proof = response.headers.getSetCookie()[0].split(';')[0]
    return { proof, url: `${callback}?code=abc&state=${authorize.searchParams.get('state')}` }
  }
  let githubId = 2345
  registerGithubUser('already-linked@example.org', String(githubId))
  const remote = vi.fn(async (url: string) => {
    if (url.endsWith('/access_token')) return Response.json({ access_token: 'mock-access-token' })
    if (url.endsWith('/user')) return Response.json({ id: githubId })
    throw new Error('An already-linked identity does not need email lookup')
  })
  vi.stubGlobal('fetch', remote)
  try {
    const mismatch = await start()
    expect(
      (await get(mismatch.url, `${otherSession}; ${mismatch.proof}`)).headers.get('location'),
    ).toBe(`${origin}/account?github=error`)
    expect(remote).not.toHaveBeenCalled()
    // Even the original browser cannot reuse a consumed OAuth state.
    expect((await get(mismatch.url, `${session}; ${mismatch.proof}`)).headers.get('location')).toBe(
      `${origin}/login?error=github`,
    )

    const conflict = await start()
    expect((await get(conflict.url, `${session}; ${conflict.proof}`)).headers.get('location')).toBe(
      `${origin}/account?github=conflict`,
    )
    expect(await (await get('/api/account', session)).json()).toEqual({
      email,
      employee: true,
      github: false,
    })

    githubId++
    const revoked = await start()
    const remove = remote.mockImplementationOnce(async () => {
      await post('/api/auth/logout', {}, { cookie: session })
      return Response.json({ access_token: 'mock-access-token' })
    })
    expect((await get(revoked.url, `${session}; ${revoked.proof}`)).headers.get('location')).toBe(
      `${origin}/account?github=error`,
    )
    expect(remove).toHaveBeenCalled()
    expect((await (await get('/api/account', otherSession)).json()).github).toBe(false)

    const retry = await post(path, {}, { cookie: otherSession })
    const state = new URL((await retry.json()).url).searchParams.get('state')
    const proof = retry.headers.getSetCookie()[0].split(';')[0]
    expect(
      (await get(`${callback}?code=abc&state=${state}`, `${otherSession}; ${proof}`)).headers.get(
        'location',
      ),
    ).toBe(`${origin}/account?github=linked`)
    expect((await post(path, {}, { cookie: otherSession })).status).toBe(409)
    const login = await get('/api/auth/github')
    const loginState = new URL(login.headers.get('location')!).searchParams.get('state')
    const loginProof = login.headers.getSetCookie()[0].split(';')[0]
    const signedIn = await get(`${callback}?code=xyz&state=${loginState}`, loginProof)
    const cookie = signedIn.headers.getSetCookie()[1].split(';')[0]
    expect(await (await get('/api/account', cookie)).json()).toEqual({
      email,
      employee: true,
      github: true,
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodemailer, { type SendMailOptions } from 'nodemailer'
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

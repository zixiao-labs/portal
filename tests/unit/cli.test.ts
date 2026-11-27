import { expect, test, vi } from '@lightning-js/lightning'
import { api } from '../../src/server/api'
import { verifiedEmailUser } from '../../src/server/auth'
import { newSession } from '../../src/server/session'
import { store } from '../../src/server/store'

test('CLI credentials only administer users and expire, rotate, and revoke with the parent session', async () => {
  const origin = 'http://localhost:3000'
  const adminEmail = 'cli-admin@zixiaolabs.com'
  vi.stubEnv('PORTAL_RUNTIME_MODE', 'test')
  vi.stubEnv('PORTAL_ORIGIN', origin)
  vi.stubEnv('PORTAL_ADMIN_EMAILS', adminEmail)
  vi.stubEnv('SQLITE_PATH', ':memory:')
  vi.stubEnv('GITHUB_ORG_ID', '11')
  const db = store()
  const send = (path: string, method = 'GET', headers?: HeadersInit) => {
    const url = new URL(path, origin)
    return api(new Request(url, { method, headers }), url.pathname)
  }
  const mint = '/api/admin/cli-token'
  const users = '/api/cli/users'
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
  try {
    const admin = verifiedEmailUser(adminEmail)
    const staff = verifiedEmailUser('cli-staff@zixiaolabs.com')
    const login = async (user: typeof admin, method: 'email' | 'github') =>
      (await newSession(new Request(origin), user, method)).split(';')[0]
    const web = { origin, cookie: await login(admin, 'email') }
    const githubAdmin = { origin, cookie: await login(admin, 'github') }
    const member = { origin, cookie: await login(staff, 'email') }
    expect((await send(mint, 'POST', githubAdmin)).status).toBe(403)
    expect((await send(mint, 'POST', member)).status).toBe(403)
    expect((await send(mint, 'POST', { cookie: web.cookie })).status).toBe(403)
    expect((await send(users, 'GET', web)).status).toBe(401)

    const issue = async () => {
      const result = await send(mint, 'POST', web)
      expect(result.status).toBe(200)
      expect(result.headers.get('cache-control')).toBe('no-store')
      const { token, expiresAt } = await result.json()
      expect(token).toMatch(/^zxc_[A-Za-z0-9_-]{43}$/)
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000)
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
      expect(db.prepare('SELECT hash FROM cli_credentials').get()?.hash).not.toContain(token)
      return bearer(token)
    }
    const first = await issue()
    expect(await (await send(`${users}?q=CLI-STAFF`, 'GET', first)).json()).toMatchObject({
      users: [{ id: String(staff.id), email: staff.email, suspended: false }],
      next: null,
    })
    expect((await send(`${users}?after=${staff.id}`, 'GET', first)).status).toBe(200)
    expect((await send(`/api/cli/repositories`, 'GET', first)).status).toBe(404)
    expect((await send('/api/admin/repositories', 'GET', first)).status).toBe(401)
    expect((await send('/api/publish', 'POST', first)).status).toBe(401)
    expect((await send(mint, 'POST', { ...first, origin })).status).toBe(401)
    expect((await send(`${users}/${admin.id}/suspend`, 'POST', first)).status).toBe(409)
    expect((await send(`${users}/${staff.id}/revoke-sessions`, 'POST', first)).status).toBe(200)
    expect((await send('/api/account', 'GET', member)).status).toBe(401)
    expect((await send(`${users}/${staff.id}/suspend`, 'POST', first)).status).toBe(200)
    await expect(login(staff, 'email')).rejects.toThrow('此账户已停用')
    expect((await send(`${users}/${staff.id}/restore`, 'POST', first)).status).toBe(200)
    expect(await login(staff, 'email')).toMatch(/^portal_session=/)

    const rotated = await issue()
    expect((await send(users, 'GET', first)).status).toBe(401)
    vi.stubEnv('PORTAL_ADMIN_EMAILS', '')
    expect((await send(users, 'GET', rotated)).status).toBe(403)
    vi.stubEnv('PORTAL_ADMIN_EMAILS', adminEmail)
    expect((await send('/api/cli/token', 'DELETE', rotated)).status).toBe(200)
    expect((await send(users, 'GET', rotated)).status).toBe(401)

    const expired = await issue()
    db.prepare('UPDATE cli_credentials SET expires=1').run()
    expect((await send(users, 'GET', expired)).status).toBe(401)
    const revoked = await issue()
    expect((await send(mint, 'DELETE', web)).status).toBe(200)
    expect((await send(users, 'GET', revoked)).status).toBe(401)
    const loggedOut = await issue()
    expect((await send('/api/auth/logout', 'POST', web)).status).toBe(200)
    expect((await send(users, 'GET', loggedOut)).status).toBe(401)
    expect(db.prepare('SELECT count(*) AS count FROM cli_credentials').get()?.count).toBe(0)
  } finally {
    db.close()
    vi.unstubAllEnvs()
  }
})

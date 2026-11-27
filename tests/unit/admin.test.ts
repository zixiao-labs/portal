import { expect, test, vi } from '@lightning-js/lightning'
import { api } from '../../src/server/api'
import { registerGithubUser, verifiedEmailUser } from '../../src/server/auth'
import { newSession } from '../../src/server/session'
import { canPublish, store } from '../../src/server/store'

const origin = 'http://localhost:3000'
const adminEmail = 'ops@zixiaolabs.com'

test('only email-authenticated admins can manage users and multiple repositories', async () => {
  vi.stubEnv('SQLITE_PATH', ':memory:')
  vi.stubEnv('PORTAL_ORIGIN', origin)
  vi.stubEnv('PORTAL_RUNTIME_MODE', 'test')
  vi.stubEnv('PORTAL_ADMIN_EMAILS', adminEmail)
  const db = store()
  const makeCookie = async (
    ...args: [Parameters<typeof newSession>[1], Parameters<typeof newSession>[2]]
  ) => (await newSession(new Request(origin), ...args)).split(';')[0]
  const send = (path: string, method = 'GET', cookie?: string, data?: object, source = origin) =>
    api(
      new Request(origin + path, {
        method,
        headers: {
          origin: source,
          ...(cookie ? { cookie } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
      path.split('?')[0],
    )
  try {
    const admin = verifiedEmailUser(adminEmail)
    const staff = verifiedEmailUser('member@zixiaolabs.com')
    const visitor = registerGithubUser('reader@example.org', '50')
    const adminSession = await makeCookie(admin, 'email')
    const sameAdminViaGithub = await makeCookie(admin, 'github')
    const member = await makeCookie(staff, 'email')
    const reader = await makeCookie(visitor, 'github')
    const users = '/api/admin/users'
    const repos = '/api/admin/repositories'

    expect((await send(users)).status).toBe(401)
    expect((await send(users, 'GET', member)).status).toBe(403)
    expect((await send(users, 'GET', reader)).status).toBe(403)
    expect((await send(users, 'GET', sameAdminViaGithub)).status).toBe(403)
    expect((await (await send('/api/account', 'GET', adminSession)).json()).admin).toBe(true)
    expect(
      (await (await send('/api/account', 'GET', sameAdminViaGithub)).json()).admin,
    ).toBeUndefined()
    expect(await (await send(`${users}?q=READER`, 'GET', adminSession)).json()).toEqual({
      users: [
        {
          id: String(visitor.id),
          email: visitor.email,
          github: true,
          employee: false,
          suspended: false,
          admin: false,
        },
      ],
      next: null,
    })
    expect(
      (
        await send(
          `${users}/${staff.id}/suspend`,
          'POST',
          adminSession,
          undefined,
          'https://other.example',
        )
      ).status,
    ).toBe(403)
    expect((await send(`${users}/${admin.id}/suspend`, 'POST', adminSession)).status).toBe(409)
    expect((await send(`${users}/${staff.id}/revoke-sessions`, 'POST', adminSession)).status).toBe(
      200,
    )
    expect((await send('/api/account', 'GET', member)).status).toBe(401)
    const signedBackIn = await makeCookie(staff, 'email')
    expect((await send('/api/account', 'GET', signedBackIn)).status).toBe(200)
    expect((await send(`${users}/${visitor.id}/suspend`, 'POST', adminSession)).status).toBe(200)
    expect((await send('/api/account', 'GET', reader)).status).toBe(401)
    await expect(makeCookie(visitor, 'github')).rejects.toThrow('此账户已停用')
    expect(
      (await (await send(`${users}?q=reader`, 'GET', adminSession)).json()).users[0].suspended,
    ).toBe(true)
    expect((await send(`${users}/${visitor.id}/restore`, 'POST', adminSession)).status).toBe(200)
    expect((await send('/api/account', 'GET', reader)).status).toBe(401)
    expect(
      await (await send('/api/account', 'GET', await makeCookie(visitor, 'github'))).json(),
    ).toEqual({
      email: visitor.email,
      github: true,
      employee: false,
    })

    const first = { id: '123', repository: 'zixiao-labs/Handbook' }
    const second = { id: '456', repository: 'zixiao-labs/reference' }
    expect((await send(repos, 'POST', sameAdminViaGithub, first)).status).toBe(403)
    expect(
      (await send(repos, 'POST', adminSession, { ...first, repository: 'other/handbook' })).status,
    ).toBe(400)
    expect((await send(repos, 'POST', adminSession, first)).status).toBe(200)
    expect((await send(repos, 'POST', adminSession, second)).status).toBe(200)
    expect((await send(repos, 'POST', adminSession, { ...first, id: '999' })).status).toBe(409)
    expect((await send(repos, 'POST', adminSession, { ...second, id: first.id })).status).toBe(409)
    expect(await (await send(repos, 'GET', adminSession)).json()).toEqual({
      repositories: [{ ...first, repository: first.repository.toLowerCase() }, second],
    })
    expect(canPublish(first.id, first.repository.toLowerCase())).toBe(true)
    expect((await send(`${repos}/${first.id}`, 'DELETE', signedBackIn)).status).toBe(403)
    expect((await send(`${repos}/${first.id}`, 'DELETE', adminSession)).status).toBe(200)
    expect(canPublish(first.id, first.repository.toLowerCase())).toBe(false)
    expect(canPublish(second.id, second.repository)).toBe(true)
  } finally {
    db.close()
    vi.unstubAllEnvs()
  }
})

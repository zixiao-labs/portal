import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { get, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import nodemailer, { type SendMailOptions } from 'nodemailer'
import { chromium, type Browser, type Page } from 'playwright'
import { PNG } from 'pngjs'
import { servePortal } from '../../scripts/http.mjs'
import { hash, opaque } from '../../src/server/http'
import { renderArticle, replaceCollection } from '../../src/server/publish'
import { newSession } from '../../src/server/session'
import { openStore } from '../../src/server/store'

const origin = 'http://127.0.0.1:4178'
const admin = { id: 2, email: 'admin@zixiaolabs.com', employee: 1, github_id: '23456' }
let session: string
let adminSession: string
let githubAdminSession: string
let server: Server | undefined
let browser: Browser | undefined
let dir: string | undefined

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portal-test-'))
  process.env.PORTAL_ORIGIN = origin
  process.env.PORTAL_RUNTIME_MODE = 'test'
  process.env.NODE_ENV = 'production'
  process.env.PORTAL_SECRET = 'fake-browser-test-secret-not-used-in-production'
  process.env.GITHUB_CLIENT_ID = 'fake-client-id'
  process.env.GITHUB_CLIENT_SECRET = 'fake-client-secret'
  process.env.PORTAL_ADMIN_EMAILS = admin.email
  process.env.SQLITE_PATH = join(dir, 'portal.sqlite')
  const time = Math.floor(Date.now() / 1000)
  {
    using db = openStore(process.env.SQLITE_PATH)
    db.prepare('INSERT INTO users VALUES (1, ?, 1, NULL)').run('employee@zixiaolabs.com')
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(
      admin.id,
      admin.email,
      admin.employee,
      admin.github_id,
    )
    db.prepare('INSERT INTO employee_github_links VALUES (?)').run(admin.github_id)
    db.prepare('INSERT INTO users VALUES (3, ?, 0, ?)').run('reader@example.org', '12345')
    db.prepare('INSERT INTO publish_repositories VALUES (?, ?)').run('1', 'zixiao-labs/handbook')
    replaceCollection(
      {
        repository: 'zixiao-labs/handbook',
        repositoryId: '1',
        revision: 'a'.repeat(40),
        jwtId: 'test-jwt',
        expires: time + 600,
      },
      [
        await renderArticle(
          'guide/start.md',
          '# Handbook\n\nThis document is publicly available.\n\n' +
            '> Start with the [document library](/docs).\n\n```sh\npnpm install\n```\n',
        ),
      ],
      db,
    )
    // Keep the displayed publication date fixed while session expiry still uses real time.
    db.prepare('UPDATE collections SET published=? WHERE name=?').run(
      Date.parse('2026-01-01T00:00:00Z') / 1000,
      'handbook',
    )
  }
  session = (
    await newSession(
      new Request(origin),
      {
        id: 1,
        email: 'employee@zixiaolabs.com',
        employee: 1,
        github_id: null,
      },
      'email',
    )
  ).split(';')[0]
  adminSession = (await newSession(new Request(origin), admin, 'email')).split(';')[0]
  githubAdminSession = (await newSession(new Request(origin), admin, 'github')).split(';')[0]
  const { default: handler } = await import(pathToFileURL(resolve('dist/server/server.mjs')).href)
  server = servePortal(handler, { origin, assets: resolve('dist/client') })
  await new Promise<void>((ok, fail) => {
    server!.once('error', fail).listen(4178, '127.0.0.1', ok)
  })
  browser = await chromium.launch()
  await mkdir('artifacts', { recursive: true })
})

afterAll(async () => {
  await browser?.close()
  if (server?.listening) await new Promise<void>((ok) => server!.close(() => ok()))
  if (dir) await rm(dir, { force: true, recursive: true })
})

async function expectMode(page: Page, mode: 'dark' | 'light') {
  await page.locator(`html[data-zx-color-mode="${mode}"]`).waitFor({ state: 'attached' })
  expect(await page.locator('html').evaluate((html) => getComputedStyle(html).colorScheme)).toBe(
    mode,
  )
}

// Simulate only GitHub's side of the browser redirect. The portal still has to
// issue the authorization URL and handle the callback with its own browser cookie.
async function mockGithubAuthorization(page: Page) {
  const authorize = (url: string) => {
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    )
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'test-code')
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    return callback
  }
  await page.route('https://github.com/login/oauth/authorize**', async (route) => {
    const callback = authorize(route.request().url())
    await route.fulfill({ status: 302, headers: { location: callback.href } })
  })
  // Unlike linking, login starts with a server redirect. Playwright routes the
  // first request in a redirect chain, not the subsequent navigation to GitHub.
  await page.route(`${origin}/api/auth/github`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 })
    expect(response.status()).toBe(303)
    const headers = response.headers()
    await route.fulfill({
      response,
      headers: { ...headers, location: authorize(headers.location).href },
    })
  })
}

// Snapshot a downsampled PNG, not the DOM: broad layout and palette changes are
// caught, while tiny platform-dependent CJK glyph and AA differences are ignored.
// Dark snapshots also distinguish the canvas (:) from raised panels (+).
async function screenshot(page: Page, name: string) {
  const image = PNG.sync.read(
    await page.screenshot({
      animations: 'disabled',
      path: `artifacts/${name}.png`,
      fullPage: false,
    }),
  )
  const darkMode = (await page.locator('html').getAttribute('data-zx-color-mode')) === 'dark'
  const rows = []
  for (let y = 0; y < 18; y++) {
    let row = ''
    for (let x = 0; x < 24; x++) {
      let canvas = 0
      let raised = 0
      let dark = 0
      let purple = 0
      let paper = 0
      let count = 0
      for (
        let py = Math.floor((y * image.height) / 18);
        py < ((y + 1) * image.height) / 18;
        py += 3
      ) {
        for (
          let px = Math.floor((x * image.width) / 24);
          px < ((x + 1) * image.width) / 24;
          px += 3
        ) {
          const offset = 4 * (py * image.width + px)
          const [r, g, b] = image.data.subarray(offset, offset + 3)
          if (darkMode && r < 26 && g < 23 && b < 26) canvas++
          else if (darkMode && r < 42 && g < 40 && b < 44) raised++
          if (r < 125 && g < 100 && b < 160) dark++
          else if (b > g + 45 && b > r + 25) purple++
          else if (r > 245 && g > 245 && b > 245) paper++
          count++
        }
      }
      if (canvas / count > 0.8) row += ':'
      else if (raised / count > 0.8) row += '+'
      else if (dark / count > 0.7) row += '#'
      else if (purple / count > 0.55) row += 'P'
      else if (paper / count > 0.8) row += '.'
      else row += ' '
    }
    rows.push(`|${row}|`)
  }
  expect(rows.join('\n')).toMatchSnapshot()
}

test('desktop and mobile login keep the GitHub action visible and themed', async () => {
  for (const [name, viewport] of [
    ['login-desktop', { width: 1440, height: 900 }],
    ['login-mobile', { width: 390, height: 844 }],
  ] as const) {
    const page = await browser!.newPage({ viewport, colorScheme: 'light', reducedMotion: 'reduce' })
    try {
      await page.goto(`${origin}/login`)
      for (const action of [
        page.getByRole('link', { name: '使用 GitHub 登录' }),
        page.getByRole('button', { name: '发送验证码' }),
        page.getByRole('link', { name: '浏览公开文档' }),
      ]) {
        const bounds = (await action.boundingBox())!
        expect(bounds.height).toBeGreaterThanOrEqual(44)
        expect(bounds.y + bounds.height).toBeLessThan(viewport.height)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
      expect(await page.locator('html').getAttribute('lang')).toBe('zh-CN')
      await screenshot(page, name)
      await page.getByLabel('工作邮箱').fill('visitor@example.org')
      await page.getByRole('button', { name: '发送验证码' }).click()
      expect(await page.getByRole('alert').textContent()).toContain('仅限 @zixiaolabs.com')
      await page.locator('summary').click()
      expect(await page.getByLabel('组件风格').locator('option').count()).toBe(7)
      expect(await page.getByLabel('配色').locator('option').count()).toBe(10)
      await page.getByLabel('组件风格').selectOption('endfield')
      await page.getByLabel('明暗').selectOption('dark')
      await page.reload()
      await page.locator('[data-zx-style="endfield"][data-zx-color-mode="dark"]').waitFor()
    } finally {
      await page.close()
    }
  }
})

test('system dark login keeps the form usable on desktop and mobile', async () => {
  for (const [name, viewport] of [
    ['login-desktop-dark', { width: 1440, height: 900 }],
    ['login-mobile-dark', { width: 390, height: 844 }],
  ] as const) {
    const page = await browser!.newPage({ viewport, colorScheme: 'dark', reducedMotion: 'reduce' })
    try {
      await page.goto(`${origin}/login`)
      await expectMode(page, 'dark')
      const action = await page.getByRole('link', { name: '使用 GitHub 登录' }).boundingBox()
      expect(action!.y + action!.height).toBeLessThan(viewport.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
      await page.getByLabel('工作邮箱').fill('visitor@example.org')
      await page.getByRole('button', { name: '发送验证码' }).click()
      expect(await page.getByRole('alert').textContent()).toContain('仅限 @zixiaolabs.com')
      await screenshot(page, name)
    } finally {
      await page.close()
    }
  }
})

test('a GitHub error leaves the work email form and public docs usable on a narrow screen', async () => {
  const page = await browser!.newPage({ viewport: { width: 320, height: 640 } })
  try {
    await page.goto(`${origin}/login?error=github`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    const github = page.getByRole('link', { name: '使用 GitHub 登录' })
    const form = page.getByRole('form', { name: '员工邮箱登录' })
    expect(await github.getAttribute('href')).toBe('/api/auth/github')
    expect(await page.getByRole('alert').textContent()).toContain('GitHub 登录未完成')
    expect(await form.getByRole('alert').count()).toBe(0)

    await github.focus()
    await page.keyboard.press('Tab')
    const email = form.getByLabel('工作邮箱')
    expect(await email.evaluate((input) => input === document.activeElement)).toBe(true)
    await email.fill('visitor@example.org')
    await email.press('Enter')
    await form.getByRole('alert').waitFor()
    expect(await form.getByRole('alert').textContent()).toContain('仅限 @zixiaolabs.com')

    await page.getByRole('link', { name: '浏览公开文档' }).press('Enter')
    await page.waitForURL(`${origin}/docs`)
  } finally {
    await page.close()
  }
})

test('appearance follows live system changes unless explicitly overridden', async () => {
  const page = await browser!.newPage({ colorScheme: 'light' })
  try {
    await page.goto(`${origin}/login`)
    await expectMode(page, 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expectMode(page, 'dark')
    await page.locator('.appearance summary').click()
    const mode = page.getByLabel('明暗')
    expect(await mode.inputValue()).toBe('system')
    await mode.selectOption('light')
    await expectMode(page, 'light')
    await page.reload()
    await expectMode(page, 'light')
    await page.locator('.appearance summary').click()
    await mode.locator('option[value="light"]:checked').waitFor({ state: 'attached' })
    await mode.selectOption('system')
    await expectMode(page, 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expectMode(page, 'light')
  } finally {
    await page.close()
  }
})

test('the initial document uses the system or saved appearance before hydration', async () => {
  const page = await browser!.newPage({ colorScheme: 'dark' })
  try {
    await page.route('**/assets/*.js', (route) => route.abort())
    await page.goto(`${origin}/login`)
    await expectMode(page, 'dark')
    const canvas = () =>
      page.locator('html').evaluate((html) => getComputedStyle(html).backgroundColor)
    expect(await canvas()).toBe('rgb(22, 18, 23)')
    await page.evaluate(() =>
      localStorage.setItem(
        'zixiao-portal-appearance',
        JSON.stringify({ palette: 'native', style: 'endfield', dark: false }),
      ),
    )
    await page.reload()
    await expectMode(page, 'light')
    expect(await page.locator('html').getAttribute('data-zx-style')).toBe('endfield')
    expect(await canvas()).toBe('rgb(242, 242, 240)')
  } finally {
    await page.close()
  }
})

test('the site root redirects permanently to the canonical login page', async () => {
  const root = await fetch(`${origin}/`, { redirect: 'manual' })
  expect(root.status).toBe(301)
  expect(new URL(root.headers.get('location')!, origin).pathname).toBe('/login')
  const login = await fetch(`${origin}/login`)
  expect(login.status).toBe(200)
  expect(await login.text()).toContain('href="https://zixiaolabs.com/login"')
})

test('the login route redirects active sessions before rendering', async () => {
  for (const [path, cookie] of [
    ['/login', githubAdminSession],
    ['/login?error=github', githubAdminSession],
    ['/login?verifyEmail=true', adminSession],
  ]) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual', headers: { cookie } })
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location')!, origin).href).toBe(`${origin}/account`)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  }

  const guest = await fetch(`${origin}/login`, { headers: { cookie: 'portal_session=invalid' } })
  expect(guest.status).toBe(200)
  expect(guest.headers.get('cache-control')).toBe('private, no-store')
  expect(await guest.text()).toContain('登录门户')
})

test('the login route rechecks the session on client-side navigation', async () => {
  const page = await browser!.newPage()
  try {
    await page.goto(`${origin}/login`)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('link', { name: '浏览公开文档' }).click()
    await page.waitForURL(`${origin}/docs`)
    await page.context().addCookies([
      {
        name: 'portal_session',
        value: githubAdminSession.split('=')[1],
        url: origin,
        httpOnly: true,
      },
    ])
    await page.goBack()
    await page.waitForURL(`${origin}/account`)
    await page.getByText(admin.email, { exact: true }).waitFor()
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
  } finally {
    await page.close()
  }
})

test('the header logo opens login for guests and the account for signed-in users', async () => {
  const page = await browser!.newPage()
  const logo = page.getByRole('banner').getByRole('link', { name: /紫霄实验室/ })
  try {
    await page.goto(`${origin}/docs`)
    await logo.click()
    await page.waitForURL(`${origin}/login`)
    await page.getByRole('heading', { name: '登录门户' }).waitFor()

    const readerSession = await newSession(
      new Request(origin),
      { id: 3, email: 'reader@example.org', employee: 0, github_id: '12345' },
      'github',
    )
    await page.context().addCookies([
      {
        name: 'portal_session',
        value: readerSession.split(';')[0].split('=')[1],
        url: origin,
        httpOnly: true,
      },
    ])
    await page.goto(`${origin}/docs`)
    await logo.click()
    await page.waitForURL(`${origin}/account`)
    await page.getByText('reader@example.org', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('public documents render with SEO, route to an article, and can be searched', async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    const index = await fetch(`${origin}/docs`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('href="/docs/handbook"')
    const collection = await fetch(`${origin}/docs/handbook`)
    expect(collection.status).toBe(200)
    const collectionHtml = await collection.text()
    expect(collectionHtml).toContain('href="https://zixiaolabs.com/docs/handbook"')
    expect(collectionHtml).toContain('href="/docs/handbook/guide/start"')
    const llms = await fetch(`${origin}/docs/handbook/llms.txt`)
    expect(llms.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await llms.text()).toContain(`[Handbook](${origin}/docs/handbook/guide/start)`)
    expect((await fetch(`${origin}/docs/missing/llms.txt`)).status).toBe(404)
    expect((await fetch(`${origin}/docs/missing`)).status).toBe(404)
    const direct = await fetch(`${origin}/docs/handbook/guide/start`)
    expect(direct.status).toBe(200)
    expect(await direct.text()).toContain('This document is publicly available.')
    const missing = await fetch(`${origin}/docs/handbook/unknown`)
    expect(missing.status).toBe(404)
    await page.goto(`${origin}/docs`)
    await screenshot(page, 'docs-desktop')
    await page.getByLabel('搜索文档').fill('does not exist')
    expect(await page.getByRole('status').textContent()).toContain('没有与')
    await page.getByLabel('搜索文档').fill('handbook')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expectMode(page, 'dark')
    await screenshot(page, 'docs-desktop-dark')
    await page.getByRole('link', { name: 'handbook', exact: true }).click()
    await page.waitForURL('**/docs/handbook')
    await page.getByRole('heading', { name: 'handbook', exact: true }).waitFor()
    expect(await page.getByRole('link', { name: 'llms.txt' }).getAttribute('href')).toBe(
      '/docs/handbook/llms.txt',
    )
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await screenshot(page, 'collection-mobile-dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('link', { name: /Handbook/ }).click()
    await page.getByRole('heading', { name: 'Handbook', exact: true }).waitFor()
    await expectMode(page, 'dark')
    await screenshot(page, 'article-desktop-dark')
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(
      'https://zixiaolabs.com/docs/handbook/guide/start',
    )
    const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text()
    expect(sitemap).toContain(`${origin}/docs/handbook</loc>`)
    expect(sitemap).toContain(`${origin}/docs/handbook/guide/start</loc>`)
  } finally {
    await page.close()
  }
})

test('the client-only account gates its data, links GitHub and invalidates the JWT on logout', async () => {
  const account = await fetch(`${origin}/account`)
  expect(account.headers.get('x-robots-tag')).toBe('noindex')
  expect(await account.text()).not.toContain('employee@')
  expect((await fetch(`${origin}/api/account`)).status).toBe(401)
  const wrongHost = await new Promise<number | undefined>((ok, fail) => {
    get(`${origin}/login`, { headers: { host: 'example.org' } }, (response) => {
      response.resume()
      ok(response.statusCode)
    }).on('error', fail)
  })
  expect(wrongHost).toBe(421)
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
  const fetchHttp = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url === 'https://github.com/login/oauth/access_token')
      return Promise.resolve(Response.json({ access_token: 'fake-access-token' }))
    if (url === 'https://api.github.com/user') return Promise.resolve(Response.json({ id: 56789 }))
    return fetchHttp(url, options)
  })
  try {
    await page
      .context()
      .addCookies([
        { name: 'portal_session', value: session.split('=')[1], url: origin, httpOnly: true },
      ])
    await mockGithubAuthorization(page)
    await page.goto(`${origin}/account`)
    await page.getByText('employee@zixiaolabs.com').waitFor()
    await screenshot(page, 'account-desktop')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expectMode(page, 'dark')
    await screenshot(page, 'account-desktop-dark')
    await page.setViewportSize({ width: 390, height: 844 })
    const link = page.getByRole('button', { name: '绑定 GitHub' })
    const bounds = (await link.boundingBox())!
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    expect(bounds.y + bounds.height).toBeLessThan(844)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await screenshot(page, 'account-mobile-dark')
    await link.click()
    await page.getByRole('status').filter({ hasText: 'GitHub 已绑定' }).waitFor()
    await page.goto(`${origin}/account`)
    await page.getByText('已关联', { exact: true }).waitFor()
    expect(await link.count()).toBe(0)
    await page.getByRole('button', { name: '退出登录' }).click()
    await page.waitForURL('**/login')
    expect((await fetch(`${origin}/api/account`, { headers: { cookie: session } })).status).toBe(
      401,
    )
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click()
    await page.waitForURL(`${origin}/account`)
    await page.getByText('employee@zixiaolabs.com', { exact: true }).waitFor()
    await page.getByText('员工', { exact: true }).waitFor()
  } finally {
    vi.unstubAllGlobals()
    await page.close()
  }
})

test('a GitHub-signed-in admin keeps the role and can verify their work email without logout', async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
  let code: string | undefined
  const mail = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    async sendMail(message: SendMailOptions) {
      expect(message.to).toBe(admin.email)
      code = String(message.text).match(/\d{6}/)?.[0]
    },
  })
  vi.stubEnv('SMTP_HOST', 'smtp.example.org')
  vi.stubEnv('SMTP_USER', 'portal@example.org')
  vi.stubEnv('SMTP_PASSWORD', 'fake-browser-test-password')
  try {
    await page.context().addCookies([
      {
        name: 'portal_session',
        value: githubAdminSession.split('=')[1],
        url: origin,
        httpOnly: true,
      },
    ])
    await page.goto(`${origin}/admin`)
    const verify = page.getByRole('link', { name: '验证工作邮箱' })
    await verify.waitFor()
    expect(await page.getByRole('navigation', { name: '后台模块' }).count()).toBe(0)
    await page.getByRole('link', { name: '返回个人中心' }).click()
    await page.getByText('管理员', { exact: true }).waitFor()
    await verify.waitFor()
    const adminLink = page.getByRole('link', { name: '管理后台' })
    expect(await adminLink.count()).toBe(0)
    await screenshot(page, 'account-admin-verification-desktop')

    await verify.click()
    await page.waitForURL(`${origin}/login?verifyEmail=true#work-email`)
    await page.getByLabel('工作邮箱').fill(admin.email)
    await page.getByRole('button', { name: '发送验证码' }).click()
    const input = page.getByLabel('验证码')
    await input.waitFor()
    expect(code).toMatch(/^\d{6}$/)
    await input.fill(code!)
    await page.getByRole('button', { name: '验证并登录' }).click()
    await page.waitForURL('**/account')
    await adminLink.click()
    await page.getByText('reader@example.org').waitFor()
    expect(
      (await fetch(`${origin}/api/account`, { headers: { cookie: githubAdminSession } })).status,
    ).toBe(401)
  } finally {
    await page.close()
    mail.mockRestore()
    vi.unstubAllEnvs()
  }
})

test('MCP authorization returns to the client after work-email verification and consent', async () => {
  const page = await browser!.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const oauth = `${origin}/api/mcp/oauth`
  const callback = `${origin}/docs`
  let code: string | undefined
  const mail = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    async sendMail(message: SendMailOptions) {
      expect(message.to).toBe(admin.email)
      code = String(message.text).match(/\d{6}/)?.[0]
    },
  })
  vi.stubEnv('SMTP_HOST', 'smtp.example.org')
  vi.stubEnv('SMTP_USER', 'portal@example.org')
  vi.stubEnv('SMTP_PASSWORD', 'fake-browser-test-password')
  try {
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/api/mcp`)
    expect(await metadata.json()).toMatchObject({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
    })
    const registration = await fetch(`${oauth}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none' }),
    })
    expect(registration.status).toBe(201)
    const { client_id } = await registration.json()
    const verifier = opaque()
    const state = opaque()
    const login = await page.goto(
      `${oauth}/authorize?${new URLSearchParams({
        client_id,
        redirect_uri: callback,
        response_type: 'code',
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
        resource: `${origin}/api/mcp`,
        state,
      })}`,
    )
    expect(login?.headers()['x-robots-tag']).toBe('noindex')
    const email = page.getByLabel('工作邮箱')
    await email.fill(admin.email)
    await page.getByRole('button', { name: '发送验证码' }).click()
    const input = page.getByLabel('验证码')
    await input.waitFor()
    expect(code).toMatch(/^\d{6}$/)
    await input.fill(code!)
    await page.getByRole('button', { name: '验证并登录' }).click()

    const approve = page.getByRole('button', { name: '允许管理发布权限' })
    await approve.waitFor()
    expect(page.url()).toBe(`${origin}/login?mcp=true`)
    expect(await page.getByText(callback, { exact: true }).count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await screenshot(page, 'mcp-consent-mobile')
    await approve.click()
    await page.waitForURL((url) => url.pathname === '/docs' && url.searchParams.has('code'))
    const returned = new URL(page.url())
    expect(returned.searchParams.get('state')).toBe(state)
    const exchange = await fetch(`${oauth}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        redirect_uri: callback,
        code: returned.searchParams.get('code')!,
        code_verifier: verifier,
        resource: `${origin}/api/mcp`,
      }),
    })
    expect(exchange.status).toBe(200)
  } finally {
    await page.close()
    mail.mockRestore()
    vi.unstubAllEnvs()
  }
})

test('the admin console manages users and multiple repository authorizations', async () => {
  const unauthenticated = await fetch(`${origin}/admin`)
  expect(unauthenticated.headers.get('x-robots-tag')).toBe('noindex')
  expect(await unauthenticated.text()).not.toContain('reader@example.org')
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.goto(`${origin}/admin`)
    await page.waitForURL('**/login')
    await page
      .context()
      .addCookies([
        { name: 'portal_session', value: adminSession.split('=')[1], url: origin, httpOnly: true },
      ])
    await page.goto(`${origin}/account`)
    await page.getByRole('link', { name: '管理后台' }).click()
    await page.getByText('reader@example.org').waitFor()
    await screenshot(page, 'admin-users-desktop')
    await page.getByLabel('按邮箱搜索').fill('reader')
    await page.getByRole('button', { name: '搜索' }).click()
    const rows = page.getByRole('list', { name: '用户' }).getByRole('listitem')
    await rows.filter({ hasText: 'admin@' }).waitFor({ state: 'detached' })
    const reader = rows.filter({ hasText: 'reader@example.org' })
    page.once('dialog', (dialog) => void dialog.accept())
    await reader.getByRole('button', { name: '停用', exact: true }).click()
    await reader.getByText(/已停用/).waitFor()
    await page.reload()
    await reader.getByText(/已停用/).waitFor()
    page.once('dialog', (dialog) => void dialog.accept())
    await reader.getByRole('button', { name: '恢复', exact: true }).click()
    await reader.getByText(/正常/).waitFor()

    await page.getByRole('link', { name: 'CLI 凭据' }).click()
    const issue = page.getByRole('button', { name: '签发 CLI Token' })
    await issue.waitFor()
    await screenshot(page, 'admin-cli-desktop')
    await issue.click()
    const token = page.getByLabel('CLI Token（仅本次显示）')
    await token.waitFor()
    const headers = { Authorization: `Bearer ${await token.inputValue()}` }
    expect((await fetch(`${origin}/api/cli/users`, { headers })).status).toBe(200)
    await page.getByRole('button', { name: '撤销 CLI Token' }).click()
    await token.waitFor({ state: 'detached' })
    expect((await fetch(`${origin}/api/cli/users`, { headers })).status).toBe(401)

    await page.getByRole('link', { name: '可发布仓库' }).click()
    await page.getByText('zixiao-labs/handbook', { exact: true }).waitFor()
    const repositoryField = page.getByLabel('仓库全名')
    const idField = page.getByLabel('仓库数字 ID')
    const grant = async (repository: string, id: string) => {
      await repositoryField.fill(repository)
      await idField.fill(id)
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: '授权发布' }).click()
    }
    let grantRequests = 0
    let failRefresh = true
    await page.route('**/api/admin/repositories', (route) => {
      if (route.request().method() === 'POST') grantRequests++
      else if (grantRequests === 1 && failRefresh) {
        failRefresh = false
        return route.fulfill({ status: 503, json: { error: 'Test refresh failure' } })
      }
      return route.continue()
    })
    await grant('zixiao-labs/guide', '456')
    const added = page.getByRole('listitem').filter({ hasText: 'zixiao-labs/guide' })
    await page.getByRole('status').filter({ hasText: '仓库已获发布授权' }).waitFor()
    await page.getByRole('alert').filter({ hasText: '授权列表刷新失败' }).waitFor()
    await page.getByRole('button', { name: '重新读取' }).click()
    await added.waitFor()
    expect(grantRequests).toBe(1)
    await grant('zixiao-labs/guide', '457')
    await page.getByRole('alert').filter({ hasText: '已获授权' }).waitFor()
    await page.reload()
    await added.waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expectMode(page, 'dark')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await screenshot(page, 'admin-repositories-mobile-dark')
    page.once('dialog', (dialog) => void dialog.accept())
    await added.getByRole('button', { name: '撤销授权' }).click()
    await added.waitFor({ state: 'detached' })
    await page.getByText('zixiao-labs/handbook', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('a new visitor can retry GitHub login after verifying their primary email', async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
  const email = 'new-reader@example.org'
  let verified = false
  const fetchHttp = globalThis.fetch
  vi.stubGlobal('fetch', (input: string, options?: RequestInit) => {
    if (input === 'https://github.com/login/oauth/access_token')
      return Promise.resolve(Response.json({ access_token: 'fake-access-token' }))
    if (input === 'https://api.github.com/user')
      return Promise.resolve(Response.json({ id: 67890 }))
    if (input === 'https://api.github.com/user/emails?per_page=100')
      return Promise.resolve(Response.json([{ email, primary: true, verified }]))
    return fetchHttp(input, options)
  })
  try {
    await mockGithubAuthorization(page)
    await page.goto(`${origin}/login`)
    const github = page.getByRole('link', { name: '使用 GitHub 登录' })
    await github.click()
    await page.waitForURL(`${origin}/login?error=email`)
    await page.getByRole('alert').filter({ hasText: '请先在 GitHub 验证主邮箱' }).waitFor()
    expect((await page.request.get(`${origin}/api/account`)).status()).toBe(401)

    verified = true
    await github.click()
    await page.waitForURL(`${origin}/account`)
    await page.getByText(email, { exact: true }).waitFor()
    await page.getByText('访客', { exact: true }).waitFor()
    await page.reload()
    await page.getByText(email, { exact: true }).waitFor()
    await page.getByRole('button', { name: '退出登录' }).click()
    await page.waitForURL(`${origin}/login`)
    expect((await page.request.get(`${origin}/api/account`)).status()).toBe(401)
  } finally {
    vi.unstubAllGlobals()
    await page.close()
  }
})

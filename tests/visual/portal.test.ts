import { afterAll, beforeAll, expect, test, vi } from '@lightning-js/lightning'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { get, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { PNG } from 'pngjs'
import { servePortal } from '../../scripts/http.mjs'
import { renderArticle, replaceCollection } from '../../src/server/publish'
import { newSession } from '../../src/server/session'
import { openStore } from '../../src/server/store'

const origin = 'http://127.0.0.1:4178'
let session: string
let adminSession: string
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
  process.env.PORTAL_ADMIN_EMAILS = 'admin@zixiaolabs.com'
  process.env.SQLITE_PATH = join(dir, 'portal.sqlite')
  const time = Math.floor(Date.now() / 1000)
  {
    using db = openStore(process.env.SQLITE_PATH)
    db.prepare('INSERT INTO users VALUES (1, ?, 1, NULL)').run('employee@zixiaolabs.com')
    db.prepare('INSERT INTO users VALUES (2, ?, 1, NULL)').run('admin@zixiaolabs.com')
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
  adminSession = (
    await newSession(
      new Request(origin),
      {
        id: 2,
        email: 'admin@zixiaolabs.com',
        employee: 1,
        github_id: null,
      },
      'email',
    )
  ).split(';')[0]
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
    const page = await browser!.newPage({ viewport, reducedMotion: 'reduce' })
    try {
      await page.goto(`${origin}/login`)
      const action = await page.getByRole('link', { name: '使用 GitHub 继续' }).boundingBox()
      expect(action?.height).toBeGreaterThanOrEqual(44)
      expect(action!.y + action!.height).toBeLessThan(viewport.height)
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
      const action = await page.getByRole('link', { name: '使用 GitHub 继续' }).boundingBox()
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

test('public documents render with SEO, route to an article, and can be searched', async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    const index = await fetch(`${origin}/docs`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('Handbook')
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
    await page.getByRole('link', { name: /Handbook/ }).click()
    await page.getByRole('heading', { name: 'Handbook', exact: true }).waitFor()
    await expectMode(page, 'dark')
    await screenshot(page, 'article-desktop-dark')
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(
      'https://zixiaolabs.com/docs/handbook/guide/start',
    )
    expect(await (await fetch(`${origin}/sitemap.xml`)).text()).toContain(
      '/docs/handbook/guide/start',
    )
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
    // Simulate GitHub's browser redirect; the portal still validates and consumes its own state.
    await page.route('https://github.com/login/oauth/authorize**', async (route) => {
      const authorization = new URL(route.request().url())
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'test-code')
      callback.searchParams.set('state', authorization.searchParams.get('state')!)
      await route.fulfill({ status: 302, headers: { location: callback.href } })
    })
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
  } finally {
    vi.unstubAllGlobals()
    await page.close()
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
    await grant('zixiao-labs/guide', '456')
    const added = page.getByRole('listitem').filter({ hasText: 'zixiao-labs/guide' })
    await added.waitFor()
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

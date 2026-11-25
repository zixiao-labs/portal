import { afterAll, beforeAll, expect, test } from '@lightning-js/lightning'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { get, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { PNG } from 'pngjs'
import { servePortal } from '../../scripts/http.mjs'
import { hash } from '../../src/server/http'
import { renderArticle, replaceCollection } from '../../src/server/publish'
import { openStore } from '../../src/server/store'

const origin = 'http://127.0.0.1:4178'
const session = 'browser-test-session'
let server: Server | undefined
let browser: Browser | undefined
let dir: string | undefined

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portal-test-'))
  process.env.PORTAL_ORIGIN = origin
  process.env.PORTAL_RUNTIME_MODE = 'test'
  process.env.NODE_ENV = 'production'
  process.env.SQLITE_PATH = join(dir, 'portal.sqlite')
  const time = Math.floor(Date.now() / 1000)
  {
    using db = openStore(process.env.SQLITE_PATH)
    db.prepare('INSERT INTO users VALUES (1, ?, 1, NULL)').run('employee@zixiaolabs.com')
    db.prepare('INSERT INTO sessions VALUES (?, 1, ?)').run(hash(session), time + 3600)
    replaceCollection(
      'zixiao-labs/handbook',
      {
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
      () => true,
      db,
    )
  }
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
      'https://portal.zixiaolabs.com/docs/handbook/guide/start',
    )
    expect(await (await fetch(`${origin}/sitemap.xml`)).text()).toContain(
      '/docs/handbook/guide/start',
    )
  } finally {
    await page.close()
  }
})

test('the client-only account gates its data, issues a single-display token and revokes it', async () => {
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
  try {
    await page.context().addCookies([{ name: 'portal_session', value: session, url: origin }])
    await page.goto(`${origin}/account`)
    await page.getByText('employee@zixiaolabs.com').waitFor()
    await screenshot(page, 'account-desktop')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expectMode(page, 'dark')
    await screenshot(page, 'account-desktop-dark')
    await page.getByLabel('GitHub 仓库').fill('zixiao-labs/handbook')
    await page.getByRole('button', { name: '创建发布 Token' }).click()
    const shown = page.locator('.issued-secret code')
    await shown.waitFor()
    const token = await shown.textContent()
    expect(token).toMatch(/^zxp_[A-Za-z0-9_-]{43}$/)
    await page.reload()
    const remove = page.getByRole('button', { name: '撤销' })
    await remove.waitFor()
    expect(await shown.count()).toBe(0)
    page.once('dialog', (dialog) => void dialog.accept())
    await remove.click()
    await page.getByText('Token 已撤销。').waitFor()
    await page.getByRole('button', { name: '退出登录' }).click()
    await page.waitForURL('**/login')
    expect((await page.request.get(`${origin}/api/account`)).status()).toBe(401)
  } finally {
    await page.close()
  }
})

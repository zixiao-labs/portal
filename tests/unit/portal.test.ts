import { expect, test } from '@lightning-js/lightning'
import { acceptsHost, deploymentOrigin } from '../../src/deployment.mjs'
import { employeeLoginEmail, verifiedUser } from '../../src/server/auth'
import { actionsClaims, renderArticle, replaceCollection } from '../../src/server/publish'
import { findDocument, listDocuments, openStore } from '../../src/server/store'
import { readJson } from '../../src/server/http'

test('production requires the exact HTTPS deployment host; local development is loopback only', () => {
  expect(deploymentOrigin('https://portal.zixiaolabs.com', true)).toBe(
    'https://portal.zixiaolabs.com',
  )
  expect(deploymentOrigin('https://zixiaolabs.com', true)).toBe('https://zixiaolabs.com')
  for (const url of [
    'http://zixiaolabs.com',
    'https://notzixiaolabs.com',
    'https://zixiaolabs.com.example.org',
    'https://zixiaolabs.com@evil.tld',
    'https://zixiaolabs.com:8443',
    'http://localhost:3000',
  ])
    expect(() => deploymentOrigin(url, true)).toThrow()
  expect(deploymentOrigin('http://localhost:3000', false)).toBe('http://localhost:3000')
  expect(acceptsHost('evil.tld', 'https://portal.zixiaolabs.com')).toBe(false)
  expect(acceptsHost('portal.zixiaolabs.com', 'https://portal.zixiaolabs.com')).toBe(true)
})

test('public GitHub profiles are visitors; only the exact verified work domain creates employees', () => {
  using db = openStore(':memory:')
  expect(verifiedUser('reader@example.org', '100', db).employee).toBe(0)
  expect(verifiedUser('reader@sub.zixiaolabs.com', '101', db).employee).toBe(0)
  expect(verifiedUser(employeeLoginEmail(' Member@ZIXIAOLABS.com '), undefined, db).employee).toBe(
    1,
  )
  expect(() => employeeLoginEmail('reader@example.org')).toThrow()
  expect(() => employeeLoginEmail('reader@zixiaolabs.com.example.org')).toThrow()
  expect(() => verifiedUser('changed@example.org', '100', db)).toThrow()
})

test('documentation only renders safe static content from all three formats', async () => {
  const md = await renderArticle('guide/start.md', '# Start\n\nInstall first.\n\n~~Legacy~~')
  expect(md.slug).toBe('guide/start')
  expect(md.title).toBe('Start')
  expect(md.summary).toBe('Install first.')
  expect(md.html).toContain('<del>Legacy</del>')
  const mdx = await renderArticle('guide.mdx', '# Guide\n\n**Static**')
  expect(mdx.html).toContain('<strong>Static</strong>')
  expect((await renderArticle('keys.mdx', '# Keys\n\nPress <kbd>Enter</kbd>.')).html).toContain(
    '<kbd>Enter</kbd>',
  )
  expect(md.html).not.toContain('<h2>Start</h2>')
  await expect(renderArticle('guide.mdx', '# Guide\n\n<Widget />')).rejects.toThrow()
  await expect(renderArticle('guide.mdx', 'export const a = 1')).rejects.toThrow()
  await expect(renderArticle('../escape.html', 'bad path')).rejects.toThrow()
  const html = await renderArticle(
    'clean.html',
    '<h1>Safe</h1><script>bad</script><a href="javascript:bad" onclick="bad">Link</a><img src="https://example.org/track">',
  )
  expect(html.html).toContain('<a>Link</a>')
  expect(html.html).not.toContain('bad')
  expect(html.html).not.toContain('<img')
})

const workflow = {
  repository_owner_id: '11',
  repository_owner: 'zixiao-labs',
  repository_id: '33',
  repository: 'zixiao-labs/project',
  ref: 'refs/heads/main',
  environment: 'docs-publish',
  event_name: 'push',
  workflow_ref: 'zixiao-labs/project/.github/workflows/publish-docs.yml@refs/heads/main',
  sha: 'a'.repeat(40),
  jti: 'run-1',
  exp: Math.floor(Date.now() / 1000) + 300,
}

test('only the configured organization, workflow, repository, branch and environment match', () => {
  expect(actionsClaims(workflow, 'zixiao-labs/project', '11').repositoryId).toBe('33')
  for (const wrong of [
    { repository_owner_id: '12' },
    { ref: 'refs/heads/feature' },
    { event_name: 'pull_request_target' },
    { environment: 'preview' },
    { workflow_ref: 'zixiao-labs/project/.github/workflows/other.yml@refs/heads/main' },
    { repository: 'zixiao-labs/different' },
  ])
    expect(() => actionsClaims({ ...workflow, ...wrong }, 'zixiao-labs/project', '11')).toThrow()
})

test('publishing replaces one collection atomically and refuses reused identities and revoked tokens', async () => {
  using db = openStore(':memory:')
  const key = actionsClaims(workflow, 'zixiao-labs/project', '11')
  const page = await renderArticle('first.md', '# First\n\nRead me.')
  const next = await renderArticle('next.html', '<h1>Next</h1><p>Read this instead.</p>')
  replaceCollection(workflow.repository, key, [page], () => true, db)
  expect(findDocument('project', 'first', db)?.title).toBe('First')
  expect(() => replaceCollection(workflow.repository, key, [next], () => true, db)).toThrow()
  const newKey = { ...key, jwtId: 'run-2' }
  expect(() =>
    replaceCollection(workflow.repository, newKey, [next, next], () => true, db),
  ).toThrow()
  expect(() => replaceCollection(workflow.repository, newKey, [next], () => false, db)).toThrow()
  expect(listDocuments(db).articles[0]?.slug).toBe('first')
  replaceCollection(workflow.repository, newKey, [next], () => true, db)
  expect(findDocument('project', 'first', db)).toBeUndefined()
  expect(listDocuments(db).articles.map((article) => article.slug)).toEqual(['next'])
})

test('request parsing enforces the actual body size without relying on Content-Length', async () => {
  const request = new Request('http://localhost:3000/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"large":"123456789"}',
  })
  await expect(readJson(request, 10)).rejects.toThrow()
})

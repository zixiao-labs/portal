import { expect, test } from '@lightning-js/lightning'
import { acceptsHost, adminEmails, deploymentOrigin } from '../../src/deployment.mjs'
import { employeeLoginEmail, registerGithubUser, verifiedEmailUser } from '../../src/server/auth'
import { actionsClaims, renderArticle, replaceCollection } from '../../src/server/publish'
import { findCollection, findDocument, listDocuments, openStore } from '../../src/server/store'
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
  expect(registerGithubUser('reader@example.org', '100', db).employee).toBe(0)
  expect(registerGithubUser('reader@sub.zixiaolabs.com', '101', db).employee).toBe(0)
  expect(registerGithubUser('new@zixiaolabs.com', '102', db).employee).toBe(1)
  const employee = verifiedEmailUser(employeeLoginEmail(' Member@ZIXIAOLABS.com '), db)
  expect(employee.employee).toBe(1)
  expect(() => employeeLoginEmail('reader@example.org')).toThrow()
  expect(() => employeeLoginEmail('reader@zixiaolabs.com.example.org')).toThrow()
  expect(() => registerGithubUser(employee.email, '103', db)).toThrow()
  expect(() => registerGithubUser('changed@example.org', '100', db)).toThrow()
  db.prepare('UPDATE users SET employee=0 WHERE id=?').run(employee.id)
  expect(verifiedEmailUser(employee.email, db).employee).toBe(0)
})

test('admin bootstrap is opt-in and only accepts explicit employee mailboxes', () => {
  expect(adminEmails(undefined).size).toBe(0)
  expect(adminEmails(' ADMIN@zixiaolabs.com , ops@zixiaolabs.com ')).toEqual(
    new Set(['admin@zixiaolabs.com', 'ops@zixiaolabs.com']),
  )
  for (const value of [
    '*@example.org',
    'zixiaolabs.com',
    'x@sub.zixiaolabs.com',
    'staff@zixiaolabs.com,',
  ])
    expect(() => adminEmails(value)).toThrow()
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
  expect(actionsClaims(workflow, '11').repositoryId).toBe('33')
  for (const wrong of [
    { repository_owner_id: '12' },
    { repository_owner: 'different' },
    { repository_id: 'not-a-number' },
    { ref: 'refs/heads/feature' },
    { event_name: 'pull_request_target' },
    { environment: 'preview' },
    { workflow_ref: 'zixiao-labs/project/.github/workflows/other.yml@refs/heads/main' },
    { job_workflow_ref: 'zixiao-labs/project/.github/workflows/other.yml@refs/heads/main' },
    { repository: 'zixiao-labs/different' },
  ])
    expect(() => actionsClaims({ ...workflow, ...wrong }, '11')).toThrow()
})

test('publishing replaces one collection atomically and refuses replays, expired identities and repository collisions', async () => {
  using db = openStore(':memory:')
  const key = actionsClaims(workflow, '11')
  const page = await renderArticle('first.md', '# First\n\nRead me.')
  const next = await renderArticle('next.html', '<h1>Next</h1><p>Read this instead.</p>')
  const grant = db.prepare('INSERT INTO publish_repositories VALUES (?, ?)')
  const revoke = db.prepare('DELETE FROM publish_repositories WHERE id=?')
  grant.run(key.repositoryId, key.repository)
  expect(findCollection('project', db)).toBeUndefined()
  replaceCollection(key, [page], db)
  expect(findDocument('project', 'first', db)?.title).toBe('First')
  expect(() => replaceCollection(key, [next], db)).toThrow()
  const newKey = { ...key, jwtId: 'run-2' }
  expect(() => replaceCollection(newKey, [next, next], db)).toThrow()
  expect(() => replaceCollection({ ...newKey, expires: 1 }, [next], db)).toThrow()
  revoke.run(key.repositoryId)
  expect(() => replaceCollection(newKey, [next], db)).toThrow('没有文档发布权限')
  grant.run('44', key.repository)
  expect(() => replaceCollection({ ...newKey, repositoryId: '44' }, [next], db)).toThrow(
    '需要管理员迁移',
  )
  revoke.run('44')
  grant.run(key.repositoryId, 'zixiao-labs/renamed')
  expect(() =>
    replaceCollection({ ...newKey, repository: 'zixiao-labs/renamed' }, [next], db),
  ).toThrow('需要管理员迁移')
  expect(listDocuments(db).articles[0]?.slug).toBe('first')
  revoke.run(key.repositoryId)
  grant.run(key.repositoryId, key.repository)
  replaceCollection(newKey, [next], db)
  expect(findDocument('project', 'first', db)).toBeUndefined()
  expect(listDocuments(db).articles.map((article) => article.slug)).toEqual(['next'])
  expect(findCollection('project', db)?.articles.map((article) => article.slug)).toEqual(['next'])
})

test('request parsing enforces the actual body size without relying on Content-Length', async () => {
  const request = new Request('http://localhost:3000/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"large":"123456789"}',
  })
  await expect(readJson(request, 10)).rejects.toThrow()
})

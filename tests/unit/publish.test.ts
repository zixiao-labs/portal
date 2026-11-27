import { expect, test, vi } from '@lightning-js/lightning'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { api } from '../../src/server/api'
import { findDocument, store } from '../../src/server/store'

test('publish accepts only a short-lived, signed GitHub OIDC bearer for an allowlisted repository', async () => {
  const origin = 'http://localhost:3000'
  const issuer = 'https://token.actions.githubusercontent.com'
  const path = '/api/publish'
  const audience = origin + path
  const algorithm = 'RS256'
  const { publicKey, privateKey } = await generateKeyPair(algorithm)
  const other = await generateKeyPair(algorithm)
  const jwk = { ...(await exportJWK(publicKey)), kid: 'github-test', alg: algorithm, use: 'sig' }
  const fetchKeys = vi.fn(async (url: string) => {
    expect(url).toBe(`${issuer}/.well-known/jwks`)
    return Response.json({ keys: [jwk] })
  })
  vi.stubGlobal('fetch', fetchKeys)
  vi.stubEnv('PORTAL_RUNTIME_MODE', 'test')
  vi.stubEnv('PORTAL_ORIGIN', origin)
  vi.stubEnv('GITHUB_ORG_ID', '11')
  vi.stubEnv('SQLITE_PATH', ':memory:')
  const time = Math.floor(Date.now() / 1000)
  const payload = {
    iss: issuer,
    aud: audience,
    sub: 'repo:zixiao-labs/project:environment:docs-publish',
    repository_owner_id: '11',
    repository_owner: 'zixiao-labs',
    repository_id: '33',
    repository: 'zixiao-labs/project',
    ref: 'refs/heads/main',
    environment: 'docs-publish',
    event_name: 'workflow_dispatch',
    workflow_ref: 'zixiao-labs/project/.github/workflows/publish-docs.yml@refs/heads/main',
    sha: 'a'.repeat(40),
    jti: 'test-run',
    iat: time,
    nbf: time,
    exp: time + 300,
  }
  const jwt = (claims?: JWTPayload, key = privateKey) =>
    new SignJWT({ ...payload, ...claims })
      .setProtectedHeader({ alg: algorithm, typ: 'JWT', kid: jwk.kid })
      .sign(key)
  const send = (token: string, headers?: HeadersInit) =>
    api(
      new Request(audience, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify({ files: [{ path: 'start.md', content: '# Start\n\nBody.' }] }),
      }),
      path,
    )
  try {
    const good = await jwt()
    expect((await send(good)).status).toBe(403)
    const db = store()
    const add = db.prepare('INSERT INTO publish_repositories VALUES (?, ?)')
    add.run('33', 'zixiao-labs/project')
    add.run('44', 'zixiao-labs/other')
    expect((await send(`zxp_${'a'.repeat(43)}`, { 'X-GitHub-Actions-OIDC': good })).status).toBe(
      401,
    )
    expect((await send(await jwt({ aud: 'https://wrong.example/api/publish' }))).status).toBe(403)
    expect((await send(await jwt({ iss: 'https://wrong.example' }))).status).toBe(403)
    expect((await send(await jwt({ exp: time - 1 }))).status).toBe(403)
    expect((await send(await jwt({ iat: time - 361 }))).status).toBe(403)
    expect((await send(await jwt({ repository_id: '44' }))).status).toBe(403)
    expect((await send(await jwt({}, other.privateKey))).status).toBe(403)
    expect(findDocument('project', 'start')).toBeUndefined()
    const published = await send(good)
    expect(published.status).toBe(200)
    expect(await published.json()).toEqual({
      collection: 'project',
      count: 1,
      url: `${origin}/docs/project`,
      llmsTxt: `${origin}/docs/project/llms.txt`,
    })
    expect(findDocument('project', 'start')?.title).toBe('Start')
    expect((await send(good)).status).toBe(409)
    const otherRepo = {
      repository_id: '44',
      repository: 'zixiao-labs/other',
      workflow_ref: 'zixiao-labs/other/.github/workflows/publish-docs.yml@refs/heads/main',
      jti: 'second-repo-run',
    }
    expect((await send(await jwt(otherRepo))).status).toBe(200)
    expect(findDocument('other', 'start')?.title).toBe('Start')
    db.prepare('DELETE FROM publish_repositories WHERE id=?').run('33')
    expect((await send(await jwt({ jti: 'revoked-repo' }))).status).toBe(403)
    expect(findDocument('project', 'start')?.title).toBe('Start')
    expect((await send(await jwt({ ...otherRepo, jti: 'still-authorized' }))).status).toBe(200)
    expect(fetchKeys).toHaveBeenCalledTimes(1)
  } finally {
    store().close()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

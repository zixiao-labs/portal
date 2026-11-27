import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import rehypeParse from 'rehype-parse'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { organization, organizationRepository, validNumericId } from '../deployment.mjs'
import { collectionPath, llmsPath } from '../doc-path'
import { config } from './config'
import { HttpError, readJson } from './http'
import { canPublish, store, transaction, type Article } from './store'

const issuer = 'https://token.actions.githubusercontent.com'
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`))
const mainRef = 'refs/heads/main'
const workflow = '.github/workflows/publish-docs.yml'
const environment = 'docs-publish'
const sanitizeSchema = {
  ...defaultSchema,
  // Uploaded markup cannot load external resources or change the surrounding portal.
  tagNames: [
    ...new Set([
      ...(defaultSchema.tagNames ?? []).filter((name) => name !== 'img'),
      'details',
      'summary',
      'mark',
    ]),
  ],
  clobberPrefix: 'doc-',
}

export function actionsClaims(claims: JWTPayload, orgId: string) {
  const repository = organizationRepository(claims.repository)
  const repositoryId = claims.repository_id
  const expectedWorkflow = `${claims.repository}/${workflow}@${mainRef}`
  if (
    claims.repository_owner_id !== orgId ||
    claims.repository_owner !== organization ||
    !repository ||
    !validNumericId(repositoryId) ||
    claims.ref !== mainRef ||
    claims.environment !== environment ||
    (claims.event_name !== 'push' && claims.event_name !== 'workflow_dispatch') ||
    claims.workflow_ref !== expectedWorkflow ||
    (claims.job_workflow_ref !== undefined && claims.job_workflow_ref !== expectedWorkflow) ||
    typeof claims.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(claims.sha) ||
    typeof claims.jti !== 'string' ||
    !claims.jti ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp)
  ) {
    throw new HttpError(403, '仅允许组织内受保护的文档发布工作流。')
  }
  return { repository, repositoryId, revision: claims.sha, jwtId: claims.jti, expires: claims.exp }
}

type Tree = {
  type: string
  tagName?: string
  value?: string
  children?: Tree[]
  name?: string | null
  attributes?: unknown[]
  data?: object
}
const staticMdxTags = new Set([
  'details',
  'summary',
  'div',
  'span',
  'mark',
  'kbd',
  'sub',
  'sup',
  'strong',
  'em',
])

function walk(node: Tree, visit: (node: Tree, parent?: Tree) => void, parent?: Tree) {
  visit(node, parent)
  node.children?.forEach((child) => walk(child, visit, node))
}

function text(node: Tree): string {
  return node.type === 'text' ? (node.value ?? '') : (node.children?.map(text).join('') ?? '')
}

export async function renderArticle(path: string, source: string): Promise<Article> {
  if (
    path.length > 240 ||
    !/^(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:mdx|md|html)$/.test(path)
  ) {
    throw new HttpError(400, `不支持的文档路径：${path.slice(0, 240)}`)
  }
  const slug = path.slice(0, path.lastIndexOf('.'))
  const format = path.slice(path.lastIndexOf('.') + 1)
  try {
    const html = unified().use(rehypeParse, { fragment: true })
    const md = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
    const mdx = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMdx)
      .use(() => (root) => {
        walk(root, (node) => {
          if (
            (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
            node.name &&
            staticMdxTags.has(node.name) &&
            node.attributes?.length === 0
          ) {
            node.type = 'portalStaticElement'
            node.data = { hName: node.name }
          }
          if (node.type.startsWith('mdx')) {
            throw new HttpError(
              400,
              `${path} 含有不支持的 MDX 语法，仅允许 Markdown 与无属性的白名单标签。`,
            )
          }
        })
      })
      .use(remarkRehype)
    const parsed =
      format === 'html'
        ? await html.run(html.parse(source))
        : format === 'mdx'
          ? await mdx.run(mdx.parse(source))
          : await md.run(md.parse(source))
    const renderer = unified().use(rehypeSanitize, sanitizeSchema).use(rehypeStringify)
    // All three parser pipelines end in a HAST root; unified widens some plugin outputs to Node.
    const tree = await renderer.run(parsed as ReturnType<typeof html.parse>)
    let title = ''
    let summary = ''
    walk(tree, (node, parent) => {
      if (node.type === 'element' && node.tagName === 'h1') {
        const heading = text(node).replace(/\s+/g, ' ').trim().slice(0, 120)
        if (!title && heading && parent) {
          title = heading
          parent.children = parent.children?.filter((child) => child !== node)
        } else node.tagName = 'h2'
      }
      if (!summary && node.type === 'element' && node.tagName === 'p') {
        summary = text(node).replace(/\s+/g, ' ').trim().slice(0, 160)
      }
    })
    return {
      slug,
      title: title || slug.split('/').at(-1)!,
      summary,
      html: renderer.stringify(tree),
      format,
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, `无法解析文档：${path}`)
  }
}

type Identity = ReturnType<typeof actionsClaims>
export function replaceCollection(identity: Identity, articles: Article[], db = store()) {
  const { repository } = identity
  const name = repository.split('/')[1]
  transaction(db, () => {
    if (!canPublish(identity.repositoryId, repository, db))
      throw new HttpError(403, '此仓库没有文档发布权限。')
    const published = Math.floor(Date.now() / 1000)
    if (identity.expires <= published) throw new HttpError(403, '工作流身份已过期。')
    db.prepare('DELETE FROM publish_runs WHERE expires<=?').run(published)
    const registered = db
      .prepare('INSERT OR IGNORE INTO publish_runs VALUES (?, ?)')
      .run(identity.jwtId, identity.expires)
    if (!registered.changes) throw new HttpError(409, '本次工作流身份已用于发布。')
    const existing = db
      .prepare('SELECT name, repository_id FROM collections WHERE name=? OR repository_id=?')
      .get(name, identity.repositoryId)
    if (existing && (existing.repository_id !== identity.repositoryId || existing.name !== name)) {
      throw new HttpError(409, '该仓库或文档集合需要管理员迁移。')
    }
    db.prepare(`INSERT INTO collections VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET revision=excluded.revision, published=excluded.published`).run(
      name,
      repository,
      identity.repositoryId,
      identity.revision,
      published,
    )
    db.prepare('DELETE FROM articles WHERE collection=?').run(name)
    const insert = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?)')
    for (const article of articles)
      insert.run(name, article.slug, article.title, article.summary, article.html, article.format)
  })
  return name
}

export async function publish(request: Request) {
  const { origin, orgId } = config()
  if (!orgId) throw new HttpError(503, '尚未启用文档发布。')
  const assertion = request.headers
    .get('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)?.[1]
  if (!assertion || assertion.length > 8192)
    throw new HttpError(401, '需要 GitHub Actions OIDC 身份。')
  let claims: JWTPayload
  try {
    const verified = await jwtVerify(assertion, keys, {
      issuer,
      audience: `${origin}/api/publish`,
      algorithms: ['RS256'],
      requiredClaims: ['iat', 'exp', 'jti', 'sub'],
      maxTokenAge: '6 minutes',
    })
    claims = verified.payload
  } catch {
    throw new HttpError(403, '无法验证 GitHub Actions OIDC 身份。')
  }
  const identity = actionsClaims(claims, orgId)
  if (!canPublish(identity.repositoryId, identity.repository))
    throw new HttpError(403, '此仓库没有文档发布权限。')
  const { files } = await readJson(request, 2 * 1024 * 1024)
  if (!Array.isArray(files) || !files.length || files.length > 250) {
    throw new HttpError(400, '每次需提交 1–250 篇文档。')
  }
  const articles: Article[] = []
  const slugs = new Set<string>()
  for (const file of files) {
    if (
      typeof file?.path !== 'string' ||
      typeof file?.content !== 'string' ||
      file.content.length > 120_000
    ) {
      throw new HttpError(400, '无效文档或单篇文档超过 120,000 字符。')
    }
    const document = await renderArticle(file.path, file.content)
    if (slugs.has(document.slug)) throw new HttpError(400, `文档路由重复：${document.slug}`)
    slugs.add(document.slug)
    articles.push(document)
  }
  const collection = replaceCollection(identity, articles)
  return {
    collection,
    count: articles.length,
    url: origin + collectionPath(collection),
    llmsTxt: origin + llmsPath(collection),
  }
}

import { articlePath, collectionPath } from '../doc-path'
import { findCollection, listDocuments } from './store'

const plainText = { 'Content-Type': 'text/plain; charset=utf-8' }
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>]/g, '\\$&')

export function documentDiscovery(request: Request, pathname: string, origin: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  const body = (value: string) => (request.method === 'HEAD' ? null : value)
  if (pathname === '/sitemap.xml') {
    const { collections, articles } = listDocuments()
    const paths = [
      '/login',
      '/docs',
      ...collections.map(({ name }) => collectionPath(name)),
      ...articles.map(({ collection, slug }) => articlePath(collection, slug)),
    ]
    return new Response(
      body(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`,
      ),
      { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
    )
  }

  const name = /^\/docs\/([a-z0-9][a-z0-9_.-]{0,99})\/llms\.txt$/.exec(pathname)?.[1]
  if (!name) return
  const snapshot = findCollection(name)
  if (!snapshot)
    return new Response(body('Documentation repository not found.\n'), {
      status: 404,
      headers: plainText,
    })
  const { collection, articles } = snapshot
  const links = articles.map(({ slug, title, summary }) => {
    const label = escapeMarkdown(title)
    const link = `${origin}${articlePath(name, slug)}`
    return `- [${label}](${link})${summary ? `: ${escapeMarkdown(summary)}` : ''}`
  })
  return new Response(
    body(
      `# ${name}\n\n> Public documentation for ${collection.repository}.\n\n## Documents\n\n${links.join('\n')}\n`,
    ),
    { headers: plainText },
  )
}

import { createServerEntry } from '@tanstack/react-start/server-entry'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { acceptsHost } from './deployment.mjs'
import { api } from './server/api'
import { config } from './server/config'
import { listDocuments } from './server/store'

const render = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  async fetch(request, options) {
    const { origin } = config()
    const url = new URL(request.url)
    if (!acceptsHost(request.headers.get('host') ?? url.host, origin)) {
      return new Response('Unauthorized deployment host', { status: 421 })
    }
    if (url.pathname.startsWith('/api/')) return api(request, url.pathname)
    if (url.pathname === '/robots.txt')
      return new Response(
        `User-agent: *\nDisallow: /api/\nDisallow: /account\nSitemap: ${origin}/sitemap.xml\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    if (url.pathname === '/sitemap.xml') {
      const paths = [
        '/login',
        '/docs',
        ...listDocuments().articles.map(({ collection, slug }) => `/docs/${collection}/${slug}`),
      ]
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`,
        { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
      )
    }
    const response = await render(request, options)
    if (url.pathname === '/account') {
      response.headers.set('X-Robots-Tag', 'noindex')
      response.headers.set('Cache-Control', 'private, no-store')
    }
    return response
  },
})

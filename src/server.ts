import { createServerEntry } from '@tanstack/react-start/server-entry'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { acceptsHost } from './deployment.mjs'
import { api } from './server/api'
import { config } from './server/config'
import { documentDiscovery } from './server/documents'
import { mcpMetadata } from './server/mcp-auth'

const render = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  async fetch(request, options) {
    const { origin } = config()
    const url = new URL(request.url)
    if (!acceptsHost(request.headers.get('host') ?? url.host, origin)) {
      return new Response('Unauthorized deployment host', { status: 421 })
    }
    if (url.pathname.startsWith('/api/')) return api(request, url.pathname)
    const metadata = mcpMetadata(request, url.pathname, origin)
    if (metadata) return metadata
    if (url.pathname === '/robots.txt')
      return new Response(
        `User-agent: *\nDisallow: /api/\nDisallow: /account\nDisallow: /admin\nSitemap: ${origin}/sitemap.xml\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    const discovery = documentDiscovery(request, url.pathname, origin)
    if (discovery) return discovery
    const response = await render(request, options)
    if (/^\/(?:account|admin)\/?$/.test(url.pathname)) {
      response.headers.set('X-Robots-Tag', 'noindex')
      response.headers.set('Cache-Control', 'private, no-store')
    }
    if (/^\/login\/?$/.test(url.pathname) && url.searchParams.get('mcp') === 'true') {
      response.headers.set('X-Robots-Tag', 'noindex')
      response.headers.set('Cache-Control', 'private, no-store')
      response.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
      response.headers.set('Referrer-Policy', 'same-origin')
    }
    return response
  },
})

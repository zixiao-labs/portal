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
    const privateArea = /^\/(?:account|admin)\/?$/.test(url.pathname)
    const login = /^\/login\/?$/.test(url.pathname)
    const mcpLogin = login && url.searchParams.get('mcp') === 'true'
    const emailVerification = login && url.searchParams.get('verifyEmail') === 'true'
    if (privateArea || login) response.headers.set('Cache-Control', 'private, no-store')
    if (privateArea || mcpLogin || emailVerification) {
      response.headers.set('X-Robots-Tag', 'noindex')
    }
    if (mcpLogin) {
      response.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
      response.headers.set('Referrer-Policy', 'same-origin')
    }
    return response
  },
})

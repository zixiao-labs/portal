import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sirv from 'sirv'
import { acceptsHost } from '../src/deployment.mjs'

export function servePortal(handler, { origin, assets }) {
  const staticFiles = sirv(assets, {
    etag: true,
    setHeaders(res, pathname) {
      if (pathname === '/sw.js' || pathname === '/manifest.webmanifest')
        res.setHeader('Cache-Control', 'no-cache')
    },
  })
  return createServer((req, res) => {
    if (!acceptsHost(req.headers.host, origin)) {
      res.writeHead(421).end('Unauthorized deployment host')
      return
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (origin.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    staticFiles(req, res, () => {
      void dispatch().catch((error) => {
        console.error(error.name, error.code ?? '')
        if (res.headersSent) res.destroy()
        else res.writeHead(500).end('Internal Server Error')
      })
    })
    async function dispatch() {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
        res.writeHead(400).end()
        return
      }
      const url = new URL(req.url, origin)
      if (url.origin !== origin) {
        res.writeHead(400).end()
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined && !key.startsWith('x-forwarded-') && key !== 'forwarded') {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
      }
      const signal = new AbortController()
      res.once('close', () => {
        if (!res.writableEnded) signal.abort()
      })
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req)
      const response = await handler.fetch(
        new Request(url, {
          method: req.method,
          headers,
          body,
          duplex: 'half',
          signal: signal.signal,
        }),
      )
      for (const [key, value] of response.headers) {
        if (key !== 'set-cookie') res.setHeader(key, value)
      }
      if (response.headers.has('set-cookie'))
        res.setHeader('Set-Cookie', response.headers.getSetCookie())
      res.statusCode = response.status
      if (response.body && req.method !== 'HEAD')
        await pipeline(Readable.fromWeb(response.body), res)
      else res.end()
    }
  })
}

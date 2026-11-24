import { deploymentOrigin } from '../src/deployment.mjs'
import { servePortal } from './http.mjs'

const origin = deploymentOrigin(process.env.PORTAL_ORIGIN, true)
for (const key of [
  'PORTAL_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SMTP_URL',
  'SMTP_FROM',
]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`)
}
if (Buffer.byteLength(process.env.PORTAL_SECRET) < 32)
  throw new Error('PORTAL_SECRET must be at least 32 bytes')
const smtp = new URL(process.env.SMTP_URL)
if (!['smtp:', 'smtps:'].includes(smtp.protocol) || smtp.port === '25') {
  throw new Error('Use SMTP submission (STARTTLS on 587 or implicit TLS on 465), not port 25.')
}
if (!/^\d+$/.test(process.env.GITHUB_ORG_ID ?? '')) throw new Error('GITHUB_ORG_ID is required')
process.env.NODE_ENV = 'production'
process.env.PORTAL_RUNTIME_MODE = 'production'
const { default: handler } = await import('../dist/server/server.mjs')
const port = Number(process.env.PORT ?? '3000')
servePortal(handler, { origin, assets: 'dist/client' }).listen(
  port,
  process.env.BIND_HOST ?? '127.0.0.1',
  () => {
    console.log(`Portal listening on :${port} for ${origin}`)
  },
)

import { deploymentOrigin } from '../src/deployment.mjs'
import { smtpSettings } from '../src/server/smtp.mjs'
import { servePortal } from './http.mjs'

const origin = deploymentOrigin(process.env.PORTAL_ORIGIN, true)
for (const key of ['PORTAL_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`)
}
if (Buffer.byteLength(process.env.PORTAL_SECRET) < 32)
  throw new Error('PORTAL_SECRET must be at least 32 bytes')
smtpSettings(process.env.SMTP_URL, process.env.SMTP_FROM)
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

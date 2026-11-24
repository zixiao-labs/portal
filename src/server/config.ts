import { randomBytes } from 'node:crypto'
import { deploymentOrigin } from '../deployment.mjs'

const localSecret = randomBytes(32).toString('hex')

export function config() {
  const production = process.env.PORTAL_RUNTIME_MODE === 'production'
  return {
    origin: deploymentOrigin(process.env.PORTAL_ORIGIN, production),
    secret: process.env.PORTAL_SECRET || localSecret,
    smtpUrl: process.env.SMTP_URL,
    smtpFrom: process.env.SMTP_FROM,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    orgId: process.env.GITHUB_ORG_ID,
  }
}

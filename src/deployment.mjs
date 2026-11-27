export const canonicalOrigin = 'https://zixiaolabs.com'
export const organization = 'zixiao-labs'
export const employeeDomain = 'zixiaolabs.com'

export function adminEmails(value) {
  if (!value?.trim()) return new Set()
  const emails = value.split(',').map((email) => email.trim().toLowerCase())
  if (
    emails.some((email) => {
      const [local, domain, extra] = email.split('@')
      return (
        domain !== employeeDomain ||
        extra !== undefined ||
        !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local)
      )
    })
  )
    throw new Error('PORTAL_ADMIN_EMAILS must contain comma-separated employee email addresses.')
  return new Set(emails)
}

const repositoryPattern = new RegExp(`^${organization}/[a-z0-9][a-z0-9_.-]{0,99}$`)
export function organizationRepository(value) {
  const name = typeof value === 'string' ? value.toLowerCase() : ''
  return repositoryPattern.test(name) ? name : undefined
}

export function validNumericId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
}

export function deploymentOrigin(value, production) {
  const url = new URL(value || (production ? '' : 'http://localhost:3000'))
  const { hostname } = url
  const company = hostname === employeeDomain || hostname.endsWith(`.${employeeDomain}`)
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !(
      (url.protocol === 'https:' && company && !url.port) ||
      (!production && loopback && url.protocol === 'http:')
    )
  ) {
    throw new Error('Deployment is restricted to HTTPS on zixiaolabs.com and its subdomains.')
  }
  return url.origin
}

export function acceptsHost(host, origin) {
  return typeof host === 'string' && host.toLowerCase() === new URL(origin).host
}

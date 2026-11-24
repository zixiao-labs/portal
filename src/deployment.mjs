export const canonicalOrigin = 'https://portal.zixiaolabs.com'
export const organization = 'zixiao-labs'
export const employeeDomain = 'zixiaolabs.com'

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

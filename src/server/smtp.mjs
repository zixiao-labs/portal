const failureCodes = new Set([
  'EAUTH',
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDNS',
  'EENVELOPE',
  'EMESSAGE',
  'EPROTOCOL',
  'ESOCKET',
  'ETIMEDOUT',
  'ETLS',
])

class SmtpSettingsError extends Error {}

// Shared by the login handler, production startup and the SMTP connection check.
export function smtpSettings(url, from) {
  if (!url) throw new SmtpSettingsError('Missing SMTP_URL')
  if (!from?.trim()) throw new SmtpSettingsError('Missing SMTP_FROM')
  const smtp = URL.parse(url)
  if (
    !smtp ||
    !/^smtps?:\/\//i.test(url) ||
    /[\s?#]/u.test(url) ||
    !smtp.hostname ||
    (smtp.pathname !== '' && smtp.pathname !== '/')
  ) {
    throw new SmtpSettingsError(
      'SMTP_URL must be an smtp:// or smtps:// URL without a path, query or fragment',
    )
  }

  const secure = smtp.protocol === 'smtps:'
  const port = Number(smtp.port || (secure ? 465 : 587))
  if (port === 0 || port === 25 || (!secure && port === 465)) {
    throw new SmtpSettingsError(
      'Use smtps:// for port 465 or smtp:// for STARTTLS (normally port 587), not port 25',
    )
  }
  if (!smtp.username || !smtp.password)
    throw new SmtpSettingsError('SMTP_URL must include a username and password')
  let auth
  try {
    auth = { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) }
  } catch {
    throw new SmtpSettingsError('SMTP_URL credentials must use valid percent encoding')
  }

  const sender = from.trim()
  const named = /^([^<>]+)<([^<>]+)>$/.exec(sender)
  const address = (named?.[2] ?? sender).trim()
  if (
    /[\r\n]/.test(from) ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(address)
  ) {
    throw new SmtpSettingsError('SMTP_FROM must specify one sender mailbox')
  }
  const name = named?.[1].trim().replace(/^"(.*)"$/, '$1') ?? ''

  return {
    from: { name, address },
    options: {
      host: smtp.hostname.replace(/^\[(.*)\]$/, '$1'),
      port,
      secure,
      requireTLS: !secure,
      tls: { rejectUnauthorized: true },
      auth,
      forceAuth: true,
      dnsTimeout: 10_000,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    },
  }
}

// Never include the provider's message or response text: it may contain private data.
export function smtpFailure(error) {
  if (error instanceof SmtpSettingsError) return error.message
  const { code, responseCode } = error ?? {}
  const kind = failureCodes.has(code) ? code : 'UNKNOWN'
  return Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600
    ? `${kind} (${responseCode})`
    : kind
}

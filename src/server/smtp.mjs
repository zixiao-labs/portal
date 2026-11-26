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
export function smtpSettings(env = process.env) {
  const {
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_TLS_MODE: tlsMode,
    SMTP_USER: user,
    SMTP_PASSWORD: password,
    SMTP_FROM: from,
    SMTP_FROM_NAME: fromName,
  } = env
  if (env.SMTP_URL) {
    throw new SmtpSettingsError('Replace SMTP_URL with SMTP_HOST, SMTP_USER and SMTP_PASSWORD')
  }
  if (![smtpHost, smtpPort, tlsMode, user, password, from, fromName].some(Boolean)) return

  const host = smtpHost?.trim()
  if (!host) throw new SmtpSettingsError('Missing SMTP_HOST')
  if (
    !/^(?=.{1,253}$)(?![0-9.]+$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      host,
    )
  ) {
    throw new SmtpSettingsError('SMTP_HOST must be a DNS hostname, without a URL or port')
  }

  const mode = tlsMode?.trim() || 'implicit'
  if (mode !== 'implicit' && mode !== 'starttls') {
    throw new SmtpSettingsError('SMTP_TLS_MODE must be implicit or starttls')
  }
  const secure = mode === 'implicit'
  const portValue = smtpPort?.trim() || (secure ? '465' : '587')
  const port = Number(portValue)
  if (!/^\d{1,5}$/.test(portValue) || port < 1 || port > 65535 || port === 25) {
    throw new SmtpSettingsError('SMTP_PORT must be an integer from 1 to 65535, excluding port 25')
  }
  if (!secure && port === 465) {
    throw new SmtpSettingsError('SMTP_TLS_MODE must be implicit for port 465')
  }
  if (!user || /[\r\n]/.test(user)) {
    throw new SmtpSettingsError('SMTP_USER must be a non-empty, single-line value')
  }
  if (!password || /[\r\n]/.test(password)) {
    throw new SmtpSettingsError('SMTP_PASSWORD must be a non-empty, single-line value')
  }

  const sender = from || user
  const address = sender.trim()
  if (
    /[\r\n]/.test(sender) ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(address)
  ) {
    throw new SmtpSettingsError('SMTP_FROM must be a single email address (defaults to SMTP_USER)')
  }
  if (fromName && /[\r\n]/.test(fromName)) {
    throw new SmtpSettingsError('SMTP_FROM_NAME must be a single-line display name')
  }

  return {
    from: { name: fromName?.trim() ?? '', address },
    options: {
      host,
      port,
      secure,
      requireTLS: !secure,
      tls: { rejectUnauthorized: true },
      auth: { user, pass: password },
      forceAuth: true,
      dnsTimeout: 10_000,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    },
  }
}

export function requireSmtpSettings(env = process.env) {
  const smtp = smtpSettings(env)
  if (!smtp) throw new SmtpSettingsError('Missing SMTP_HOST, SMTP_USER and SMTP_PASSWORD')
  return smtp
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

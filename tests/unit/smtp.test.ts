import { expect, test } from '@lightning-js/lightning'
import { requireSmtpSettings, smtpSettings } from '../../src/server/smtp.mjs'

const env = {
  SMTP_HOST: 'smtp.qiye.aliyun.com',
  SMTP_USER: 'portal@zixiaolabs.com',
  SMTP_PASSWORD: ' p@ss:/#%ZZ=word ',
}

test('AliMail defaults to implicit TLS and uses literal credentials and the login mailbox', () => {
  const settings = requireSmtpSettings({ ...env, SMTP_FROM_NAME: '紫霄实验室' })
  expect(settings.from).toEqual({ name: '紫霄实验室', address: env.SMTP_USER })
  expect(settings.options).toMatchObject({
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
    requireTLS: false,
    tls: { rejectUnauthorized: true },
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    forceAuth: true,
  })
})

test('STARTTLS requires a TLS upgrade and supports custom ports and a separate sender', () => {
  const starttls = {
    ...env,
    SMTP_TLS_MODE: 'starttls',
    SMTP_USER: 'relay-user',
    SMTP_FROM: 'no-reply@zixiaolabs.com',
  }
  const { options, from } = requireSmtpSettings(starttls)
  expect(from).toEqual({ name: '', address: 'no-reply@zixiaolabs.com' })
  expect(options).toMatchObject({
    port: 587,
    secure: false,
    requireTLS: true,
    tls: { rejectUnauthorized: true },
  })
  expect(requireSmtpSettings({ ...starttls, SMTP_PORT: '2525' }).options.port).toBe(2525)
})

test('blank settings disable SMTP locally but are rejected when SMTP is required', () => {
  const blanks = { SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '' }
  expect(smtpSettings(blanks)).toBeUndefined()
  expect(() => requireSmtpSettings(blanks)).toThrow(/SMTP_HOST.*SMTP_USER.*SMTP_PASSWORD/)
  expect(() => smtpSettings({ SMTP_FROM_NAME: 'Portal' })).toThrow(/Missing SMTP_HOST/)
})

test('legacy SMTP URLs are rejected without printing credentials', () => {
  expect(() =>
    smtpSettings({ ...env, SMTP_URL: 'smtps://user:private-value@relay.example.org' }),
  ).toThrow(/^Replace SMTP_URL with SMTP_HOST, SMTP_USER and SMTP_PASSWORD$/)
})

test('SMTP rejects invalid hosts, ports, TLS modes, credentials and senders', () => {
  const cases: [NodeJS.ProcessEnv, RegExp][] = [
    [{ SMTP_HOST: '' }, /SMTP_HOST/],
    [{ SMTP_HOST: 'smtps://mail.example.org' }, /SMTP_HOST/],
    [{ SMTP_HOST: 'mail.example.org:465' }, /SMTP_HOST/],
    [{ SMTP_HOST: 'mail.example.org?tls=false' }, /SMTP_HOST/],
    [{ SMTP_TLS_MODE: 'none' }, /SMTP_TLS_MODE/],
    [{ SMTP_TLS_MODE: 'starttls', SMTP_PORT: '465' }, /implicit for port 465/],
    [{ SMTP_PORT: '25' }, /SMTP_PORT/],
    [{ SMTP_PORT: '0' }, /SMTP_PORT/],
    [{ SMTP_PORT: '65536' }, /SMTP_PORT/],
    [{ SMTP_PORT: '4.65e2' }, /SMTP_PORT/],
    [{ SMTP_USER: '' }, /SMTP_USER/],
    [{ SMTP_USER: 'user\nname' }, /SMTP_USER/],
    [{ SMTP_USER: 'relay-user' }, /SMTP_FROM/],
    [{ SMTP_PASSWORD: '' }, /SMTP_PASSWORD/],
    [{ SMTP_PASSWORD: 'split\npassword' }, /SMTP_PASSWORD/],
    [{ SMTP_FROM: 'Portal <portal@example.org>' }, /SMTP_FROM/],
    [{ SMTP_FROM: 'portal@example.org, other@example.org' }, /SMTP_FROM/],
    [{ SMTP_FROM_NAME: 'Portal\r\nOther' }, /SMTP_FROM_NAME/],
  ]
  for (const [overrides, error] of cases) {
    expect(() => smtpSettings({ ...env, ...overrides })).toThrow(error)
  }
})

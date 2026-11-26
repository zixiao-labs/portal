import { expect, test } from '@lightning-js/lightning'
import { smtpSettings } from '../../src/server/smtp.mjs'

const from = 'portal@zixiaolabs.com'

test('AliMail uses implicit TLS and decodes each credential once', () => {
  const settings = smtpSettings(
    'smtps://portal%40zixiaolabs.com:p%40ss%3A%2F%23%2520@smtp.qiye.aliyun.com',
    `紫霄实验室 <${from}>`,
  )
  expect(settings.from).toEqual({ name: '紫霄实验室', address: from })
  expect(settings.options).toMatchObject({
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
    requireTLS: false,
    tls: { rejectUnauthorized: true },
    auth: { user: from, pass: 'p@ss:/#%20' },
    forceAuth: true,
  })
})

test('smtp:// requires STARTTLS regardless of the portal origin', () => {
  const { options } = smtpSettings('smtp://user:pass@smtp.example.org', from)
  expect(options).toMatchObject({
    port: 587,
    secure: false,
    requireTLS: true,
    tls: { rejectUnauthorized: true },
  })
})

test('SMTP configuration rejects invalid credentials, endpoints and senders', () => {
  for (const url of [
    undefined,
    'https://user:pass@smtp.example.org',
    'smtp://user:pass@smtp.example.org:465',
    'smtps://user:pass@smtp.example.org:25',
    'smtps://user:pass@smtp.example.org:0',
    'smtps://user:pass@smtp.example.org:99999',
    'smtps://user:pass@',
    'smtps://smtp.example.org',
    'smtps://user@smtp.example.org',
    'smtps://user:bad%ZZ@smtp.example.org',
    'smtps://user:pass@smtp.example.org/path',
    'smtps://user:pass@smtp.example.org?tls.rejectUnauthorized=false',
    'smtps://user:pass@smtp.example.org#fragment',
  ]) {
    expect(() => smtpSettings(url, from)).toThrow(/SMTP_URL|port 465/)
  }
  for (const from of [undefined, 'portal', 'portal@example.org, other@example.org']) {
    expect(() => smtpSettings('smtps://user:pass@smtp.example.org', from)).toThrow(/SMTP_FROM/)
  }
})

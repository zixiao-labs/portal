import nodemailer from 'nodemailer'
import { requireSmtpSettings, smtpFailure } from '../src/server/smtp.mjs'

try {
  const { options } = requireSmtpSettings()
  await nodemailer.createTransport(options).verify()
  console.log('SMTP TLS and authentication verified. No email was sent.')
} catch (error) {
  console.error('SMTP check failed:', smtpFailure(error))
  process.exitCode = 1
}

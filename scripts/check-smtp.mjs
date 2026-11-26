import nodemailer from 'nodemailer'
import { smtpFailure, smtpSettings } from '../src/server/smtp.mjs'

try {
  const { options } = smtpSettings(process.env.SMTP_URL, process.env.SMTP_FROM)
  await nodemailer.createTransport(options).verify()
  console.log('SMTP TLS and authentication verified. No email was sent.')
} catch (error) {
  console.error('SMTP check failed:', smtpFailure(error))
  process.exitCode = 1
}

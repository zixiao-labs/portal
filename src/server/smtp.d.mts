import type { Address } from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'

type SmtpSettings = {
  from: Address
  options: SMTPTransport.Options
}

export function smtpSettings(env?: NodeJS.ProcessEnv): SmtpSettings | undefined
export function requireSmtpSettings(env?: NodeJS.ProcessEnv): SmtpSettings
export function smtpFailure(error: unknown): string

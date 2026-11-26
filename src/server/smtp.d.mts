import type { Address } from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'

export function smtpSettings(
  url: string | undefined,
  from: string | undefined,
): {
  from: Address
  options: SMTPTransport.Options
}

export function smtpFailure(error: unknown): string

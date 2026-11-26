import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import nodemailer from 'nodemailer'
import { employeeDomain } from '../deployment.mjs'
import { config } from './config'
import { cookie, cookieName, hash, HttpError, json, opaque, setCookie } from './http'
import { smtpFailure, smtpSettings } from './smtp.mjs'
import { store, transaction, type User } from './store'

const sessionAge = 7 * 86400
const codeAge = 600
const now = () => Math.floor(Date.now() / 1000)

export function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') throw new HttpError(400, '请输入有效的邮箱地址。')
  const email = value.trim().toLowerCase()
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      email,
    )
  ) {
    throw new HttpError(400, '请输入有效的邮箱地址。')
  }
  return email
}

export function isEmployeeEmail(email: string) {
  return email.split('@')[1] === employeeDomain
}

export function employeeLoginEmail(value: unknown) {
  const email = normalizeEmail(value)
  if (!isEmployeeEmail(email))
    throw new HttpError(403, '邮箱登录仅限 @zixiaolabs.com；其他用户请使用 GitHub。')
  return email
}

export function verifiedUser(email: string, githubId?: string, db = store()) {
  return transaction(db, () => {
    if (githubId) {
      const known = db.prepare('SELECT email FROM users WHERE github_id = ?').get(githubId)
      const existing = db.prepare('SELECT github_id FROM users WHERE email = ?').get(email)
      if (
        (known && known.email !== email) ||
        (existing?.github_id && existing.github_id !== githubId)
      ) {
        throw new HttpError(409, 'GitHub 身份与现有账户不匹配，请用原邮箱登录。')
      }
    }
    return db
      .prepare(`INSERT INTO users(email, employee, github_id) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET github_id=coalesce(excluded.github_id, users.github_id)
      RETURNING *`)
      .get(email, Number(isEmployeeEmail(email)), githubId ?? null) as User
  })
}

export function sessionUser(request: Request) {
  const token = cookie(request, cookieName(config().origin, 'session'))
  if (!token) return
  return store()
    .prepare(`SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id
    WHERE sessions.hash=? AND sessions.expires>?`)
    .get(hash(token), now()) as User | undefined
}

export function removeSession(request: Request) {
  const { origin } = config()
  const name = cookieName(origin, 'session')
  const token = cookie(request, name)
  if (token) store().prepare('DELETE FROM sessions WHERE hash=?').run(hash(token))
  return setCookie(origin, name, '', 0)
}

function newSession(request: Request, user: User) {
  const { origin } = config()
  removeSession(request)
  const token = opaque()
  store().prepare('DELETE FROM sessions WHERE expires <= ?').run(now())
  store()
    .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .run(hash(token), user.id, now() + sessionAge)
  return setCookie(origin, cookieName(origin, 'session'), token, sessionAge)
}

function codeHash(secret: string, email: string, browser: string, code: string) {
  return createHmac('sha256', secret)
    .update(JSON.stringify([email, browser, code]))
    .digest('hex')
}

export async function sendCode(body: Record<string, unknown>) {
  const cfg = config()
  const email = employeeLoginEmail(body.email)
  let smtp
  try {
    smtp = smtpSettings()
  } catch (error) {
    console.error('Portal SMTP configuration error:', smtpFailure(error))
  }
  if (!smtp) throw new HttpError(503, '邮箱服务未配置，请使用 GitHub 登录。')
  const db = store()
  const time = now()
  const browser = opaque()
  const code = String(randomInt(1_000_000)).padStart(6, '0')
  transaction(db, () => {
    const limit = db.prepare('SELECT created FROM email_codes WHERE email=?').get(email)
    if (limit && Number(limit.created) > time - 60)
      throw new HttpError(429, '请等待 60 秒后再获取验证码。')
    const bucket = Math.floor(time / 60)
    db.prepare('DELETE FROM login_limits WHERE bucket < ?').run(bucket)
    db.prepare('DELETE FROM email_codes WHERE expires <= ?').run(time)
    const result = db
      .prepare(`INSERT INTO login_limits VALUES (?, 1)
      ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count`)
      .get(bucket)
    if (Number(result?.count) > 30) throw new HttpError(429, '请求过多，请稍后再试。')
    db.prepare(`INSERT OR REPLACE INTO email_codes(email, hash, browser_hash, expires, created)
      VALUES (?, ?, ?, ?, ?)`).run(
      email,
      codeHash(cfg.secret, email, browser, code),
      hash(browser),
      time + codeAge,
      time,
    )
  })
  try {
    const transport = nodemailer.createTransport(smtp.options)
    await transport.sendMail({
      from: smtp.from,
      to: email,
      subject: '紫霄实验室登录验证码',
      text: `你的登录验证码为 ${code}，10 分钟内有效。如果这不是你的操作，可以忽略此邮件。`,
    })
  } catch (error) {
    console.error('Portal SMTP send failed:', smtpFailure(error))
    db.prepare('DELETE FROM email_codes WHERE email=? AND browser_hash=?').run(email, hash(browser))
    throw new HttpError(503, '暂时无法发送邮件，请稍后再试。')
  }
  return json({ ok: true }, 200, [
    setCookie(cfg.origin, cookieName(cfg.origin, 'email'), browser, codeAge),
  ])
}

export function checkCode(request: Request, body: Record<string, unknown>) {
  const cfg = config()
  const email = employeeLoginEmail(body.email)
  const name = cookieName(cfg.origin, 'email')
  const browser = cookie(request, name)
  const code = body.code
  if (!browser || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new HttpError(400, '请在获取验证码的浏览器输入 6 位验证码。')
  }
  const db = store()
  const verified = transaction(db, () => {
    const attempt = db
      .prepare(`UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND browser_hash=?
      AND expires>? AND attempts<5 RETURNING hash`)
      .get(email, hash(browser), now())
    if (
      !attempt ||
      !timingSafeEqual(
        Buffer.from(String(attempt.hash)),
        Buffer.from(codeHash(cfg.secret, email, browser, code)),
      )
    ) {
      return false
    }
    db.prepare('DELETE FROM email_codes WHERE email=?').run(email)
    return true
  })
  if (!verified) throw new HttpError(400, '验证码错误、已过期或尝试次数已用完。')
  return json({ ok: true }, 200, [
    newSession(request, verifiedUser(email)),
    setCookie(cfg.origin, name, '', 0),
  ])
}

const callbackPath = '/api/auth/github/callback'
export function startGithub() {
  const cfg = config()
  if (!cfg.clientId || !cfg.clientSecret)
    return Response.redirect(`${cfg.origin}/login?error=setup`, 303)
  const state = opaque()
  const verifier = opaque()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.origin + callbackPath,
    scope: 'user:email',
    state,
    code_challenge: hash(verifier),
    code_challenge_method: 'S256',
  }).toString()
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.href,
      'Cache-Control': 'no-store',
      'Set-Cookie': setCookie(
        cfg.origin,
        cookieName(cfg.origin, 'oauth'),
        `${state}.${verifier}`,
        codeAge,
      ),
    },
  })
}

export async function finishGithub(request: Request) {
  const cfg = config()
  const name = cookieName(cfg.origin, 'oauth')
  const clear = setCookie(cfg.origin, name, '', 0)
  const url = new URL(request.url)
  const [state, verifier] = (cookie(request, name) || '').split('.')
  const code = url.searchParams.get('code')
  const redirect = (path: string, session?: string) => {
    const headers = new Headers({ Location: cfg.origin + path, 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', clear)
    if (session) headers.append('Set-Cookie', session)
    return new Response(null, { status: 303, headers })
  }
  if (
    !code ||
    !state ||
    !verifier ||
    state !== url.searchParams.get('state') ||
    !cfg.clientId ||
    !cfg.clientSecret
  ) {
    return redirect('/login?error=github')
  }
  try {
    const accessResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: cfg.origin + callbackPath,
      }),
    })
    const access = (await accessResponse.json()) as { access_token?: string }
    if (!accessResponse.ok || !access.access_token) throw new Error()
    const get = async (path: string): Promise<unknown> => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${access.access_token}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error()
      return response.json()
    }
    const [profile, emails] = (await Promise.all([
      get('/user'),
      get('/user/emails?per_page=100'),
    ])) as [{ id?: number }, { email: string; verified: boolean; primary: boolean }[]]
    if (!Number.isSafeInteger(profile.id) || !Array.isArray(emails)) throw new Error()
    const verified = emails.filter((item) => item.verified)
    const selected = verified.find((item) => item.primary)
    if (!selected) return redirect('/login?error=email')
    const user = verifiedUser(normalizeEmail(selected.email), String(profile.id))
    return redirect('/account', newSession(request, user))
  } catch (error) {
    return redirect(
      error instanceof HttpError && error.status === 409
        ? '/login?error=account'
        : '/login?error=github',
    )
  }
}

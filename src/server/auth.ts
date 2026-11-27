import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import nodemailer from 'nodemailer'
import { employeeDomain } from '../deployment.mjs'
import { config } from './config'
import { cookie, cookieName, hash, HttpError, json, opaque, setCookie } from './http'
import { activeSession, newSession, session } from './session'
import { smtpFailure, smtpSettings } from './smtp.mjs'
import { store, transaction, type User } from './store'

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

export function verifiedEmailUser(email: string, db = store()) {
  return transaction(db, () => {
    db.prepare(`INSERT INTO users(email, employee) VALUES (?, ?)
      ON CONFLICT(email) DO NOTHING`).run(email, Number(isEmployeeEmail(email)))
    return db.prepare('SELECT * FROM users WHERE email=?').get(email) as User
  })
}

function userByGithubId(githubId: string, db = store()) {
  return db.prepare('SELECT * FROM users WHERE github_id=?').get(githubId) as User | undefined
}

export function registerGithubUser(email: string, githubId: string, db = store()) {
  return transaction(db, () => {
    const linked = userByGithubId(githubId, db)
    if (linked) {
      if (linked.email !== email) throw new HttpError(409, 'GitHub 主邮箱与原门户账户不匹配。')
      return linked
    }
    const created = db
      .prepare(`INSERT INTO users(email, employee, github_id) VALUES (?, ?, ?)
        ON CONFLICT(email) DO NOTHING RETURNING *`)
      .get(email, Number(isEmployeeEmail(email)), githubId) as User | undefined
    if (!created) throw new HttpError(409, '此邮箱已有账户，请登录原账户后绑定 GitHub。')
    return created
  })
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

export async function checkCode(request: Request, body: Record<string, unknown>) {
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
    await newSession(request, verifiedEmailUser(email), 'email'),
    setCookie(cfg.origin, name, '', 0),
  ])
}

const callbackPath = '/api/auth/github/callback'
const proofFormat = /^[A-Za-z0-9_-]{43}$/

export async function startGithub(request: Request, link = false) {
  const cfg = config()
  const current = link ? await session(request) : undefined
  if (link) {
    if (!current) throw new HttpError(401, '请先登录。')
    if (!current.user.employee || !isEmployeeEmail(current.user.email))
      throw new HttpError(403, '仅员工可绑定 GitHub。')
    if (current.user.github_id) throw new HttpError(409, '当前账户已绑定 GitHub。')
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    if (link) throw new HttpError(503, 'GitHub 授权暂未配置。')
    return Response.redirect(`${cfg.origin}/login?error=setup`, 303)
  }

  const state = opaque()
  const verifier = opaque()
  const challenge = hash(verifier)
  const time = now()
  const db = store()
  db.prepare('DELETE FROM github_flows WHERE expires<=?').run(time)
  db.prepare('INSERT INTO github_flows VALUES (?, ?, ?, ?)').run(
    hash(state),
    challenge,
    time + codeAge,
    current?.tokenHash ?? null,
  )

  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.origin + callbackPath,
    scope: 'user:email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(link ? { prompt: 'select_account' } : {}),
  }).toString()
  const proof = setCookie(cfg.origin, cookieName(cfg.origin, 'oauth'), verifier, codeAge)
  if (link) return json({ url: url.href }, 200, [proof])
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.href,
      'Cache-Control': 'no-store',
      'Set-Cookie': proof,
    },
  })
}

function linkGithub(tokenHash: string, userId: string, githubId: string) {
  const db = store()
  transaction(db, () => {
    const user = activeSession(tokenHash, userId)
    if (!user?.employee || !isEmployeeEmail(user.email))
      throw new HttpError(403, '员工会话已失效。')
    if (user.github_id || userByGithubId(githubId, db))
      throw new HttpError(409, '该 GitHub 账户已关联门户账户。')
    db.prepare('UPDATE users SET github_id=? WHERE id=?').run(githubId, user.id)
    db.prepare('INSERT INTO employee_github_links VALUES (?)').run(githubId)
  })
}

export async function finishGithub(request: Request) {
  const cfg = config()
  const name = cookieName(cfg.origin, 'oauth')
  const clear = setCookie(cfg.origin, name, '', 0)
  const url = new URL(request.url)
  const verifier = cookie(request, name) || ''
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code')
  const redirect = (path: string, issued?: string) => {
    const headers = new Headers({ Location: cfg.origin + path, 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', clear)
    if (issued) headers.append('Set-Cookie', issued)
    return new Response(null, { status: 303, headers })
  }
  if (!proofFormat.test(state) || !proofFormat.test(verifier))
    return redirect('/login?error=github')
  const flow = store()
    .prepare(`DELETE FROM github_flows WHERE state_hash=? AND verifier_hash=? AND expires>?
      RETURNING session_hash`)
    .get(hash(state), hash(verifier), now()) as { session_hash: string | null } | undefined
  if (!flow) return redirect('/login?error=github')

  const linking = flow.session_hash !== null
  const failed = () => redirect(linking ? '/account?github=error' : '/login?error=github')
  if (!code || !cfg.clientId || !cfg.clientSecret) return failed()
  try {
    const current = linking ? await session(request) : undefined
    if (linking && (!current || current.tokenHash !== flow.session_hash)) return failed()
    const accessResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      redirect: 'error',
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
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error()
      return response.json()
    }
    const profile = (await get('/user')) as { id: number }
    if (!Number.isSafeInteger(profile.id) || profile.id <= 0) throw new Error()
    const githubId = String(profile.id)
    if (current) {
      linkGithub(current.tokenHash, String(current.user.id), githubId)
      return redirect('/account?github=linked')
    }
    // An explicit employee binding already proved ownership of both accounts.
    // Legacy OAuth-only accounts still require their original verified primary email.
    let user = store()
      .prepare(`SELECT users.* FROM employee_github_links
        JOIN users USING (github_id) WHERE github_id=?`)
      .get(githubId) as User | undefined
    if (!user) {
      const emails = (await get('/user/emails?per_page=100')) as {
        email: string
        verified: boolean
        primary: boolean
      }[]
      const selected = emails.find((item) => item.primary === true && item.verified === true)
      if (!selected) return redirect('/login?error=email')
      user = registerGithubUser(normalizeEmail(selected.email), githubId)
    }
    return redirect('/account', await newSession(request, user, 'github'))
  } catch (error) {
    if (error instanceof HttpError && error.status === 409)
      return redirect(linking ? '/account?github=conflict' : '/login?error=account')
    if (!linking && error instanceof HttpError && error.status === 403)
      return redirect('/login?error=suspended')
    return failed()
  }
}

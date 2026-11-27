import { createHmac } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'
import { config } from './config'
import { cookie, cookieName, hash, HttpError, opaque, setCookie } from './http'
import { store, transaction, type User } from './store'

const age = 7 * 86400
const algorithm = 'HS256'
const type = 'portal-session+jwt'
const audience = 'portal-web'
const now = () => Math.floor(Date.now() / 1000)
const signingKey = (secret: string) => createHmac('sha256', secret).update(type).digest()

function sessionCookie(request: Request, origin: string) {
  return cookie(request, cookieName(origin, 'session'))
}

export function activeSession(tokenHash: string, userId: string) {
  return store()
    .prepare(`SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id
      WHERE sessions.hash=? AND sessions.expires>? AND users.id=?
        AND NOT EXISTS (SELECT 1 FROM suspended_users WHERE user_id=users.id)`)
    .get(tokenHash, now(), userId) as User | undefined
}

export async function session(request: Request) {
  const { origin, secret } = config()
  const token = sessionCookie(request, origin)
  if (!token || token.length > 1024) return
  let subject
  let byEmail
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: [algorithm],
      issuer: origin,
      audience,
      typ: type,
      maxTokenAge: age,
      requiredClaims: ['sub', 'exp', 'jti'],
    })
    subject = payload.sub
    byEmail = payload.auth_method === 'email'
  } catch {
    return
  }
  if (!subject || !/^[1-9]\d*$/.test(subject)) return
  const tokenHash = hash(token)
  const user = activeSession(tokenHash, subject)
  if (user) return { tokenHash, user, byEmail }
}

export function removeSession(request: Request) {
  const { origin } = config()
  const token = sessionCookie(request, origin)
  if (token) store().prepare('DELETE FROM sessions WHERE hash=?').run(hash(token))
  return setCookie(origin, cookieName(origin, 'session'), '', 0)
}

export async function newSession(request: Request, user: User, method: 'email' | 'github') {
  const { origin, secret } = config()
  const time = now()
  const expires = time + age
  const token = await new SignJWT({ auth_method: method })
    .setProtectedHeader({ alg: algorithm, typ: type })
    .setIssuer(origin)
    .setAudience(audience)
    .setSubject(String(user.id))
    .setJti(opaque())
    .setIssuedAt(time)
    .setExpirationTime(expires)
    .sign(signingKey(secret))

  const db = store()
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM suspended_users WHERE user_id=?').get(user.id))
      throw new HttpError(403, '此账户已停用，请联系管理员。')
    const previous = sessionCookie(request, origin)
    if (previous) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(previous))
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(time)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), user.id, expires)
  })
  return setCookie(origin, cookieName(origin, 'session'), token, age)
}

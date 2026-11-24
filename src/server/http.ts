import { createHash, randomBytes } from 'node:crypto'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function opaque() {
  return randomBytes(32).toString('base64url')
}

export function hash(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

export function cookie(request: Request, name: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export function setCookie(origin: string, name: string, value: string, age: number) {
  return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`
}

export function cookieName(origin: string, name: string) {
  return `${origin.startsWith('https:') ? '__Host-' : ''}portal_${name}`
}

export function checkOrigin(request: Request, origin: string) {
  if (request.headers.get('origin') !== origin) throw new HttpError(403, '请求来源不受信任。')
}

export async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new HttpError(415, '请求必须使用 JSON。')
  }
  if (!request.body || Number(request.headers.get('content-length')) > max) {
    throw new HttpError(413, '请求内容超出限制。')
  }
  const reader = request.body.getReader()
  let size = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const pieces: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        void reader.cancel().catch(() => {})
        throw new HttpError(413, '请求内容超出限制。')
      }
      pieces.push(decoder.decode(value, { stream: true }))
    }
    const result: unknown = JSON.parse(pieces.join('') + decoder.decode())
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    void reader.cancel().catch(() => {})
  } finally {
    reader.releaseLock()
  }
  throw new HttpError(400, '请求内容不是有效的 JSON 对象。')
}

export function json(data: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
  for (const value of cookies) headers.append('Set-Cookie', value)
  return Response.json(data, { status, headers })
}

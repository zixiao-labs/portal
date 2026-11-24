export async function requestJson<T>(
  path: string,
  method = 'GET',
  data?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    ...(data
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
      : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new RequestError(response.status, result.error || '请求失败，请重试。')
  return result as T
}

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function userMessage(error: unknown) {
  return error instanceof RequestError ? error.message : '连接失败，请重试。'
}

import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { adminAccess } from './server/admin'
import { session } from './server/session'

export const getLoginSessionState = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'private, no-store')
  const current = await session(getRequest())
  if (!current) return 'signed-out'
  return adminAccess(current) === 'email-required' ? 'email-required' : 'signed-in'
})

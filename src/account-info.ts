export type AccountInfo = {
  email: string
  employee: boolean
  github: boolean
  // Only allowlisted employees have an admin access state.
  adminAccess?: 'granted' | 'email-required'
  // Keep this grant for older clients that are still open during deployment.
  admin?: true
}

export const oauthScopes = ['docs:read', 'oauth:apps', 'docs:repositories'] as const
export type OAuthScope = (typeof oauthScopes)[number]
export const oauthScopeLabels: Record<OAuthScope, string> = {
  'docs:read': '搜索和读取公开文档',
  'oauth:apps': '管理自己的 OAuth 应用',
  'docs:repositories': '管理仓库文档发布权限',
}

export const oauthAppsPath = '/api/account/oauth-apps'

export type OAuthApp = {
  clientId: string
  name: string
  redirectUris: string[]
  scope: OAuthScope
  activeTokens: number
}

export type OAuthApps = { apps: OAuthApp[]; allowedScopes: OAuthScope[] }

export type OAuthConsent = {
  appName: string
  scope: OAuthScope
  redirectUri: string
} & ({ stage: 'approve'; id: string } | { stage: 'work-email' | 'sign-in' })

import { ArrowRight, LogoGithub } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { Button, TextField } from '@zixiao-labs/ui-kits-react'
import { useEffect, useState, type FormEvent } from 'react'
import logo from '../../assets/zixiao-logo-2.svg?url'
import { oauthScopeLabels, type OAuthConsent } from '../oauth-app-info'
import { requestJson, userMessage } from './request'

const oauthErrors = {
  setup: 'GitHub 登录暂未配置。',
  github: 'GitHub 登录未完成，请重试。',
  email: '请先在 GitHub 验证主邮箱，再回来登录。',
  account: 'GitHub 主邮箱与门户账户有冲突。请用原方式登录，或联系管理员。',
  suspended: '此账户已停用，请联系管理员。',
}

const mcpConsentPath = '/api/mcp/oauth/consent'

export function LoginPage({ oauthError, mcp }: { oauthError?: string; mcp?: boolean }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [consent, setConsent] = useState<OAuthConsent>()
  const [consentError, setConsentError] = useState('')
  useEffect(() => {
    if (!mcp) return
    const controller = new AbortController()
    void requestJson<OAuthConsent>(mcpConsentPath, 'GET', undefined, controller.signal)
      .then(setConsent)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setConsentError(userMessage(err))
      })
    return () => controller.abort()
  }, [mcp])

  const githubError =
    oauthError && Object.hasOwn(oauthErrors, oauthError)
      ? oauthErrors[oauthError as keyof typeof oauthErrors]
      : ''

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (sent) {
        await requestJson('/api/auth/email/verify', 'POST', { email, code })
        window.location.assign(mcp ? '/login?mcp=true' : '/account')
      } else {
        await requestJson('/api/auth/email/send', 'POST', { email })
        setSent(true)
      }
    } catch (err) {
      setError(userMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-stage" id="main">
      <div className="login-frame">
        <div className="login-identity" aria-hidden="true">
          <img src={logo} alt="" width="128" height="128" />
          <p>紫霄实验室</p>
          <span lang="en">Zixiao Laboratories</span>
        </div>
        <section className="login-surface" aria-labelledby="login-title">
          <div className="login-content">
            <h1 id="login-title">{mcp ? '授权 OAuth 应用' : '登录门户'}</h1>
            {mcp ? (
              <>
                {consentError ? (
                  <p className="error" role="alert">
                    {consentError}
                  </p>
                ) : !consent ? (
                  <p className="muted" role="status">
                    正在检查授权请求…
                  </p>
                ) : (
                  <>
                    <dl className="oauth-consent-details">
                      <div>
                        <dt>应用</dt>
                        <dd>
                          <bdi>{consent.appName}</bdi>
                        </dd>
                      </div>
                      <div>
                        <dt>请求权限</dt>
                        <dd>{oauthScopeLabels[consent.scope]}</dd>
                      </div>
                      <div>
                        <dt>回调地址</dt>
                        <dd>
                          <bdi className="oauth-code">{consent.redirectUri}</bdi>
                        </dd>
                      </div>
                    </dl>
                    {consent.stage === 'approve' ? (
                      <form method="post" action={mcpConsentPath} className="form-stack">
                        <input type="hidden" name="id" value={consent.id} />
                        <p className="muted oauth-consent-hint">
                          核对回调地址，只批准你刚刚发起的连接。
                        </p>
                        <Button type="submit" name="decision" value="approve" variant="solid">
                          {consent.scope === 'docs:read'
                            ? '允许读取文档'
                            : consent.scope === 'oauth:apps'
                              ? '允许管理应用'
                              : '允许管理发布权限'}
                        </Button>
                        <Button type="submit" name="decision" value="deny" variant="ghost">
                          拒绝
                        </Button>
                      </form>
                    ) : consent.stage === 'sign-in' ? (
                      <a className="github-button" href="/api/auth/github?mcp=true">
                        <LogoGithub aria-hidden width={18} height={18} /> 使用 GitHub 登录
                      </a>
                    ) : null}
                  </>
                )}
                {githubError && (
                  <p className="error github-error" role="alert">
                    {githubError}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="login-lede" id="github-description">
                  首次使用 GitHub 登录会创建账户
                </p>
                <a
                  className="github-button"
                  href="/api/auth/github"
                  aria-describedby="github-description"
                >
                  <LogoGithub aria-hidden width={18} height={18} /> 使用 GitHub 登录
                </a>
                {githubError && (
                  <p className="error github-error" role="alert">
                    {githubError}
                  </p>
                )}
              </>
            )}
            {(!mcp || (consent && consent.stage !== 'approve')) && (
              <form
                id="work-email"
                onSubmit={submit}
                className="form-stack login-form"
                aria-labelledby="work-email-title"
              >
                <h2 id="work-email-title">员工邮箱登录</h2>
                {sent ? (
                  <>
                    <p className="code-sent" role="status">
                      验证码已发送到 <b>{email}</b>，10 分钟内有效。
                    </p>
                    <TextField
                      label="验证码"
                      value={code}
                      onChange={setCode}
                      isRequired
                      autoFocus
                      placeholder="输入 6 位数字"
                      autoComplete="one-time-code"
                      inputProps={{ inputMode: 'numeric', pattern: '[0-9]{6}', maxLength: 6 }}
                    />
                  </>
                ) : (
                  <TextField
                    label="工作邮箱"
                    name="email"
                    type="email"
                    autoComplete="email"
                    isRequired
                    value={email}
                    onChange={setEmail}
                    description="仅限 @zixiaolabs.com 邮箱"
                  />
                )}
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                <Button type="submit" variant={sent ? 'solid' : 'outline'} disabled={busy}>
                  {sent ? (busy ? '正在验证…' : '验证并登录') : busy ? '正在发送…' : '发送验证码'}
                </Button>
                {sent && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSent(false)
                      setCode('')
                      setError('')
                    }}
                  >
                    返回邮箱输入
                  </Button>
                )}
              </form>
            )}
            <Link to="/docs" className="quiet-link login-docs">
              浏览公开文档 <ArrowRight aria-hidden width={16} height={16} />
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}

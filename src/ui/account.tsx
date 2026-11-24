import { ArrowRight, Key, Person } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { Button, TextField } from '@zixiao-labs/ui-kits-react'
import { useEffect, useState, type FormEvent } from 'react'
import { requestJson, RequestError, userMessage } from './request'

type Token = { id: string; repository: string; created: number; expires: number }
type Account = { email: string; employee: boolean; github: boolean; tokens: Token[] }
const date = (value: number) => new Date(value * 1000).toISOString().slice(0, 10)

export function AccountPage() {
  const [account, setAccount] = useState<Account>()
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [repository, setRepository] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async (signal?: AbortSignal) =>
    setAccount(await requestJson<Account>('/api/account', 'GET', undefined, signal))
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted) return
      if (err instanceof RequestError && err.status === 401) window.location.replace('/login')
      else setError(userMessage(err))
    })
    return () => controller.abort()
  }, [])

  async function act(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await action()
    } catch (err) {
      setError(userMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void act(async () => {
      const result = await requestJson<{ token: string }>('/api/tokens', 'POST', { repository })
      setSecret(result.token)
      setRepository('')
      await refresh()
    })
  }

  return (
    <main className="workspace" id="main">
      <header className="workspace-head">
        <div>
          <p className="eyebrow">
            <span className="index-mark" /> 账户 / ACCOUNT
          </p>
          <h1>个人中心</h1>
        </div>
        {account && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await requestJson('/api/auth/logout', 'POST')
                window.location.assign('/login')
              })
            }
          >
            退出登录
          </Button>
        )}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {!account && !error && <p role="status">正在读取账户…</p>}
      {account && (
        <div className="account-layout">
          <section className="sheet">
            <h2>
              <Person aria-hidden /> 账户信息
            </h2>
            <dl className="account-details">
              <div>
                <dt>已验证邮箱</dt>
                <dd>{account.email}</dd>
              </div>
              <div>
                <dt>账户类型</dt>
                <dd>{account.employee ? '员工' : '访客'}</dd>
              </div>
              <div>
                <dt>GitHub</dt>
                <dd>{account.github ? '已关联' : '未关联'}</dd>
              </div>
            </dl>
            <Link to="/docs" className="quiet-link">
              浏览文档库 <ArrowRight aria-hidden width={16} height={16} />
            </Link>
          </section>
          {account.employee && (
            <section className="sheet">
              <h2>
                <Key aria-hidden /> 文档发布 Token
              </h2>
              <p className="muted">
                每个 Token 只用于一个组织仓库，90 天后失效。请将它存入对应仓库的 GitHub Actions
                环境机密。
              </p>
              <form className="form-stack" onSubmit={issue}>
                <TextField
                  name="repository"
                  label="GitHub 仓库"
                  placeholder="zixiao-labs/project"
                  isRequired
                  value={repository}
                  onChange={setRepository}
                />
                <Button type="submit" variant="solid" disabled={busy}>
                  创建发布 Token
                </Button>
              </form>
              {secret && (
                <div className="issued-secret" aria-live="polite">
                  <p>Token 只显示一次。离开前请复制。</p>
                  <code>{secret}</code>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void act(async () => {
                        await navigator.clipboard.writeText(secret)
                        setStatus('Token 已复制。')
                      })
                    }
                  >
                    复制 Token
                  </Button>
                  <Button variant="ghost" onClick={() => setSecret('')}>
                    隐藏
                  </Button>
                </div>
              )}
              <ul className="token-list" aria-label="有效 Token">
                {account.tokens.map((token) => (
                  <li key={token.id}>
                    <span>
                      <b>{token.repository}</b>
                      <small>{date(token.expires)} 到期（UTC）</small>
                    </span>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`撤销 ${token.repository} 的此 Token？`))
                          void act(async () => {
                            await requestJson(`/api/tokens/${token.id}`, 'DELETE')
                            setSecret('')
                            await refresh()
                            setStatus('Token 已撤销。')
                          })
                      }}
                    >
                      撤销
                    </Button>
                  </li>
                ))}
              </ul>
              {!account.tokens.length && <p className="muted">还没有有效的发布 Token。</p>}
            </section>
          )}
        </div>
      )}
    </main>
  )
}

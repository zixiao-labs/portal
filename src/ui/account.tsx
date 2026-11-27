import { ArrowRight, LogoGithub } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { Button } from '@zixiao-labs/ui-kits-react'
import { useEffect, useState } from 'react'
import type { AccountInfo } from '../account-info'
import { AdminVerification } from './admin-verification'
import { requestJson, RequestError, userMessage } from './request'

export function AccountPage({ githubResult }: { githubResult?: 'linked' | 'conflict' | 'error' }) {
  const [account, setAccount] = useState<AccountInfo>()
  const [error, setError] = useState('')
  const [showResult, setShowResult] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void requestJson<AccountInfo>('/api/account', 'GET', undefined, controller.signal)
      .then(setAccount)
      .catch((err: unknown) => {
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
    setShowResult(false)
    try {
      await action()
    } catch (err) {
      if (err instanceof RequestError && err.status === 401) window.location.replace('/login')
      else setError(userMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const message =
    error ||
    (account && showResult && githubResult === 'conflict'
      ? '该 GitHub 账户已关联门户账户，无法重复绑定。'
      : account && showResult && githubResult === 'error'
        ? 'GitHub 绑定未完成，请重试。'
        : '')

  return (
    <main className="workspace" id="main">
      <header className="workspace-head">
        <h1>个人中心</h1>
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
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
      {account?.github && showResult && githubResult === 'linked' && (
        <p role="status">GitHub 已绑定，现在可以用该账户登录门户。</p>
      )}
      {!account && !error && <p role="status">正在读取账户…</p>}
      {account && (
        <section className="sheet account-sheet">
          <h2>账户信息</h2>
          <dl className="account-details">
            <div>
              <dt>已验证邮箱</dt>
              <dd>{account.email}</dd>
            </div>
            <div>
              <dt>账户类型</dt>
              <dd>{account.adminAccess ? '管理员' : account.employee ? '员工' : '访客'}</dd>
            </div>
            <div>
              <dt>GitHub</dt>
              <dd>{account.github ? '已关联' : '未关联'}</dd>
            </div>
          </dl>
          {account.employee && !account.github && (
            <div className="account-link">
              <p className="muted">绑定后可用 GitHub 登录，门户的工作邮箱不会改变。</p>
              <Button
                variant="solid"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await requestJson<{ url: string }>(
                      '/api/auth/github/link',
                      'POST',
                    )
                    window.location.assign(result.url)
                  })
                }
              >
                <LogoGithub aria-hidden width={18} height={18} /> 绑定 GitHub
              </Button>
            </div>
          )}
          {account.adminAccess === 'email-required' && <AdminVerification />}
          <div className="account-links">
            {account.adminAccess === 'granted' && (
              <Link to="/admin" className="quiet-link">
                管理后台 <ArrowRight aria-hidden width={16} height={16} />
              </Link>
            )}
            <Link to="/docs" className="quiet-link">
              浏览文档库 <ArrowRight aria-hidden width={16} height={16} />
            </Link>
          </div>
        </section>
      )}
    </main>
  )
}

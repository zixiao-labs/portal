import { ArrowLeft } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { Button, TextField } from '@zixiao-labs/ui-kits-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import {
  oauthAppsPath,
  oauthScopeLabels,
  type OAuthApp,
  type OAuthApps,
  type OAuthScope,
} from '../oauth-app-info'
import { requestJson, RequestError, userMessage } from './request'

export function OAuthAppsPage() {
  const [data, setData] = useState<OAuthApps>()
  const [reload, setReload] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [scope, setScope] = useState<OAuthScope>('docs:read')
  const [confirmation, setConfirmation] = useState<{ app: OAuthApp; remove: boolean }>()
  const registerButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void requestJson<OAuthApps>(oauthAppsPath, 'GET', undefined, controller.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof RequestError && err.status === 401) window.location.replace('/login')
        else setLoadError(userMessage(err))
      })
    return () => controller.abort()
  }, [reload])

  useLayoutEffect(() => {
    if (confirmation) dialog.current?.showModal()
  }, [confirmation])

  async function act(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await operation()
    } catch (err) {
      if (err instanceof RequestError && err.status === 401) window.location.replace('/login')
      else setError(userMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await act(async () => {
      const app = await requestJson<OAuthApp>(oauthAppsPath, 'POST', {
        name,
        redirectUris: [redirectUri.trim()],
        scope,
      })
      setData((current) => current && { ...current, apps: [app, ...current.apps] })
      setName('')
      setRedirectUri('')
      setScope('docs:read')
      setShowForm(false)
      registerButton.current?.focus()
      setStatus(`已注册 ${app.name}。请将 Client ID 填入客户端，再发起授权。`)
    })
  }

  async function revoke(app: OAuthApp, remove: boolean) {
    return act(async () => {
      const path = `${oauthAppsPath}/${app.clientId}`
      await requestJson(remove ? path : `${path}/tokens`, 'DELETE')
      setData(
        (current) =>
          current && {
            ...current,
            apps: remove
              ? current.apps.filter(({ clientId }) => clientId !== app.clientId)
              : current.apps.map((item) =>
                  item.clientId === app.clientId ? { ...item, activeTokens: 0 } : item,
                ),
          },
      )
      if (remove) registerButton.current?.focus()
      setStatus(remove ? `已取消 ${app.name} 的注册。` : `已清除 ${app.name} 的授权 Token。`)
    })
  }

  return (
    <main className="workspace oauth-workspace" id="main">
      <Link className="quiet-link oauth-back" to="/account">
        <ArrowLeft width={16} height={16} aria-hidden /> 个人中心
      </Link>
      <header className="workspace-head">
        <h1>OAuth 应用</h1>
        {data && (
          <Button
            ref={registerButton}
            variant={showForm ? 'outline' : 'solid'}
            aria-disabled={busy}
            aria-expanded={showForm}
            onClick={() => {
              if (!busy) setShowForm(!showForm)
            }}
          >
            {showForm ? '关闭注册表单' : '注册应用'}
          </Button>
        )}
      </header>
      {loadError ? (
        <>
          <p className="error" role="alert">
            {loadError}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setLoadError('')
              setReload(reload + 1)
            }}
          >
            重新读取
          </Button>
        </>
      ) : !data ? (
        <p role="status">正在读取应用…</p>
      ) : (
        <>
          {showForm && (
            <form
              className="sheet form-stack oauth-form"
              onSubmit={register}
              aria-label="注册 OAuth 应用"
            >
              <TextField
                label="应用名称"
                isRequired
                value={name}
                onChange={setName}
                inputProps={{ maxLength: 80 }}
              />
              <TextField
                label="回调地址"
                type="url"
                isRequired
                value={redirectUri}
                onChange={setRedirectUri}
                description="填写客户端提供的完整 HTTPS 或本地回环地址"
                inputProps={{ maxLength: 512, autoCapitalize: 'none', spellCheck: false }}
              />
              <label className="oauth-scope">
                权限
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as OAuthScope)}
                >
                  {data.allowedScopes.map((id) => (
                    <option key={id} value={id}>
                      {oauthScopeLabels[id]}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="solid" disabled={busy}>
                {busy ? '正在注册…' : '确认注册'}
              </Button>
            </form>
          )}
          {error && (
            <p className="error oauth-feedback" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className="oauth-feedback" role="status">
              {status}
            </p>
          )}
          {data.apps.length === 0 ? (
            !showForm && (
              <section className="sheet" aria-labelledby="oauth-empty">
                <h2 id="oauth-empty">还没有注册应用</h2>
                <p className="muted oauth-feedback">
                  注册后，用 Client ID 连接 MCP 或其他支持 OAuth 的客户端。
                </p>
              </section>
            )
          ) : (
            <ul className="sheet oauth-list" aria-label="我的 OAuth 应用">
              {data.apps.map((app) => (
                <li key={app.clientId} className="oauth-row">
                  <div className="oauth-row-head">
                    <h2>
                      <bdi>{app.name}</bdi>
                    </h2>
                    <span className="muted oauth-count">{app.activeTokens} 个有效 Token</span>
                  </div>
                  <dl>
                    <div>
                      <dt>权限</dt>
                      <dd>{oauthScopeLabels[app.scope]}</dd>
                    </div>
                    <div>
                      <dt>Client ID</dt>
                      <dd>
                        <code className="oauth-code">{app.clientId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{app.redirectUris.length > 1 ? '回调地址列表' : '回调地址'}</dt>
                      {app.redirectUris.map((uri) => (
                        <dd key={uri}>
                          <bdi className="oauth-code">{uri}</bdi>
                        </dd>
                      ))}
                    </div>
                  </dl>
                  <div className="oauth-actions">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmation({ app, remove: false })}
                    >
                      清除 Token
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmation({ app, remove: true })}
                    >
                      取消注册
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <dialog
            ref={dialog}
            className="sheet oauth-dialog"
            aria-labelledby="oauth-dialog-title"
            aria-describedby="oauth-dialog-description"
            onClose={() => setConfirmation(undefined)}
          >
            {confirmation && (
              <>
                <h2 id="oauth-dialog-title">
                  {confirmation.remove ? '取消应用注册' : '清除授权 Token'}
                </h2>
                <p className="oauth-confirm-copy" id="oauth-dialog-description">
                  <bdi>{confirmation.app.name}</bdi> 的现有 Token 和已批准的授权码将立即失效。
                  {confirmation.remove
                    ? '此 Client ID 也将失效。'
                    : 'Client ID 保持不变，可以再次授权。'}
                </p>
                <form method="dialog" className="oauth-actions">
                  <Button variant="outline" type="submit" autoFocus>
                    返回
                  </Button>
                  <Button
                    variant="solid"
                    onClick={() => {
                      dialog.current?.close()
                      void revoke(confirmation.app, confirmation.remove)
                    }}
                  >
                    {confirmation.remove ? '确认取消注册' : '确认清除'}
                  </Button>
                </form>
              </>
            )}
          </dialog>
          <Link
            to="/docs/$collection/$"
            params={{ collection: 'portal', _splat: 'mcp' }}
            className="quiet-link oauth-guide"
          >
            查看 OAuth 和 MCP 接入指南
          </Link>
        </>
      )}
    </main>
  )
}

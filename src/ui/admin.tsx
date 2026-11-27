import { Link } from '@tanstack/react-router'
import { Button, TextField } from '@zixiao-labs/ui-kits-react'
import { useEffect, useState, type FormEvent } from 'react'
import { requestJson, RequestError, userMessage } from './request'

type View = 'users' | 'repositories'
type User = {
  id: string
  email: string
  employee: boolean
  github: boolean
  suspended: boolean
  admin: boolean
}
type Repository = { id: string; repository: string }
type UserPage = { users: User[]; next: string | null }
const usersUrl = '/api/admin/users'
const reposUrl = '/api/admin/repositories'

function adminError(error: unknown) {
  if (error instanceof RequestError && error.status === 401) window.location.replace('/login')
  return userMessage(error)
}

function useAdminAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const act = async (operation: () => Promise<void>, success = '') => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      setNotice(success)
    } catch (err) {
      setError(adminError(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, notice, act }
}

function Feedback({ error, notice }: { error: string; notice?: string }) {
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </>
  )
}

export function AdminPage({ view }: { view: View }) {
  const [access, setAccess] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void requestJson<{ admin?: boolean }>('/api/account', 'GET', undefined, controller.signal)
      .then(({ admin }) => {
        setAccess(admin ? 'granted' : 'denied')
        if (!admin) setError('请使用有管理权限的工作邮箱验证码登录。')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setAccess('denied')
        setError(adminError(err))
      })
    return () => controller.abort()
  }, [])

  return (
    <main id="main" className="workspace">
      <header className="workspace-head">
        <div>
          <p className="eyebrow">
            <span className="index-mark" /> 管理 / ADMINISTRATION
          </p>
          <h1>管理后台</h1>
        </div>
        <Link to="/account" className="quiet-link">
          返回个人中心
        </Link>
      </header>
      {access === 'loading' && <p role="status">正在检查管理权限…</p>}
      <Feedback error={error} />
      {access === 'granted' && (
        <>
          <nav className="admin-nav" aria-label="后台模块">
            <Link
              to="/admin"
              search={{ view: 'users' }}
              data-selected={view === 'users'}
              activeOptions={{ exact: true }}
            >
              用户管理
            </Link>
            <Link
              to="/admin"
              search={{ view: 'repositories' }}
              data-selected={view === 'repositories'}
              activeOptions={{ exact: true }}
            >
              可发布仓库
            </Link>
          </nav>
          {view === 'repositories' ? <Repositories /> : <Users />}
        </>
      )}
    </main>
  )
}

function Users() {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<UserPage>()
  const [loadError, setLoadError] = useState('')
  const { act, busy, error, notice } = useAdminAction()
  useEffect(() => {
    const controller = new AbortController()
    void requestJson<UserPage>(usersUrl, 'GET', undefined, controller.signal)
      .then(setPage)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(adminError(err))
      })
    return () => controller.abort()
  }, [])

  const fetchPage = (term: string, after?: string) => {
    const params = new URLSearchParams({ q: term })
    if (after) params.set('after', after)
    return requestJson<UserPage>(`${usersUrl}?${params}`)
  }
  const [searched, setSearched] = useState('')
  function search(event: FormEvent) {
    event.preventDefault()
    void act(async () => {
      const result = await fetchPage(query)
      setSearched(query)
      setLoadError('')
      setPage(result)
    })
  }

  function update(user: User, action: 'suspend' | 'restore' | 'revoke-sessions') {
    const label = { suspend: '停用账号', restore: '恢复账号', 'revoke-sessions': '结束所有会话' }[
      action
    ]
    if (!window.confirm(`确定为 ${user.email} 执行「${label}」？`)) return
    void act(async () => {
      await requestJson(`${usersUrl}/${user.id}/${action}`, 'POST')
      if (action !== 'revoke-sessions') {
        setPage(
          (previous) =>
            previous && {
              ...previous,
              users: previous.users.map((entry) =>
                entry.id === user.id ? { ...entry, suspended: action === 'suspend' } : entry,
              ),
            },
        )
      }
    }, `${label}已完成。`)
  }

  return (
    <section className="sheet admin-panel" aria-labelledby="admin-users-title">
      <h2 id="admin-users-title">门户用户</h2>
      <form className="admin-form" onSubmit={search}>
        <TextField
          label="按邮箱搜索"
          name="email"
          value={query}
          onChange={setQuery}
          inputProps={{ maxLength: 254 }}
        />
        <Button type="submit" variant="outline" disabled={busy || (!page && !loadError)}>
          搜索
        </Button>
      </form>
      <Feedback error={error || loadError} notice={notice} />
      {!page && !loadError && <p role="status">正在读取用户…</p>}
      {page &&
        (page.users.length ? (
          <ul className="admin-list" aria-label="用户">
            {page.users.map((user) => (
              <li className="admin-row" key={user.id}>
                <div>
                  <strong>{user.email}</strong>
                  <small>
                    {user.admin ? '管理员' : user.employee ? '员工' : '访客'} · GitHub{' '}
                    {user.github ? '已关联' : '未关联'} · {user.suspended ? '已停用' : '正常'}
                  </small>
                </div>
                {!user.admin && (
                  <div className="admin-actions">
                    {!user.suspended && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => update(user, 'revoke-sessions')}
                      >
                        结束会话
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => update(user, user.suspended ? 'restore' : 'suspend')}
                    >
                      {user.suspended ? '恢复' : '停用'}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">没有符合条件的用户。</p>
        ))}
      {page?.next && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await fetchPage(searched, page.next!)
              setPage({ users: [...page.users, ...result.users], next: result.next })
            })
          }
        >
          加载更多
        </Button>
      )}
    </section>
  )
}

function Repositories() {
  const [repository, setRepository] = useState('')
  const [id, setId] = useState('')
  const [rows, setRows] = useState<Repository[]>()
  const [loadError, setLoadError] = useState('')
  const { act, busy, error, notice } = useAdminAction()
  const load = async (signal?: AbortSignal) => {
    const result = await requestJson<{ repositories: Repository[] }>(
      reposUrl,
      'GET',
      undefined,
      signal,
    )
    setRows(result.repositories)
    setLoadError('')
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((err: unknown) => {
      if (!controller.signal.aborted) setLoadError(adminError(err))
    })
    return () => controller.abort()
  }, [])

  function grant(event: FormEvent) {
    event.preventDefault()
    if (!window.confirm(`允许 ${repository.trim()} 将文档公开到门户？`)) return
    void act(async () => {
      await requestJson(reposUrl, 'POST', { repository, id })
      setRepository('')
      setId('')
      await load()
    }, '仓库已获发布授权。')
  }

  function revoke(repo: Repository) {
    if (!window.confirm(`撤销 ${repo.repository} 的发布授权？已发布文档不会下线。`)) return
    void act(async () => {
      await requestJson(`${reposUrl}/${repo.id}`, 'DELETE')
      await load()
    }, '发布授权已撤销。')
  }

  return (
    <section className="sheet admin-panel" aria-labelledby="admin-repos-title">
      <h2 id="admin-repos-title">文档发布授权</h2>
      <p className="muted">可同时授权多个组织仓库。即使源仓库是私有的，发布后的文档也对外公开。</p>
      <form className="admin-form" onSubmit={grant}>
        <TextField
          label="仓库全名"
          name="repository"
          isRequired
          placeholder="zixiao-labs/handbook"
          value={repository}
          onChange={setRepository}
          inputProps={{ maxLength: 112 }}
        />
        <TextField
          label="仓库数字 ID"
          name="id"
          isRequired
          value={id}
          onChange={setId}
          inputProps={{ inputMode: 'numeric', maxLength: 20, pattern: '[1-9][0-9]*' }}
        />
        <Button type="submit" variant="solid" disabled={busy || (!rows && !loadError)}>
          授权发布
        </Button>
      </form>
      <p className="muted admin-hint">
        查询 ID：<code>{'gh api repos/zixiao-labs/<repo> --jq .id'}</code>
      </p>
      <Feedback error={error || loadError} notice={notice} />
      {!rows && !loadError && <p role="status">正在读取授权…</p>}
      {loadError && (
        <Button variant="outline" disabled={busy} onClick={() => void act(() => load())}>
          重新读取
        </Button>
      )}
      {rows &&
        (rows.length ? (
          <ul className="admin-list" aria-label="已授权仓库">
            {rows.map((repo) => (
              <li className="admin-row" key={repo.id}>
                <div>
                  <strong>{repo.repository}</strong>
                  <small>ID {repo.id}</small>
                </div>
                <Button variant="outline" disabled={busy} onClick={() => revoke(repo)}>
                  撤销授权
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">尚无仓库获准发布。</p>
        ))}
    </section>
  )
}

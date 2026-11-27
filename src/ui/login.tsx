import { ArrowRight, Envelope, LogoGithub } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { Button, TextField } from '@zixiao-labs/ui-kits-react'
import { useState, type FormEvent } from 'react'
import { requestJson, userMessage } from './request'

const oauthErrors = {
  setup: 'GitHub 登录暂未配置。',
  github: 'GitHub 登录未完成，请重试。',
  email: '请先在 GitHub 验证主邮箱，再回来登录。',
  account: 'GitHub 主邮箱与门户账户有冲突。请用原方式登录，或联系管理员。',
  suspended: '此账户已停用，请联系管理员。',
}

export function LoginPage({ oauthError }: { oauthError?: string }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(
    oauthError && Object.hasOwn(oauthErrors, oauthError)
      ? oauthErrors[oauthError as keyof typeof oauthErrors]
      : '',
  )

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (sent) {
        await requestJson('/api/auth/email/verify', 'POST', { email, code })
        window.location.assign('/account')
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
      <aside className="frontispiece" aria-label="紫霄实验室门户">
        <div className="plate-index">
          <span>紫霄实验室 / 门户</span>
          <span>01</span>
        </div>
        <div className="plate-engraving" aria-hidden="true">
          <svg viewBox="0 0 440 325" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid" width="22" height="22" patternUnits="userSpaceOnUse">
                <path d="M22 0H0V22" stroke="currentColor" strokeOpacity=".15" />
              </pattern>
              <linearGradient
                id="ring"
                x1="55"
                y1="233"
                x2="371"
                y2="82"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#a887ff" stopOpacity=".1" />
                <stop offset="1" stopColor="#d1b9ff" />
              </linearGradient>
            </defs>
            <path d="M20 20h400v285H20z" fill="url(#grid)" />
            <path
              d="M20 32V20h12m376 0h12v12m0 261v12h-12m-376 0H20v-12M220 28v269M30 163h380"
              stroke="currentColor"
              strokeOpacity=".42"
            />
            <g transform="rotate(-24 220 163)" stroke="url(#ring)">
              <ellipse cx="220" cy="163" rx="154" ry="58" />
              <ellipse cx="220" cy="163" rx="154" ry="82" />
              <ellipse cx="220" cy="163" rx="154" ry="110" />
            </g>
            <circle
              cx="220"
              cy="163"
              r="104"
              stroke="currentColor"
              strokeOpacity=".32"
              strokeDasharray="2 5"
            />
            <circle cx="220" cy="163" r="67" stroke="currentColor" strokeOpacity=".38" />
            <circle cx="220" cy="163" r="8" fill="#e5ceff" />
            <circle cx="331" cy="86" r="4" fill="#fcd34d" />
            <path d="M174 163h92m-46-46v92" stroke="#e5ceff" strokeOpacity=".68" />
          </svg>
        </div>
        <div className="plate-caption">
          <p className="plate-code" lang="en">
            ZL–01 / ACCESS
          </p>
          <p>实验室入口</p>
          <span lang="en">IDENTITY & DOCUMENTATION</span>
        </div>
      </aside>
      <section className="login-surface" aria-labelledby="login-title">
        <div className="login-content">
          <p className="eyebrow">
            <span className="index-mark" /> 账户 / ACCOUNT
          </p>
          <h1 id="login-title">登录门户</h1>
          <p className="login-lede">
            使用 GitHub 登录或创建账户。紫霄实验室员工也可使用工作邮箱登录。
          </p>
          <a className="github-button" href="/api/auth/github">
            <LogoGithub aria-hidden width={21} height={21} /> <span>使用 GitHub 继续</span>
            <ArrowRight aria-hidden width={18} height={18} />
          </a>
          <div className="form-divider">
            <span />
            员工邮箱
            <span />
          </div>
          <form onSubmit={submit} className="form-stack">
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
                placeholder="name@zixiaolabs.com"
                startContent={<Envelope aria-hidden width={17} height={17} />}
              />
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant={sent ? 'solid' : 'outline'}
              disabled={busy}
              className="form-action"
            >
              {busy ? '正在处理…' : sent ? '验证并登录' : '发送验证码'}
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
          <div className="login-docs">
            只想查阅资料？{' '}
            <Link to="/docs">
              浏览公开文档 <ArrowRight aria-hidden width={14} height={14} />
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}

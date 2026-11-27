import { Link } from '@tanstack/react-router'

export function AdminVerification() {
  return (
    <div className="account-link">
      <p className="muted">当前会话尚未验证工作邮箱。验证后即可进入管理后台，无需先退出登录。</p>
      <Link to="/login" hash="work-email" className="quiet-link">
        验证工作邮箱
      </Link>
    </div>
  )
}

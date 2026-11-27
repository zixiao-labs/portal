import { BookOpen, Palette, Person } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { themePresets } from '@zixiao-labs/ui-kits-react/theme'
import { useEffect, useState } from 'react'
import logo from '../../assets/zixiao-logo-2.svg?url'
import {
  applyAppearance,
  colorSchemeQuery,
  defaults,
  storageKey,
  storedAppearance,
  styles,
  type Appearance,
} from './appearance'

export function Footer() {
  const [preference, setPreference] = useState<Appearance>()
  const appearance = preference ?? defaults
  useEffect(() => setPreference(storedAppearance()), [])
  useEffect(() => {
    if (!preference) return // The head script already set the theme before hydration.
    const media = matchMedia(colorSchemeQuery)
    const sync = () => applyAppearance(preference, media.matches)
    sync()
    if (preference.mode !== 'system') return
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [preference])

  function update(next: Partial<Appearance>) {
    const value = { ...appearance, ...next }
    setPreference(value)
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      /* Optional preference. */
    }
  }
  return (
    <footer className="site-footer">
      <span>© Zixiao Laboratories · 紫霄实验室</span>
      <details className="appearance">
        <summary>
          <Palette aria-hidden width={17} height={17} /> 外观
        </summary>
        <div className="appearance-fields">
          <label>
            配色
            <select
              value={appearance.palette}
              onChange={(event) => update({ palette: event.target.value as Appearance['palette'] })}
            >
              {Object.entries(themePresets).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.name}
                </option>
              ))}
              <option value="native">组件原色</option>
            </select>
          </label>
          <label>
            组件风格
            <select
              value={appearance.style}
              onChange={(event) => update({ style: event.target.value as Appearance['style'] })}
            >
              {Object.entries(styles).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            明暗
            <select
              value={appearance.mode}
              onChange={(event) => update({ mode: event.target.value as Appearance['mode'] })}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
        </div>
      </details>
    </footer>
  )
}

export function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="/api/auth/entry">
          <img src={logo} alt="" width="36" height="36" />
          <span>
            <strong>紫霄实验室</strong>
            <small lang="en">ZIXIAO LABORATORIES</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <Link to="/docs">
            <BookOpen aria-hidden /> <span>文档库</span>
          </Link>
          <Link to="/account">
            <Person aria-hidden /> <span>个人中心</span>
          </Link>
        </nav>
      </div>
    </header>
  )
}

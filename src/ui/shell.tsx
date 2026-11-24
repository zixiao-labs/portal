import { BookOpen, Palette, Person } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { createTheme, themePresets, zixiaoDarkColors } from '@zixiao-labs/ui-kits-react/theme'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import logo from '../../assets/zixiao-logo-2.svg?url'

const styles = {
  hepo: '鹤坡',
  'hepo-interior': '鹤坡·室内',
  clean: 'Clean',
  endfield: 'Endfield',
  minimal: 'Minimal',
  soft: 'Soft',
  brutalist: 'Brutalist',
}
type PaletteName = keyof typeof themePresets | 'native'
type StyleName = keyof typeof styles
type Appearance = { palette: PaletteName; style: StyleName; dark: boolean }
const defaults: Appearance = { palette: 'zixiao', style: 'hepo', dark: false }
const storageKey = 'zixiao-portal-appearance'

function storedAppearance(): Appearance {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (
      stored &&
      Object.hasOwn(styles, stored.style) &&
      (stored.palette === 'native' || Object.hasOwn(themePresets, stored.palette)) &&
      typeof stored.dark === 'boolean'
    ) {
      return stored
    }
  } catch {
    /* Storage may be unavailable. */
  }
  return defaults
}

export function ThemeScope({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(defaults)
  useEffect(() => setAppearance(storedAppearance()), [])
  const preset = appearance.palette === 'native' ? undefined : themePresets[appearance.palette]
  const theme = useMemo(() => {
    if (!preset) return
    const tokens = createTheme(
      {
        ...preset,
        darkColors: appearance.palette === 'zixiao' ? zixiaoDarkColors : undefined,
      },
      appearance.dark,
    )
    // A palette changes colors, not the selected component style's geometry.
    return Object.fromEntries(
      Object.entries(tokens).filter(([key]) => !key.startsWith('--zx-radius')),
    )
  }, [appearance.palette, appearance.dark, preset])
  function update(next: Partial<Appearance>) {
    const value = { ...appearance, ...next }
    setAppearance(value)
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      /* Optional preference. */
    }
  }
  return (
    <div
      className="theme-scope"
      data-zx-style={appearance.style}
      data-zx-color-mode={appearance.dark ? 'dark' : 'light'}
      style={theme as CSSProperties}
    >
      {children}
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
                onChange={(event) => update({ palette: event.target.value as PaletteName })}
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
                onChange={(event) => update({ style: event.target.value as StyleName })}
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
                value={appearance.dark ? 'dark' : 'light'}
                onChange={(event) => update({ dark: event.target.value === 'dark' })}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </div>
        </details>
      </footer>
    </div>
  )
}

export function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" to="/login">
          <img src={logo} alt="" width="36" height="36" />
          <span>
            <strong>紫霄实验室</strong>
            <small lang="en">ZIXIAO LABORATORIES</small>
          </span>
        </Link>
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

import { createTheme, themePresets, zixiaoDarkColors } from '@zixiao-labs/ui-kits-react/theme'

export const styles = {
  hepo: '鹤坡',
  'hepo-interior': '鹤坡·室内',
  clean: 'Clean',
  endfield: 'Endfield',
  minimal: 'Minimal',
  soft: 'Soft',
  brutalist: 'Brutalist',
}

export type Appearance = {
  palette: keyof typeof themePresets | 'native'
  style: keyof typeof styles
  mode: 'system' | 'light' | 'dark'
}

export const defaults: Appearance = { palette: 'zixiao', style: 'hepo', mode: 'system' }
export const colorSchemeQuery = '(prefers-color-scheme: dark)'
export const storageKey = 'zixiao-portal-appearance'
const config = {
  storageKey,
  defaults,
  palettes: Object.keys(themePresets),
  styles: Object.keys(styles),
}

function readAppearance({ storageKey, defaults, palettes, styles }: typeof config): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (saved) {
      const { palette, style, mode, dark } = saved
      // Earlier versions stored an explicit dark/light choice as a boolean.
      const fallbackMode = typeof dark === 'boolean' ? (dark ? 'dark' : 'light') : defaults.mode
      return {
        palette: palette === 'native' || palettes.includes(palette) ? palette : defaults.palette,
        style: styles.includes(style) ? style : defaults.style,
        mode: mode === 'system' || mode === 'light' || mode === 'dark' ? mode : fallbackMode,
      }
    }
  } catch {
    /* Missing, malformed, or blocked storage falls back to the defaults. */
  }
  return defaults
}

export function storedAppearance() {
  return readAppearance(config)
}

export function applyAppearance({ palette, style, mode }: Appearance, systemDark: boolean) {
  const { dataset } = document.documentElement
  dataset.portalPalette = palette
  dataset.zxStyle = style
  dataset.zxColorMode = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
}

// Run the same preference rules in the head before the first paint. Both functions
// are self-contained so this script can also run before the client bundle arrives.
export const appearanceScript = `(${applyAppearance.toString()})((${readAppearance.toString()})(${JSON.stringify(config)}),matchMedia(${JSON.stringify(colorSchemeQuery)}).matches)`

// Ship both modes so the head script only needs to select attributes, not generate
// colors. Keep shape tokens from the chosen component style.
export const paletteCss = Object.entries(themePresets)
  .flatMap(([name, preset]) =>
    (['light', 'dark'] as const).map((mode) => {
      const tokens = createTheme(
        { ...preset, darkColors: name === 'zixiao' ? zixiaoDarkColors : undefined },
        mode === 'dark',
      )
      const colors = Object.entries(tokens)
        .filter(([key]) => !key.startsWith('--zx-radius'))
        .map(([key, value]) => `${key}:${value}`)
        .join(';')
      return `:root[data-portal-palette="${name}"][data-zx-color-mode="${mode}"]{${colors}}`
    }),
  )
  .join('\n')

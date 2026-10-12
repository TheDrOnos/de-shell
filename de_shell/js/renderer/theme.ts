/**
 * theme.ts — the colours the shell's own components use, as CSS custom
 * properties with dark fallbacks.
 *
 * The shell has no stylesheet and no CSS framework: an app themes these by
 * defining `--shell-*` variables on :root, and an app that defines none gets a
 * dark palette that reads fine on its own. Inline styles (not a <style> sheet)
 * so a component works with zero setup in any host, including a CSP that
 * forbids loading stylesheets.
 */
import type { CSSProperties } from 'react'

const v = (name: string, fallback: string) => `var(--shell-${name}, ${fallback})`

export const colors = {
  bg: v('bg', '#1e1e2e'),
  inset: v('bg-inset', '#11111b'),
  border: v('border', '#313244'),
  borderStrong: v('border-strong', '#45475a'),
  fg: v('fg', '#cdd6f4'),
  muted: v('fg-muted', '#a6adc8'),
  faint: v('fg-faint', '#6c7086'),
  accent: v('accent', '#89b4fa'),
  onAccent: v('on-accent', '#11111b'),
  danger: v('danger', '#f38ba8'),
  warn: v('warn', '#f9e2af'),
  ok: v('ok', '#a6e3a1'),
  scrim: v('scrim', 'rgba(17,17,27,0.72)'),
} as const

export const font = v('font', 'system-ui, sans-serif')
export const mono = v('font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace')

/** Buttons shared by every dialog and card. */
export const buttons: Record<'primary' | 'ghost' | 'disabled', CSSProperties> = {
  primary: {
    background: colors.accent, border: 'none', color: colors.onAccent, fontWeight: 600,
    borderRadius: 6, padding: '6px 18px', cursor: 'pointer', fontSize: 12,
  },
  ghost: {
    background: 'transparent', border: `1px solid ${colors.borderStrong}`, color: colors.fg,
    borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12,
  },
  disabled: { opacity: 0.5, cursor: 'default' },
}

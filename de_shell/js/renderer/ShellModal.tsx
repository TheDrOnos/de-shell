/**
 * ShellModal.tsx — the centred modal the shell's dialogs share. Themed only
 * through `--shell-*` variables (theme.ts); no app styles required.
 */
import React from 'react'
import { colors, font } from './theme'

export function ShellModal({
  testid, title, width = 400, onClose, footer, children,
}: {
  testid: string
  title: React.ReactNode
  width?: number
  onClose: () => void
  footer: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      data-testid={testid}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9500, background: colors.scrim,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: font,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 10,
          padding: 18, color: colors.fg, fontSize: 13,
          boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>{title}</h3>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          {footer}
        </div>
      </div>
    </div>
  )
}

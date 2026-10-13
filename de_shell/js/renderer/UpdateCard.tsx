/**
 * UpdateCard.tsx — the "new version available" card, pinned bottom-left.
 *
 * Reacts to the WHOLE updater lifecycle, not just available/downloaded: errors
 * show with a Retry, so a flaky or timed-out check is visible and recoverable
 * rather than silently dropped. Idle and up-to-date render nothing.
 *
 * Dismissable per session; a NEW status un-dismisses it, so a fresh version or
 * a later error can re-appear and an error is never dismissed away from its
 * Retry for good. Pass `dialogOpen` to hide it while the full UpdateDialog is
 * up. All names come from props.
 */
import React, { useEffect, useState } from 'react'

import type { UpdaterApi } from './bridgeTypes'
import { colors, buttons, font } from './theme'
import { updateCardModel } from './updateModel'
import { useUpdateStatus } from './useUpdateStatus.react'

export interface UpdateCardProps {
  updater: UpdaterApi
  appName: string
  /** Hide the card while the full dialog is open. */
  dialogOpen?: boolean
  /** Shows a "Details" button that opens the full dialog. */
  onOpenDialog?: () => void
}

export function UpdateCard({ updater, appName, dialogOpen, onOpenDialog }: UpdateCardProps) {
  const { status } = useUpdateStatus(updater)
  const [dismissed, setDismissed] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)

  // Any new status un-dismisses the card (object identity changes per push).
  useEffect(() => { setDismissed(false); setNotesOpen(false) }, [status])

  const m = updateCardModel(status, appName, { dismissed, dialogOpen })
  if (!m.visible) return null

  const act = () => {
    if (m.action === 'download') updater.download()
    else if (m.action === 'restart') updater.quitAndInstall()
    else if (m.action === 'retry') updater.check()
  }
  const actLabel = m.action === 'download' ? 'Download'
    : m.action === 'restart' ? 'Restart to update' : 'Retry'

  return (
    <div data-testid="update-card" style={S.stack}>
      <div style={S.card}>
        <div style={S.row}>
          <span style={S.title}>{m.title}</span>
          <button data-testid="update-card-dismiss" style={S.dismiss}
            onClick={() => setDismissed(true)} aria-label="Dismiss" title="Dismiss">×</button>
        </div>

        {status.state === 'checking' && (
          <div style={S.subtle} data-testid="update-card-checking">Checking for updates…</div>
        )}
        {m.error && <div style={S.errText} data-testid="update-card-error">{m.error}</div>}
        {m.percent != null && (
          <>
            <div style={S.track} data-testid="update-card-bar">
              <div style={{ ...S.fill, width: `${m.percent}%` }} />
            </div>
            <div style={S.subtle}>{m.percent}%</div>
          </>
        )}
        {m.notes && notesOpen && (
          <div style={S.notes} data-testid="update-card-notes">{m.notes}</div>
        )}

        {(m.action || m.notes) && (
          <div style={S.actions}>
            {m.action && (
              <button data-testid={`update-card-${m.action}`} style={S.primary} onClick={act}>
                {actLabel}
              </button>
            )}
            {m.notes && (
              <button data-testid="update-card-notes-toggle" style={S.ghost}
                onClick={() => setNotesOpen((v) => !v)}>
                {notesOpen ? 'Hide notes' : 'Release notes'}
              </button>
            )}
            {onOpenDialog && (m.action === 'download' || m.action === 'restart') && (
              <button data-testid="update-card-details" style={S.ghost} onClick={onOpenDialog}>
                Details
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  stack: {
    position: 'fixed', left: 12, bottom: 44, zIndex: 9300, width: 280, fontFamily: font,
  },
  card: {
    background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8,
    padding: '10px 12px', boxShadow: '0 10px 28px rgba(0,0,0,0.5)',
    display: 'flex', flexDirection: 'column', gap: 8, color: colors.fg,
  },
  row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.3 },
  dismiss: {
    flex: '0 0 auto', background: 'none', border: 'none', color: colors.faint,
    fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: '0 2px', marginTop: -2,
  },
  subtle: { fontSize: 11.5, color: colors.muted },
  // Bounded: an unexpectedly long message scrolls inside the card instead of
  // blowing out its height.
  errText: {
    fontSize: 11.5, color: colors.danger, lineHeight: 1.4,
    maxHeight: 120, overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
  },
  notes: {
    fontSize: 11, color: colors.muted, lineHeight: 1.45, whiteSpace: 'pre-wrap',
    maxHeight: 140, overflowY: 'auto',
    background: colors.inset, border: `1px solid ${colors.border}`, borderRadius: 6,
    padding: '6px 8px',
  },
  track: { height: 5, borderRadius: 3, background: colors.border, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, background: colors.accent, transition: 'width 200ms linear' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  primary: { ...buttons.primary, padding: '5px 14px', fontSize: 11.5 },
  ghost: { ...buttons.ghost, padding: '5px 10px', fontSize: 11 },
}

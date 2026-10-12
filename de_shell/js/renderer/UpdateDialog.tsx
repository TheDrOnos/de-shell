/**
 * UpdateDialog.tsx — "Check for Updates…": running version, a stable/beta
 * channel toggle, and the check -> download -> restart flow.
 *
 * autoDownload is off in main's updater, so nothing happens until the user
 * clicks through each step. Content decisions live in updateModel.ts.
 */
import React from 'react'

import type { UpdaterApi } from './bridgeTypes'
import { ShellModal } from './ShellModal'
import { colors, buttons } from './theme'
import { updateDialogModel } from './updateModel'
import { useUpdateStatus } from './useUpdateStatus.react'

export interface UpdateDialogProps {
  updater: UpdaterApi
  appName: string
  onClose: () => void
  /** Where to point users of an unsupported (dev/unpackaged) build. */
  releasesHint?: string
}

export function UpdateDialog({ updater, appName, onClose, releasesHint }: UpdateDialogProps) {
  const snap = useUpdateStatus(updater)
  // Channel is local so the toggle responds at once; main persists it.
  const [channel, setChannel] = React.useState<'stable' | 'beta' | null>(null)
  const current = channel ?? snap.channel
  const m = updateDialogModel(snap.status, appName, snap.supported)

  const pick = (c: 'stable' | 'beta') => { setChannel(c); updater.setChannel(c) }
  const act = () => {
    if (m.action === 'download') updater.download()
    else if (m.action === 'restart') updater.quitAndInstall()
    else if (m.action === 'check') updater.check()
  }

  return (
    <ShellModal testid="update-dialog" title="Check for Updates" onClose={onClose}
      footer={<>
        <button data-testid="update-close" style={buttons.ghost} onClick={onClose}>Close</button>
        {m.action && (
          <button
            data-testid={m.action === 'check' ? 'update-check-now' : `update-${m.action}`}
            style={{ ...buttons.primary, ...(m.actionDisabled ? buttons.disabled : {}) }}
            disabled={m.actionDisabled}
            onClick={act}
          >
            {m.action === 'download' ? 'Download'
              : m.action === 'restart' ? 'Restart to Install' : 'Check Now'}
          </button>
        )}
      </>}>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: colors.muted }}>
        Current version <strong>{snap.appVersion || '…'}</strong>
      </p>

      {!snap.supported && (
        <p style={S.notice}>
          This build does not support auto-update (a dev or unpackaged run).
          {releasesHint ? ` ${releasesHint}` : ''}
        </p>
      )}

      <div style={S.channelRow}>
        <span style={{ fontSize: 12, color: colors.muted }}>Update channel</span>
        <div style={S.toggle}>
          {(['stable', 'beta'] as const).map((c) => (
            <button key={c} data-testid={`update-channel-${c}`} onClick={() => pick(c)}
              style={{
                ...S.toggleBtn,
                background: current === c ? colors.accent : 'transparent',
                color: current === c ? colors.onAccent : colors.fg,
              }}>
              {c === 'stable' ? 'Stable' : 'Beta'}
            </button>
          ))}
        </div>
      </div>

      {m.text && (
        <div data-testid="update-status-text"
          style={m.tone === 'error' ? S.error : S.status}>
          <div>{m.text}</div>
          {m.percent != null && (
            <div style={S.track} data-testid="update-download-progress">
              <div style={{ height: '100%', width: `${m.percent}%`, background: colors.accent }} />
            </div>
          )}
        </div>
      )}
    </ShellModal>
  )
}

const S: Record<string, React.CSSProperties> = {
  notice: {
    margin: '0 0 14px', fontSize: 11.5, color: colors.warn, lineHeight: 1.4,
    border: `1px solid ${colors.warn}`, borderRadius: 6, padding: '8px 10px',
  },
  channelRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14,
  },
  toggle: {
    display: 'flex', background: colors.inset, borderRadius: 7,
    border: `1px solid ${colors.border}`, padding: 2, gap: 2,
  },
  toggleBtn: {
    border: 'none', borderRadius: 5, padding: '4px 12px', fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  },
  status: {
    fontSize: 12.5, margin: '0 0 6px', background: colors.inset,
    border: `1px solid ${colors.border}`, borderRadius: 6, padding: '10px 12px',
  },
  // Bounded: scroll inside the box rather than overflow the dialog.
  error: {
    fontSize: 12.5, margin: '0 0 6px', color: colors.danger, background: colors.inset,
    border: `1px solid ${colors.danger}`, borderRadius: 6, padding: '10px 12px',
    maxHeight: 160, overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
  },
  track: {
    marginTop: 6, height: 5, borderRadius: 3, background: colors.border, overflow: 'hidden',
  },
}

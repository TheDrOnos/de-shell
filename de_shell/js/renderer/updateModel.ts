/**
 * updateModel.ts — what the update card and dialog show for a given status,
 * as pure functions. The components are thin renderers of these.
 */

/** Mirrors main's UpdateStatus (updater.ts). */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export type UpdateAction = 'download' | 'restart' | 'retry'

export interface UpdateCardModel {
  visible: boolean
  title: string
  /** The one primary button, if the state has one. */
  action: UpdateAction | null
  /** Release notes are offered only for an available update. */
  notes: string | null
  percent: number | null
  error: string | null
}

/**
 * The card's content. Idle and not-available show nothing (the dialog owns
 * "you are up to date"); errors always show, with Retry, so a flaky check is
 * visible and recoverable rather than silently dropped. Hidden while the full
 * dialog is open, since that is the full-control surface.
 */
export function updateCardModel(
  status: UpdateStatus, appName: string,
  opts: { dismissed?: boolean; dialogOpen?: boolean } = {},
): UpdateCardModel {
  const s = status
  const shown = s.state === 'available' || s.state === 'downloading'
    || s.state === 'downloaded' || s.state === 'error' || s.state === 'checking'
  const title =
    s.state === 'available' ? `${appName} ${s.version} is available`
    : s.state === 'downloading' ? 'Downloading update…'
    : s.state === 'downloaded' ? `${appName} ${s.version} downloaded`
    : s.state === 'error' ? 'Update failed'
    : `${appName} updates`
  return {
    visible: shown && !opts.dismissed && !opts.dialogOpen,
    title,
    action: s.state === 'available' ? 'download'
      : s.state === 'downloaded' ? 'restart'
      : s.state === 'error' ? 'retry' : null,
    notes: s.state === 'available' ? (s.releaseNotes ?? null) : null,
    percent: s.state === 'downloading' ? clampPercent(s.percent) : null,
    error: s.state === 'error' ? s.message : null,
  }
}

export interface UpdateDialogModel {
  /** One-line status text, or null when there is nothing to say. */
  text: string | null
  tone: 'normal' | 'error'
  percent: number | null
  /** Primary button. `check` is disabled while a check/download is in flight. */
  action: 'check' | 'download' | 'restart' | null
  actionDisabled: boolean
}

export function updateDialogModel(
  status: UpdateStatus, appName: string, supported: boolean,
): UpdateDialogModel {
  const base: UpdateDialogModel = {
    text: null, tone: 'normal', percent: null, action: null, actionDisabled: false,
  }
  // An unsupported (dev/unpackaged) build can't update at all: no buttons.
  if (!supported) return base
  switch (status.state) {
    case 'checking':
      return { ...base, text: 'Checking for updates…', action: 'check', actionDisabled: true }
    case 'available':
      return { ...base, text: `${appName} ${status.version} is available.`, action: 'download' }
    case 'not-available':
      return { ...base, text: 'You are up to date.', action: 'check' }
    case 'downloading': {
      const percent = clampPercent(status.percent)
      return { ...base, text: `Downloading… ${percent}%`, percent, action: 'check', actionDisabled: true }
    }
    case 'downloaded':
      return {
        ...base, text: `${appName} ${status.version} downloaded — restart to install.`,
        action: 'restart',
      }
    case 'error':
      return { ...base, text: `Update check failed: ${status.message}`, tone: 'error', action: 'check' }
    default:
      return { ...base, action: 'check' }
  }
}

function clampPercent(p: number): number {
  return Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0
}

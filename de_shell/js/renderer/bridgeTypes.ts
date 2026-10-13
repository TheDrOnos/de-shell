/**
 * bridgeTypes.ts — the slices of the preload bridge the shell's components use,
 * stated structurally.
 *
 * The renderer cannot import from the preload (it is a different bundle with
 * electron types), so components take these as props. `window[appId]` — typed
 * as `ShellBridge` from @de/shell-preload — satisfies all of them, so wiring is
 * `<UpdateCard updater={window.myapp.updater} …/>`.
 */
import type { UpdateStatus } from './updateModel'

export interface UpdateInfo {
  channel: 'stable' | 'beta'
  supported: boolean
  status: UpdateStatus
  appVersion: string
}

export interface UpdaterApi {
  info(): Promise<UpdateInfo>
  check(): void
  download(): void
  quitAndInstall(): void
  setChannel(c: 'stable' | 'beta'): void
  /** Returns an unsubscribe fn. */
  onStatus(cb: (s: UpdateStatus) => void): () => void
}

export interface ReportResult {
  sent: boolean
  eventId?: string
  bundlePath?: string
  error?: string
}

export interface ReportApi {
  diagnostics(): Promise<{ canSend: boolean; diagnostics: Record<string, unknown> }>
  submit(input: { message: string; contact?: string }): Promise<ReportResult>
}

export interface EnvSetupApi {
  answer(choice: 'retry' | 'use-wheelhouse' | 'quit'): void
}

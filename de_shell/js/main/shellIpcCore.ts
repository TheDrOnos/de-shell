/**
 * shellIpcCore.ts — the updater / problem-report IPC wiring with the Electron
 * pieces injected, so it runs under node --test. shellIpc.ts binds it to the
 * real `ipcMain` and the real updater.ts / errorReport.ts.
 *
 * Re-registering REPLACES the previous handlers rather than throwing (Electron
 * throws on a second `handle` for one channel), which is what makes the public
 * `register*` calls idempotent.
 */
export interface IpcLike {
  handle(ch: string, fn: (event: unknown, ...args: any[]) => unknown): void
  on(ch: string, fn: (event: unknown, ...args: any[]) => void): void
  removeHandler(ch: string): void
  removeAllListeners(ch: string): void
}

/** Channel suffixes, joined to `<appId>:` by the caller. preload/index.ts
 *  spells the same names; shellIpc.test.ts pins them. */
export const UPDATER_CHANNELS = {
  info: 'update-info',
  check: 'update-check',
  download: 'update-download',
  install: 'update-install',
  setChannel: 'update-set-channel',
  /** Main -> renderer push, sent by updater.ts itself. */
  status: 'update-status',
} as const

export const REPORT_CHANNELS = {
  diagnostics: 'report-diagnostics',
  submit: 'report-submit',
} as const

export interface UpdaterDeps {
  channel: (name: string) => string
  readChannel: () => 'stable' | 'beta'
  setChannel: (c: 'stable' | 'beta') => void
  supported: () => boolean
  status: () => unknown
  appVersion: () => string
  check: () => void
  download: () => void
  quitAndInstall: () => void
  /** Called after a valid channel change, e.g. to mirror it into the backend. */
  onChannelChange?: (c: 'stable' | 'beta') => void
}

function replaceHandle(ipc: IpcLike, ch: string, fn: (e: unknown, ...a: any[]) => unknown) {
  ipc.removeHandler(ch)
  ipc.handle(ch, fn)
}
function replaceOn(ipc: IpcLike, ch: string, fn: (e: unknown, ...a: any[]) => void) {
  ipc.removeAllListeners(ch)
  ipc.on(ch, fn)
}

export function bindUpdaterIpc(ipc: IpcLike, d: UpdaterDeps): void {
  const ch = (k: keyof typeof UPDATER_CHANNELS) => d.channel(UPDATER_CHANNELS[k])
  // Seeds a dialog/card that mounts AFTER the startup check already fired.
  replaceHandle(ipc, ch('info'), () => ({
    channel: d.readChannel(),
    supported: d.supported(),
    status: d.status(),
    appVersion: d.appVersion(),
  }))
  replaceOn(ipc, ch('check'), () => d.check())
  replaceOn(ipc, ch('download'), () => d.download())
  replaceOn(ipc, ch('install'), () => d.quitAndInstall())
  replaceOn(ipc, ch('setChannel'), (_e, c: unknown) => {
    // The renderer is untrusted input; anything but the two channels is ignored.
    if (c !== 'stable' && c !== 'beta') return
    d.setChannel(c)
    d.onChannelChange?.(c)
  })
}

export interface ReportDeps {
  channel: (name: string) => string
  configured: () => boolean
  collect: () => Promise<unknown>
  submit: (input: { message: string; contact?: string }) => Promise<unknown>
}

export function bindReportIpc(ipc: IpcLike, d: ReportDeps): void {
  // Reading diagnostics has no side effects: opening the dialog sends nothing.
  replaceHandle(ipc, d.channel(REPORT_CHANNELS.diagnostics), async () => ({
    canSend: d.configured(),
    diagnostics: await d.collect(),
  }))
  replaceHandle(ipc, d.channel(REPORT_CHANNELS.submit), (_e, input: unknown) => {
    const i = (input ?? {}) as { message?: unknown; contact?: unknown }
    return d.submit({
      message: typeof i.message === 'string' ? i.message : '',
      contact: typeof i.contact === 'string' && i.contact.trim() ? i.contact.trim() : undefined,
    })
  })
}

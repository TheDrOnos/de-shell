/**
 * shellIpc.ts — the updater and problem-report IPC, registered with one call
 * each. Every app used to hand-wire these (and Ground Crew wired neither).
 *
 * Channels are `<appId>:update-*` and `<appId>:report-*`. Update STATUS is
 * pushed on `<appId>:update-status` by updater.ts itself (it holds the window
 * given to `initUpdater`), so there is no subscribe channel here — only the
 * `update-info` invoke that seeds a late-mounting UI with the last status.
 * Safe to call twice: handlers are replaced, not stacked.
 */
import { app, ipcMain } from 'electron'

import { channel } from './config'
import { collectDiagnostics, reportingConfigured, submitReport } from './errorReport'
import { bindReportIpc, bindUpdaterIpc } from './shellIpcCore'
import {
  checkForUpdates, downloadUpdate, getLastUpdateStatus, quitAndInstall,
  readUpdateChannel, setUpdateChannel, updatesSupported,
} from './updater'

export function registerUpdaterIpc(
  opts: { onChannelChange?: (c: 'stable' | 'beta') => void } = {},
): void {
  bindUpdaterIpc(ipcMain, {
    channel,
    readChannel: readUpdateChannel,
    setChannel: setUpdateChannel,
    supported: updatesSupported,
    status: getLastUpdateStatus,
    appVersion: () => app.getVersion(),
    check: checkForUpdates,
    download: downloadUpdate,
    quitAndInstall,
    onChannelChange: opts.onChannelChange,
  })
}

export function registerProblemReportIpc(): void {
  bindReportIpc(ipcMain, {
    channel,
    configured: reportingConfigured,
    collect: collectDiagnostics,
    submit: submitReport,
  })
}

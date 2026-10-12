/**
 * shellIpcCore.test.ts — channel names, idempotency and input validation for
 * the updater / report IPC, against a fake ipcMain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bindReportIpc, bindUpdaterIpc, REPORT_CHANNELS, UPDATER_CHANNELS,
} from './shellIpcCore.ts'
import type { IpcLike, UpdaterDeps } from './shellIpcCore.ts'

function fakeIpc() {
  const handlers = new Map<string, (e: unknown, ...a: any[]) => unknown>()
  const listeners = new Map<string, Array<(e: unknown, ...a: any[]) => void>>()
  const ipc: IpcLike = {
    handle(ch, fn) {
      if (handlers.has(ch)) throw new Error(`second handler for ${ch}`)   // Electron does this
      handlers.set(ch, fn)
    },
    on(ch, fn) { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]) },
    removeHandler(ch) { handlers.delete(ch) },
    removeAllListeners(ch) { listeners.delete(ch) },
  }
  const emit = (ch: string, ...a: unknown[]) => listeners.get(ch)?.forEach(f => f({}, ...a))
  return { ipc, handlers, listeners, emit }
}

function updaterDeps(calls: string[]): UpdaterDeps {
  return {
    channel: n => `app:${n}`,
    readChannel: () => 'stable',
    setChannel: c => calls.push(`set:${c}`),
    supported: () => true,
    status: () => ({ state: 'idle' }),
    appVersion: () => '1.2.3',
    check: () => calls.push('check'),
    download: () => calls.push('download'),
    quitAndInstall: () => calls.push('install'),
    onChannelChange: c => calls.push(`changed:${c}`),
  }
}

test('channel names are namespaced and stable (the preload spells the same ones)', () => {
  assert.deepEqual(UPDATER_CHANNELS, {
    info: 'update-info', check: 'update-check', download: 'update-download',
    install: 'update-install', setChannel: 'update-set-channel', status: 'update-status',
  })
  assert.deepEqual(REPORT_CHANNELS, { diagnostics: 'report-diagnostics', submit: 'report-submit' })
})

test('updater actions reach the updater; info seeds a late UI', async () => {
  const f = fakeIpc(); const calls: string[] = []
  bindUpdaterIpc(f.ipc, updaterDeps(calls))
  f.emit('app:update-check'); f.emit('app:update-download'); f.emit('app:update-install')
  assert.deepEqual(calls, ['check', 'download', 'install'])
  assert.deepEqual(await f.handlers.get('app:update-info')!({}), {
    channel: 'stable', supported: true, status: { state: 'idle' }, appVersion: '1.2.3',
  })
})

test('registering twice neither throws nor doubles the work', () => {
  const f = fakeIpc(); const calls: string[] = []
  bindUpdaterIpc(f.ipc, updaterDeps(calls))
  bindUpdaterIpc(f.ipc, updaterDeps(calls))
  f.emit('app:update-check')
  assert.deepEqual(calls, ['check'])
  bindReportIpc(f.ipc, { channel: n => `app:${n}`, configured: () => true, collect: async () => ({}), submit: async () => ({}) })
  bindReportIpc(f.ipc, { channel: n => `app:${n}`, configured: () => true, collect: async () => ({}), submit: async () => ({}) })
})

test('set-channel ignores anything but stable and beta', () => {
  const f = fakeIpc(); const calls: string[] = []
  bindUpdaterIpc(f.ipc, updaterDeps(calls))
  f.emit('app:update-set-channel', 'nightly')
  f.emit('app:update-set-channel', { evil: 1 })
  f.emit('app:update-set-channel', 'beta')
  assert.deepEqual(calls, ['set:beta', 'changed:beta'])
})

test('report: diagnostics reports canSend, submit sanitises its input', async () => {
  const f = fakeIpc(); const seen: unknown[] = []
  bindReportIpc(f.ipc, {
    channel: n => `app:${n}`, configured: () => false,
    collect: async () => ({ problems: [] }),
    submit: async i => { seen.push(i); return { sent: false } },
  })
  assert.deepEqual(await f.handlers.get('app:report-diagnostics')!({}),
    { canSend: false, diagnostics: { problems: [] } })
  const submit = f.handlers.get('app:report-submit')!
  await submit({}, { message: 'it broke', contact: '  a@b.c ' })
  await submit({}, { message: 5, contact: '   ' })
  await submit({}, null)
  assert.deepEqual(seen, [
    { message: 'it broke', contact: 'a@b.c' },
    { message: '', contact: undefined },
    { message: '', contact: undefined },
  ])
})

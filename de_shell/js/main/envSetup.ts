/**
 * envSetup.ts — `runEnvSetup`: what a packaged app calls INSTEAD of
 * `resolvePythonEnv` directly.
 *
 * It does the same resolve, but narrates it to the renderer as `env_setup`
 * shell messages (so the first run shows a real progress overlay rather than a
 * blank window) and survives failure by asking the user what to do — retry,
 * install from a local wheelhouse folder, or quit. The state machine itself is
 * envSetupMachine.ts; this file is only the Electron glue: the IPC answer
 * channel, the native folder dialog, and app.quit.
 *
 * Messages ride the window's normal message pipe (`sendToRenderer`), so they
 * are buffered until the renderer listens — a progress line sent before React
 * mounted is not lost.
 */
import { app, dialog, ipcMain } from 'electron'

import { channel, shellConfig } from './config'
import { runEnvSetupMachine } from './envSetupMachine'
import type { EnvSetupAnswer } from './envSetupMachine'
import { resolvePythonEnv } from './pythonEnv'
import type { EnsureOptions, ResolvedPython } from './pythonEnv'
import type { ShellWindow } from './window'

export type { EnvSetupAnswer, EnvSetupWireMessage } from './envSetupMachine'
export { EnvSetupQuitError } from './envSetupMachine'

const ANSWERS: readonly EnvSetupAnswer[] = ['retry', 'use-wheelhouse', 'quit']

/** The answer the machine is currently waiting on, if any. An answer arriving
 *  while nothing waits (a double click, a stale renderer) is dropped. */
let waiter: ((a: EnvSetupAnswer) => void) | null = null
let listening = false

function listenForAnswers(): void {
  if (listening) return
  listening = true
  ipcMain.on(channel('env-setup-answer'), (_e, answer: unknown) => {
    if (!ANSWERS.includes(answer as EnvSetupAnswer)) return
    const w = waiter
    waiter = null
    w?.(answer as EnvSetupAnswer)
  })
}

/**
 * Resolve the Python environment with progress and a recovery path.
 *
 * `opts.wheelhouse`, if given, is used for the first attempt; later attempts use
 * whatever folder the user picks. Rejects only with EnvSetupQuitError.
 */
export function runEnvSetup(
  win: Pick<ShellWindow, 'sendToRenderer' | 'get'>,
  opts: EnsureOptions,
): Promise<ResolvedPython> {
  listenForAnswers()
  return runEnvSetupMachine<ResolvedPython>({
    initialWheelhouse: opts.wheelhouse ?? null,
    run: (wheelhouse, onProgress) => resolvePythonEnv({
      ...opts,
      wheelhouse,
      // Keep the app's own sink working alongside ours.
      onProgress: (line: string) => { opts.onProgress?.(line); onProgress(line) },
    }),
    emit: (msg) => win.sendToRenderer({ ...msg }),
    waitForAnswer: () => new Promise<EnvSetupAnswer>((resolve) => { waiter = resolve }),
    pickFolder: async () => {
      const parent = win.get()
      const options = {
        title: `Choose the folder of packages to install ${shellConfig().appName} from`,
        properties: ['openDirectory' as const],
      }
      const r = parent ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
    },
    quit: () => app.quit(),
  })
}

/**
 * envSetupMachine.ts — the first-run environment setup state machine, with no
 * Electron in it.
 *
 * A packaged first run downloads ~1.8 GB. Two things go wrong with a bare
 * `await resolvePythonEnv()`: the window sits blank for minutes, and a failure
 * (offline lab PC, proxy, full disk) leaves the app dead with no recourse.
 * This turns the run into a conversation with the renderer:
 *
 *     start -> progress* -> done                      (resolves)
 *     start -> progress* -> error -> retry            (runs again)
 *                                 -> use-wheelhouse   (folder picked, runs again offline)
 *                                 -> quit             (rejects with EnvSetupQuitError)
 *
 * Failure deliberately does NOT reject: the user is the only one who can fix a
 * dead network, so the promise stays pending until they answer. Everything
 * Electron-shaped (the IPC listener, the directory dialog, app.quit) is injected
 * by envSetup.ts, so this file is unit-testable under node --test.
 */
// Extension spelled out so node:test can load this module without a bundler.
import { parseUvLine } from './envProgress.ts'
import type { EnvProgressEvent } from './envProgress.ts'

export type EnvSetupAnswer = 'retry' | 'use-wheelhouse' | 'quit'

/** What the renderer receives (`type: 'env_setup'`). Flat and JSON-safe. */
export interface EnvSetupWireMessage {
  type: 'env_setup'
  state: 'start' | 'progress' | 'done' | 'error'
  /** Latest classified uv event in this batch (progress only). */
  event?: EnvProgressEvent
  /** The raw lines of this batch, newline-joined (progress only). */
  line?: string
  /** Human-readable failure (error only). */
  message?: string
  /** The wheelhouse folder being installed from, when there is one. */
  wheelhouse?: string
}

/** Thrown when the user answers `quit` after a failure. The app is exiting;
 *  callers should swallow it rather than report it as a crash. */
export class EnvSetupQuitError extends Error {
  constructor() {
    super('environment setup abandoned: the user chose to quit')
    this.name = 'EnvSetupQuitError'
  }
}

export interface BatcherDeps {
  emit: (msg: EnvSetupWireMessage) => void
  /** Minimum gap between progress messages. uv repaints a bar many times a
   *  second; one IPC per repaint would flood the renderer for no visible gain. */
  intervalMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/** Cap on raw lines carried by one message, so a burst cannot make a huge IPC. */
const MAX_LINES_PER_BATCH = 40

/**
 * Coalesce uv output chunks into at most one `progress` message per interval.
 * The newest classified event wins (it is the current state); every raw line is
 * kept (up to the cap) so the log tail still moves.
 */
export function createProgressBatcher(deps: BatcherDeps) {
  const interval = deps.intervalMs ?? 100
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer
    ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))

  let lines: string[] = []
  let event: EnvProgressEvent | undefined
  let timer: unknown = null
  let lastEmit = -Infinity

  const flush = () => {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (lines.length === 0 && !event) return
    const msg: EnvSetupWireMessage = {
      type: 'env_setup', state: 'progress', line: lines.join('\n'),
    }
    if (event) msg.event = event
    lines = []
    event = undefined
    lastEmit = now()
    deps.emit(msg)
  }

  const push = (chunk: string) => {
    // uv repaints with \r, so split on both; blank pieces carry nothing.
    for (const raw of chunk.split(/[\r\n]+/)) {
      const text = raw.trimEnd()
      if (!text.trim()) continue
      lines.push(text)
      const ev = parseUvLine(text)
      if (ev) event = ev
    }
    if (lines.length > MAX_LINES_PER_BATCH) lines = lines.slice(-MAX_LINES_PER_BATCH)
    if (lines.length === 0 && !event) return
    const wait = interval - (now() - lastEmit)
    if (wait <= 0) flush()
    else if (timer === null) timer = setTimer(flush, wait)
  }

  return { push, flush }
}

export interface MachineDeps<R> {
  /** Run the real resolve. `wheelhouse` is null until the user picks a folder. */
  run: (wheelhouse: string | null, onProgress: (chunk: string) => void) => Promise<R>
  emit: (msg: EnvSetupWireMessage) => void
  /** Resolve with the renderer's next answer. Only called while in `error`. */
  waitForAnswer: () => Promise<EnvSetupAnswer>
  /** Native folder picker; null when cancelled. */
  pickFolder: () => Promise<string | null>
  quit: () => void
  /** Wheelhouse to start with (an app that already knows the machine is offline). */
  initialWheelhouse?: string | null
  intervalMs?: number
}

export async function runEnvSetupMachine<R>(deps: MachineDeps<R>): Promise<R> {
  let wheelhouse = deps.initialWheelhouse ?? null
  for (;;) {
    const batcher = createProgressBatcher({ emit: deps.emit, intervalMs: deps.intervalMs })
    deps.emit({ type: 'env_setup', state: 'start', ...(wheelhouse ? { wheelhouse } : {}) })
    try {
      const result = await deps.run(wheelhouse, batcher.push)
      batcher.flush()
      deps.emit({ type: 'env_setup', state: 'done' })
      return result
    } catch (err) {
      // Flush first so the last uv lines (usually the actual reason) reach the
      // log tail BEFORE the error replaces the progress view.
      batcher.flush()
      deps.emit({
        type: 'env_setup', state: 'error',
        message: (err as Error)?.message ?? String(err),
        ...(wheelhouse ? { wheelhouse } : {}),
      })
    }

    // Wait for a usable answer. A cancelled folder dialog is not an answer: the
    // error stays on screen and we keep listening.
    for (;;) {
      const answer = await deps.waitForAnswer()
      if (answer === 'quit') {
        deps.quit()
        throw new EnvSetupQuitError()
      }
      if (answer === 'retry') break
      if (answer === 'use-wheelhouse') {
        const dir = await deps.pickFolder()
        if (!dir) continue
        wheelhouse = dir
        break
      }
    }
  }
}

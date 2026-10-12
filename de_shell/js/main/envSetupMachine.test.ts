/**
 * envSetupMachine.test.ts — the first-run setup conversation, with a scripted
 * resolver and renderer standing in for uv and the overlay.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  createProgressBatcher, runEnvSetupMachine, EnvSetupQuitError,
} from './envSetupMachine.ts'
import type { EnvSetupAnswer, EnvSetupWireMessage } from './envSetupMachine.ts'

/** A manual clock + timer so batching is deterministic. */
function fakeClock() {
  let t = 1_000
  let pending: { fn: () => void; at: number } | null = null
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { pending = { fn, at: t + ms }; return pending },
    clearTimer: () => { pending = null },
    advance(ms: number) {
      t += ms
      if (pending && pending.at <= t) { const p = pending; pending = null; p.fn() }
    },
  }
}

describe('progress batching', () => {
  test('the first chunk goes out at once, later ones coalesce until the interval', () => {
    const clock = fakeClock()
    const out: EnvSetupWireMessage[] = []
    const b = createProgressBatcher({ emit: m => out.push(m), intervalMs: 100, ...clock })
    b.push('Resolved 10 packages\n')
    assert.equal(out.length, 1)
    b.push('Downloading torch (825.0 MiB)\n')
    b.push('torch  ====>  100.0 MiB/825.0 MiB\r')
    assert.equal(out.length, 1, 'throttled')
    clock.advance(100)
    assert.equal(out.length, 2)
    assert.equal(out[1].line, 'Downloading torch (825.0 MiB)\ntorch  ====>  100.0 MiB/825.0 MiB')
    // The newest classified event wins, carrying the measured percent.
    assert.equal(out[1].event?.percent, 12)
    assert.equal(out[1].state, 'progress')
  })

  test('flush drains the pending batch and blank chunks emit nothing', () => {
    const clock = fakeClock()
    const out: EnvSetupWireMessage[] = []
    const b = createProgressBatcher({ emit: m => out.push(m), ...clock })
    b.push('Resolved 1 package\n')
    b.push('\r\n \n')
    b.push('Installed 1 package\n')
    b.flush()
    assert.equal(out.length, 2)
    b.flush()
    assert.equal(out.length, 2, 'nothing left to flush')
  })

  test('a burst is capped so one IPC cannot balloon', () => {
    const clock = fakeClock()
    const out: EnvSetupWireMessage[] = []
    const b = createProgressBatcher({ emit: m => out.push(m), intervalMs: 100, ...clock })
    b.push('first\n')
    b.push(Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'))
    b.flush()
    assert.equal(out[1].line!.split('\n').length, 40)
    assert.ok(out[1].line!.endsWith('l499'), 'keeps the newest lines')
  })
})

/** Build deps whose run() outcomes and renderer answers are scripted. */
function scripted(outcomes: Array<'ok' | Error>, answers: EnvSetupAnswer[], folders: Array<string | null> = []) {
  const emitted: EnvSetupWireMessage[] = []
  const runs: Array<string | null> = []
  let quit = 0
  return {
    emitted, runs, get quit() { return quit },
    deps: {
      intervalMs: 0,
      run: async (wh: string | null, onProgress: (c: string) => void) => {
        runs.push(wh)
        onProgress('Resolved 3 packages\n')
        const o = outcomes.shift()!
        if (o !== 'ok') throw o
        return { cmd: ['python'], cwd: '/x' }
      },
      emit: (m: EnvSetupWireMessage) => emitted.push(m),
      waitForAnswer: async () => answers.shift()!,
      pickFolder: async () => folders.shift() ?? null,
      quit: () => { quit++ },
    },
  }
}

const states = (s: { emitted: EnvSetupWireMessage[] }) => s.emitted.map(m => m.state)

describe('the setup state machine', () => {
  test('success: start, progress, done, and resolves with the result', async () => {
    const s = scripted(['ok'], [])
    const r = await runEnvSetupMachine(s.deps)
    assert.deepEqual(r, { cmd: ['python'], cwd: '/x' })
    assert.deepEqual(states(s), ['start', 'progress', 'done'])
  })

  test('failure does not reject: it reports the error and retry runs again', async () => {
    const s = scripted([new Error('network down'), 'ok'], ['retry'])
    await runEnvSetupMachine(s.deps)
    assert.deepEqual(states(s), ['start', 'progress', 'error', 'start', 'progress', 'done'])
    const err = s.emitted.find(m => m.state === 'error')!
    assert.equal(err.message, 'network down')
    assert.deepEqual(s.runs, [null, null])
  })

  test('the last uv lines reach the renderer before the error', async () => {
    const s = scripted([new Error('boom')], ['quit'])
    await assert.rejects(runEnvSetupMachine(s.deps), EnvSetupQuitError)
    const i = s.emitted.findIndex(m => m.state === 'error')
    assert.equal(s.emitted[i - 1].state, 'progress')
  })

  test('use-wheelhouse re-runs with the picked folder', async () => {
    const s = scripted([new Error('offline'), 'ok'], ['use-wheelhouse'], ['D:/wheels'])
    await runEnvSetupMachine(s.deps)
    assert.deepEqual(s.runs, [null, 'D:/wheels'])
    const restart = s.emitted.filter(m => m.state === 'start')[1]
    assert.equal(restart.wheelhouse, 'D:/wheels')
  })

  test('a cancelled folder dialog keeps waiting rather than re-running', async () => {
    const s = scripted([new Error('offline'), 'ok'], ['use-wheelhouse', 'retry'], [null])
    await runEnvSetupMachine(s.deps)
    assert.deepEqual(s.runs, [null, null])
    assert.equal(s.emitted.filter(m => m.state === 'error').length, 1)
  })

  test('a chosen wheelhouse sticks for later retries', async () => {
    const s = scripted(
      [new Error('a'), new Error('b'), 'ok'], ['use-wheelhouse', 'retry'], ['D:/w'])
    await runEnvSetupMachine(s.deps)
    assert.deepEqual(s.runs, [null, 'D:/w', 'D:/w'])
  })

  test('quit calls quit() once and rejects with EnvSetupQuitError', async () => {
    const s = scripted([new Error('x')], ['quit'])
    await assert.rejects(runEnvSetupMachine(s.deps), EnvSetupQuitError)
    assert.equal(s.quit, 1)
  })

  test('an app-supplied initial wheelhouse is used on the first run', async () => {
    const s = scripted(['ok'], [])
    await runEnvSetupMachine({ ...s.deps, initialWheelhouse: 'E:/offline' })
    assert.deepEqual(s.runs, ['E:/offline'])
  })
})

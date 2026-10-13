/**
 * shellModels.test.ts — the pure models behind the update card/dialog, the
 * report dialog and the env-setup overlay, plus the env_setup message path
 * through shellReducer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { updateCardModel, updateDialogModel } from './updateModel.ts'
import { canSubmit, countProblems, outcomeModel, submitLabel } from './reportModel.ts'
import { logTail, phasePills, stepText } from './envSetupView.ts'
import { shellInitialState, shellReducer, toShellAction } from './shellState.ts'

test('card: idle and up-to-date show nothing, errors always show with Retry', () => {
  assert.equal(updateCardModel({ state: 'idle' }, 'App').visible, false)
  assert.equal(updateCardModel({ state: 'not-available' }, 'App').visible, false)
  const err = updateCardModel({ state: 'error', message: 'offline' }, 'App')
  assert.equal(err.visible, true)
  assert.equal(err.action, 'retry')
  assert.equal(err.error, 'offline')
})

test('card: dismissed or dialog-open hides it; names come from the app name', () => {
  const s = { state: 'available', version: '2.0.0', releaseNotes: 'fixes' } as const
  const m = updateCardModel(s, 'Ground Crew')
  assert.equal(m.title, 'Ground Crew 2.0.0 is available')
  assert.equal(m.action, 'download')
  assert.equal(m.notes, 'fixes')
  assert.equal(updateCardModel(s, 'X', { dismissed: true }).visible, false)
  assert.equal(updateCardModel(s, 'X', { dialogOpen: true }).visible, false)
})

test('card: download percent is clamped', () => {
  assert.equal(updateCardModel({ state: 'downloading', percent: 140 }, 'A').percent, 100)
  assert.equal(updateCardModel({ state: 'downloading', percent: NaN }, 'A').percent, 0)
})

test('dialog: unsupported builds get no actions; busy states disable Check', () => {
  assert.equal(updateDialogModel({ state: 'idle' }, 'A', false).action, null)
  const busy = updateDialogModel({ state: 'checking' }, 'A', true)
  assert.deepEqual([busy.action, busy.actionDisabled], ['check', true])
  assert.equal(updateDialogModel({ state: 'downloaded', version: '1' }, 'A', true).action, 'restart')
  assert.equal(updateDialogModel({ state: 'error', message: 'm' }, 'A', true).tone, 'error')
})

test('report: submit gating, labels, outcome wording', () => {
  assert.equal(canSubmit('  ', 'writing'), false)
  assert.equal(canSubmit('bug', 'sending'), false)
  assert.equal(canSubmit('bug', 'writing'), true)
  assert.equal(submitLabel('writing', false), 'Save Report')
  assert.equal(submitLabel('writing', true), 'Send Report')
  assert.equal(countProblems({ problems: [1, 2] }), 2)
  assert.equal(countProblems({ problems: 'x' }), 0)
  assert.equal(countProblems(null), 0)
  const offline = outcomeModel({ sent: false, error: 'no service', bundlePath: '/r' }, false)
  assert.equal(offline.headline, 'Report saved on this computer.')
  assert.equal(offline.error, null, 'a build that never tried to send reports no failure')
  const failed = outcomeModel({ sent: false, error: 'timeout' }, true)
  assert.equal(failed.error, 'timeout')
  assert.equal(outcomeModel({ sent: true, eventId: 'abc' }, true).eventId, 'abc')
})

test('env overlay: pills, step text, log tail', () => {
  assert.deepEqual(phasePills('torch').map(p => p.state),
    ['done', 'done', 'active', 'todo', 'todo'])
  assert.equal(phasePills('working')[0].state, 'active')
  assert.equal(stepText({ step: 'Downloading torch', percent: 41.6 }), 'Downloading torch — 42%')
  assert.equal(stepText({ step: 'Resolving', percent: null }), 'Resolving…')
  assert.deepEqual(logTail(['a\n', '', 'b', 'c'], 2), ['b', 'c'])
})

test('env_setup messages from runEnvSetup flow through the shell reducer', () => {
  const act = (m: Record<string, unknown>) => toShellAction({ type: 'env_setup', ...m })!
  let s = shellReducer(shellInitialState, act({ state: 'start' }))
  s = shellReducer(s, act({
    state: 'progress', line: 'a\nb',
    event: { phase: 'torch', step: 'Downloading PyTorch', percent: 7 },
  }))
  assert.deepEqual(s.envSetup!.lines, ['a', 'b'])
  assert.equal(s.envSetup!.phase, 'torch')
  assert.equal(s.envSetup!.percent, 7)
  s = shellReducer(s, act({ state: 'error', message: 'offline' }))
  assert.equal(s.envSetup!.error, 'offline')
  assert.equal(s.envSetup!.step, 'Downloading PyTorch', 'the error keeps its context')
  // A retry starts clean: the error is gone.
  s = shellReducer(s, act({ state: 'start', wheelhouse: 'D:/w' }))
  assert.equal(s.envSetup!.error, null)
  assert.equal(s.envSetup!.wheelhouse, 'D:/w')
  s = shellReducer(s, act({ state: 'done' }))
  assert.equal(s.envSetup, null)
})

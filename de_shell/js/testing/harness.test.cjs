/**
 * harness.test.cjs — node:test unit tests for the harness's failure paths.
 *
 * Two teardown/startup behaviours learned the hard way:
 *
 *   1. A window that never appears must fail with the BACKEND LOG attached —
 *      Playwright's bare "firstWindow timeout" hides the uv/env error that
 *      caused it.
 *   2. `app.close()` can wedge (a backend stuck mid-compute holds quit up), and
 *      a wedged close leaves the Electron tree alive holding the DE Server's
 *      single connection — so teardown needs a deadline and a hard tree-kill.
 *
 * Run: `node --test src/harness.test.cjs` (from packages/shell-testing/), or
 * via the `test:unit` npm script.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, existsSync, writeFileSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')
const { firstWindowWithLog, closeApp } = require('./harness.cjs')

test('a missing first window reports the backend log, not a bare timeout', async () => {
  const app = {
    firstWindow: async () => { throw new Error('Timeout 60000ms exceeded.') },
  }
  const logBuffer = ['[env-setup] running full locked uv sync',
                     'error: uv exploded for reasons']
  await assert.rejects(
    () => firstWindowWithLog(app, logBuffer, 60_000),
    (err) => {
      assert.match(err.message, /window/i)
      assert.match(err.message, /uv exploded for reasons/,
        'the backend log tail is missing from the failure')
      return true
    },
  )
})

test('a clean close does not kill anything', async () => {
  const killed = []
  const app = {
    process: () => ({ pid: 4242 }),
    close: async () => {},
  }
  const outcome = await closeApp(app, { timeout: 1000, killTree: (pid) => killed.push(pid) })
  assert.equal(outcome, 'closed')
  assert.deepEqual(killed, [])
})

test('a wedged close is hard-killed at the deadline', async () => {
  const killed = []
  const app = {
    process: () => ({ pid: 4242 }),
    close: () => new Promise(() => {}),   // never resolves — the wedge
  }
  const outcome = await closeApp(app, { timeout: 100, killTree: (pid) => killed.push(pid) })
  assert.equal(outcome, 'killed')
  assert.deepEqual(killed, [4242])
})

test('a close that rejects still hard-kills the tree', async () => {
  const killed = []
  const app = {
    process: () => ({ pid: 4242 }),
    close: async () => { throw new Error('target closed') },
  }
  const outcome = await closeApp(app, { timeout: 1000, killTree: (pid) => killed.push(pid) })
  assert.equal(outcome, 'killed')
  assert.deepEqual(killed, [4242])
})

test('closeApp tolerates a missing app', async () => {
  assert.equal(await closeApp(null), 'noop')
  assert.equal(await closeApp(undefined), 'noop')
})

/** A stand-in for the launch's --user-data-dir, with something inside it. */
function fakeProfileDir() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-profile-'))
  writeFileSync(join(dir, 'Preferences'), '{}')
  return dir
}

test('a clean close removes the profile dir', async () => {
  const profileDir = fakeProfileDir()
  const app = { process: () => ({ pid: 4242 }), close: async () => {} }
  assert.equal(await closeApp(app, { timeout: 1000, killTree: () => {}, profileDir }), 'closed')
  assert.equal(existsSync(profileDir), false, 'profile dir left behind')
})

test('a hard-killed close removes the profile dir too', async () => {
  const profileDir = fakeProfileDir()
  const app = { process: () => ({ pid: 4242 }), close: () => new Promise(() => {}) }
  assert.equal(await closeApp(app, { timeout: 100, killTree: () => {}, profileDir }), 'killed')
  assert.equal(existsSync(profileDir), false, 'profile dir left behind')
})

test('closeApp with no app still removes the profile dir', async () => {
  const profileDir = fakeProfileDir()
  assert.equal(await closeApp(null, { profileDir }), 'noop')
  assert.equal(existsSync(profileDir), false, 'profile dir left behind')
})

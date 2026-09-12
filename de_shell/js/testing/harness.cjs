/**
 * harness.cjs — launching a shell app under Playwright, for any of the three.
 *
 * Generalised from SpyDE's electron/tests/_harness.cjs. Everything here is
 * app-agnostic; domain helpers (SpyDE's loadTestVectors, navWindow,
 * dragCrosshair) stay in the app's own test directory.
 *
 * The two things this exists to get right, both learned the hard way in SpyDE:
 *
 *   1. **Profile isolation.** Electron defaults to a per-app profile directory
 *      that a developer's `npm run dev` instance may already hold a Chromium
 *      singleton lock on. A test launched against it does not fail with a clear
 *      error — it HANGS, and Playwright reports a bare launch timeout with no
 *      hint that another process owns the directory. Every launch gets a fresh
 *      temp profile.
 *
 *   2. **Backend errors are invisible by default.** The Python side talks over
 *      the PLOTAPP stdout protocol, which the Electron main process consumes —
 *      so a backend that dies mid-test dies SILENTLY. The app's log-level env
 *      var makes it tee logging to stderr, which this captures into `logBuffer`.
 */
// The APP's Playwright, never one found beside this file. This package reaches
// an app through a symlink into a checkout that may carry its own node_modules
// (for the shell's typecheck), and Playwright refuses to be loaded twice
// ("Requiring @playwright/test second time"). Resolving from the working
// directory — the app's, when its `playwright test` runs — picks the copy the
// runner already loaded; the fallback is for a bare `node --test` here.
function appRequire(name) {
  try { return require(require.resolve(name, { paths: [process.cwd()] })) } catch { return require(name) }
}
const { _electron: electron } = appRequire('@playwright/test')
const { spawnSync } = require('child_process')
const { mkdtempSync, rmSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')

/**
 * Launch a shell app.
 *
 * @param {object} opts
 * @param {string} opts.appDir      App root (the directory holding out/main/index.js).
 * @param {string} opts.appId       Shell appId — namespaces the temp profile dir.
 * @param {string} [opts.readyLog]  Stderr/stdout substring meaning "backend up".
 * @param {string[]} [opts.readyMessages] PLOTAPP message types to wait for.
 * @param {object} [opts.env]       Extra environment for the app process.
 * @param {number} [opts.timeout]   Milliseconds to wait for the ready signals.
 */
async function launchApp(opts) {
  const {
    appDir, appId, readyLog = null, readyMessages = ['ready'],
    env = {}, timeout = 60_000,
  } = opts
  if (!appDir || !appId) throw new Error('launchApp needs { appDir, appId }')
  const profileDir = mkdtempSync(join(tmpdir(), `${appId}-e2e-profile-`))

  const app = await electron.launch({
    // Resolve Electron from the APP's tree, not Playwright's. Without an
    // explicit path, playwright-core does a bare require('electron/index.js')
    // from its own (usually root-hoisted) location — in a workspace layout
    // that can find a DIFFERENT Electron than the one the app declares (an
    // auto-installed peer once put 43 at the root while the app shipped 34,
    // and every e2e silently tested the wrong Chromium). appDir is the
    // directory holding the app's package.json, so its node_modules wins.
    executablePath: require(require.resolve('electron/index.js', { paths: [appDir] })),
    args: [
      join(appDir, 'out', 'main', 'index.js'),
      `--user-data-dir=${profileDir}`,
    ],
    env: { ...process.env, ...env },
  })

  const backend = createBackend(app)
  const page = await firstWindowWithLog(app, backend.logBuffer, timeout)

  // Surface renderer exceptions rather than letting a blank page look like a
  // slow one. Collected, not thrown, so a spec decides what is fatal.
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push(String(e)))

  if (readyLog) await backend.waitForLog(readyLog, timeout)
  for (const type of readyMessages) await backend.waitForMessage(type, timeout)

  return {
    app, page, backend, jsErrors, profileDir,
    assertNoJsErrors: () => assertNoJsErrors(jsErrors),
    close: (opts) => closeApp(app, { profileDir, ...opts }),
  }
}

/**
 * `app.firstWindow()` with an EXPLICIT timeout and the backend log attached to
 * the failure. Playwright's bare "firstWindow timeout" hides the actual cause,
 * which is almost always in the app's stderr (uv missing, env sync failed,
 * Python died on import) — the harness buffered it; say it.
 */
async function firstWindowWithLog(app, logBuffer, timeout = 60_000) {
  try {
    return await app.firstWindow({ timeout })
  } catch (e) {
    throw new Error(
      `no app window appeared within ${timeout}ms (${e.message}) — ` +
      'the main process likely failed before creating it.\n' +
      `last 40 log lines:\n${logBuffer.slice(-40).join('\n')}`)
  }
}

/**
 * Close the app with a DEADLINE, then hard-kill the whole process tree if the
 * close wedged. A backend stuck mid-compute can hold `app.close()` up past the
 * runner's timeout, leaving an Electron tree alive that (for a DE app) still
 * owns the server's single connection — every later launch then hangs on a
 * connection that cannot be made. Returns 'closed' | 'killed' | 'noop' so a
 * caller can log what teardown actually did. `opts.profileDir` (the launch's
 * temp profile) is removed once the process is down, on every path.
 */
async function closeApp(app, opts = {}) {
  const { timeout = 15_000, killTree = hardKillTree, profileDir = null } = opts
  try {
    if (!app) return 'noop'
    const pid = app.process()?.pid
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout)
      timer.unref?.()
      Promise.resolve()
        .then(() => app.close())
        .then(() => { clearTimeout(timer); resolve(true) },
              () => { clearTimeout(timer); resolve(false) })
    })
    if (closed) return 'closed'
    if (pid) killTree(pid)
    return pid ? 'killed' : 'noop'
  } finally {
    if (profileDir) removeProfileDir(profileDir)
  }
}

/** Remove a launch's temp profile. Retries cover a handle Chromium is still
 *  letting go of on Windows; a directory that still will not go is left for the
 *  OS rather than failing the spec's teardown. */
function removeProfileDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch { /* left behind; not the spec's failure */ }
}

/** Force-kill `pid` AND everything under it (the Python sidecar and its
 *  workers ride below the Electron root). */
function hardKillTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch { /* already gone */ }
}

/** Buffer the app process's stdio and expose waiters over it. */
function createBackend(app) {
  const logBuffer = []
  const waiters = []

  const push = (text) => {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue
      logBuffer.push(line)
      for (const w of waiters.slice()) {
        if (w.test(line)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(line)
        }
      }
    }
  }

  app.process().stdout?.on('data', (d) => push(d.toString()))
  app.process().stderr?.on('data', (d) => push(d.toString()))

  /** Resolve when a line contains `substr` — including lines already buffered,
   *  so a caller that starts waiting late does not miss it. */
  function waitForLog(substr, timeout = 60_000) {
    const hit = logBuffer.find((l) => l.includes(substr))
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { test: (l) => l.includes(substr), resolve }
      waiters.push(w)
      setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) {
          waiters.splice(i, 1)
          reject(new Error(
            `timed out waiting for log ${JSON.stringify(substr)}\n` +
            `last 40 lines:\n${logBuffer.slice(-40).join('\n')}`))
        }
      }, timeout)
    })
  }

  /** Resolve when a PLOTAPP message of `type` is emitted. */
  function waitForMessage(type, timeout = 60_000) {
    return waitForLog(`"type": "${type}"`, timeout).catch(() =>
      waitForLog(`"type":"${type}"`, timeout))
  }

  return { logBuffer, waitForLog, waitForMessage, errorLines: () => errorLines(logBuffer) }
}

/** Lines that look like a Python failure. Used to fail a spec loudly rather than
 *  letting a broken backend read as a slow one. */
function errorLines(logBuffer) {
  return logBuffer.filter((l) =>
    /Traceback|ModuleNotFoundError|ImportError|Fatal Python error|ERROR/.test(l))
}

function assertNoJsErrors(jsErrors) {
  if (jsErrors.length) {
    throw new Error('renderer JS errors:\n' + jsErrors.join('\n'))
  }
}

/**
 * Count pixels in every <canvas> on the page (figures live in iframes, so this
 * walks all frames).
 *
 * `kind` is 'bright' | 'red' | 'green'. Anything else counts NOTHING and would
 * make an assertion pass vacuously — so unknown kinds throw instead.
 */
async function countColorPixels(page, kind) {
  const KINDS = ['bright', 'red', 'green']
  if (!KINDS.includes(kind)) {
    throw new Error(`countColorPixels: unknown kind ${JSON.stringify(kind)} (use ${KINDS.join('|')})`)
  }
  let total = 0
  for (const frame of page.frames()) {
    try {
      total += await frame.evaluate((k) => {
        let n = 0
        for (const c of Array.from(document.querySelectorAll('canvas'))) {
          const ctx = c.getContext('2d')
          if (!ctx || !c.width || !c.height) continue
          const d = ctx.getImageData(0, 0, c.width, c.height).data
          for (let p = 0; p < d.length; p += 4) {
            const r = d[p], g = d[p + 1], b = d[p + 2]
            if (k === 'bright' && (r > 30 || g > 30 || b > 30)) n++
            if (k === 'red' && r > 120 && g < 90 && b < 90) n++
            if (k === 'green' && g > 150 && r < 130 && b > 50 && b < 170) n++
          }
        }
        return n
      }, kind)
    } catch { /* frame detached mid-evaluate */ }
  }
  return total
}

module.exports = {
  launchApp, createBackend, countColorPixels, assertNoJsErrors, errorLines,
  firstWindowWithLog, closeApp, hardKillTree, removeProfileDir,
}

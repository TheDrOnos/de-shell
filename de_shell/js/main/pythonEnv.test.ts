/**
 * pythonEnv.test.ts — node:test unit tests for uv resolution.
 *
 * The dev-mode backend command used to be a bare 'uv', resolved by the OS at
 * spawn time — so a uv that is installed but not on the app's PATH (the winget
 * per-user install under an npm-run environment, the recurring case) failed as
 * an opaque `spawn uv ENOENT`. `findUv` resolves uv to an absolute path up
 * front: the PATH itself first, then the standard per-user install locations.
 *
 * Run: `node --test src/pythonEnv.test.ts` (from packages/shell-main/), or via
 * the `test:unit` npm script.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { configureShell } from './config.ts'
import { findUv, resolvePythonEnv } from './pythonEnv.ts'

configureShell({
  appId: 'testapp',
  appName: 'Test App',
  pythonModule: 'testapp',
})

/** Every temp directory these tests make, removed when the file is done. */
const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A directory containing a uv stub under both spellings, so these tests do not
 *  fork on the host platform. */
function dirWithUv(): string {
  const dir = tempDir('uv-stub-')
  writeFileSync(join(dir, 'uv'), '')
  writeFileSync(join(dir, 'uv.exe'), '')
  return dir
}

function emptyDir(): string {
  return tempDir('uv-none-')
}

/** An env whose PATH and every fallback root point somewhere we control. */
function envWith(overrides: Record<string, string>): Record<string, string> {
  const nowhere = emptyDir()
  return {
    PATH: '',
    HOME: nowhere,
    USERPROFILE: nowhere,
    LOCALAPPDATA: nowhere,
    ...overrides,
  }
}

test('findUv resolves uv from a PATH entry', () => {
  const dir = dirWithUv()
  const found = findUv(envWith({ PATH: dir }))
  assert.ok(found, 'uv not found on PATH')
  assert.ok(found.startsWith(dir), `${found} is not under ${dir}`)
})

test('findUv falls back to the standard per-user install dirs off PATH', () => {
  const home = emptyDir()
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(home, '.local', 'bin', 'uv'), '')
  writeFileSync(join(home, '.local', 'bin', 'uv.exe'), '')
  const found = findUv(envWith({ HOME: home, USERPROFILE: home }))
  assert.ok(found, 'uv not found in ~/.local/bin')
  assert.ok(found.startsWith(join(home, '.local', 'bin')))
})

test('findUv finds a winget-linked uv via LOCALAPPDATA', () => {
  const localAppData = emptyDir()
  const links = join(localAppData, 'Microsoft', 'WinGet', 'Links')
  mkdirSync(links, { recursive: true })
  writeFileSync(join(links, 'uv'), '')
  writeFileSync(join(links, 'uv.exe'), '')
  const found = findUv(envWith({ LOCALAPPDATA: localAppData }))
  assert.ok(found, 'uv not found in the winget Links dir')
  assert.ok(found.startsWith(links))
})

test('findUv returns null when uv is nowhere', () => {
  assert.equal(findUv(envWith({})), null)
})

test('dev-mode resolvePythonEnv spawns the resolved absolute uv', async () => {
  const dir = dirWithUv()
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME,
                  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA }
  try {
    Object.assign(process.env, envWith({ PATH: dir }))
    const resolved = await resolvePythonEnv({
      isPackaged: false,
      resourcesPath: emptyDir(),
      projectRoot: emptyDir(),
      userData: emptyDir(),
    })
    assert.ok(resolved.cmd[0].startsWith(dir),
      `expected an absolute uv under ${dir}, got ${resolved.cmd[0]}`)
    assert.deepEqual(resolved.cmd.slice(1), ['run', 'python', '-m', 'testapp'])
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('dev-mode resolvePythonEnv leaves a bare uv when none is found (the spawn trap reports it)', async () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME,
                  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA }
  try {
    Object.assign(process.env, envWith({}))
    const resolved = await resolvePythonEnv({
      isPackaged: false,
      resourcesPath: emptyDir(),
      projectRoot: emptyDir(),
      userData: emptyDir(),
    })
    assert.equal(resolved.cmd[0], 'uv')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

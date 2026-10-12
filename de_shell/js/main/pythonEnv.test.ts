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
import {
  findUv, resolvePythonEnv, hasNvidiaGpu, readWheelhouse, findWheelhouse,
  wheelhouseCandidates, lockStamp, buildSyncArgs, offlinePlan, effectiveExtras,
  gpuEnvOverride, platformMatches, fileUrl, checkWheelhouseExtras, venvPython,
} from './pythonEnv.ts'

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

// ── extras, GPU probe, stamp ─────────────────────────────────────────────────

test('lockStamp is the bare hash with no extras (existing installs do not re-sync)', () => {
  assert.equal(lockStamp('abc', []), 'abc')
})

test('lockStamp appends sorted extras, order-insensitively', () => {
  assert.equal(lockStamp('abc', ['gpu', 'cuda']), 'abc+extras=cuda,gpu')
  assert.equal(lockStamp('abc', ['cuda', 'gpu']), lockStamp('abc', ['gpu', 'cuda']))
})

test('effectiveExtras adds gpuExtras only with a GPU, de-duplicated', () => {
  assert.deepEqual(effectiveExtras(['a'], ['gpu'], false), ['a'])
  assert.deepEqual(effectiveExtras(['a'], ['gpu'], true), ['a', 'gpu'])
  assert.deepEqual(effectiveExtras(['gpu'], ['gpu'], true), ['gpu'])
  assert.deepEqual(effectiveExtras(undefined, undefined, true), [])
})

test('buildSyncArgs passes --extra for each extra, torch skip last', () => {
  assert.deepEqual(
    buildSyncArgs(['--no-install-project'], ['gpu', 'x'], ['torch']),
    ['sync', '--frozen', '--no-dev', '--no-install-project',
     '--extra', 'gpu', '--extra', 'x', '--no-install-package', 'torch'])
  assert.deepEqual(buildSyncArgs([], []), ['sync', '--frozen', '--no-dev'])
})

const runner = (code: number | null, stdout = '') => async () => ({ code, stdout })

test('hasNvidiaGpu parses nvidia-smi -L output', async () => {
  assert.equal(await hasNvidiaGpu(runner(0, 'GPU 0: NVIDIA RTX A4000 (UUID: GPU-1)\n')), true)
  assert.equal(await hasNvidiaGpu(runner(0, '')), false)
  assert.equal(await hasNvidiaGpu(runner(0, 'No devices were found')), false)
  assert.equal(await hasNvidiaGpu(runner(9, 'GPU 0: x')), false)
  assert.equal(await hasNvidiaGpu(runner(null)), false)
})

test('hasNvidiaGpu never throws and asks for a ~5 s timeout', async () => {
  assert.equal(await hasNvidiaGpu(async () => { throw new Error('ENOENT') }), false)
  let seen: unknown[] = []
  await hasNvidiaGpu(async (cmd, args, t) => { seen = [cmd, args, t]; return { code: 1, stdout: '' } })
  assert.deepEqual(seen, ['nvidia-smi', ['-L'], 5000])
})

test('gpuEnvOverride reads <APPID>_GPU', () => {
  assert.equal(gpuEnvOverride({ TESTAPP_GPU: '0' }), false)
  assert.equal(gpuEnvOverride({ TESTAPP_GPU: '1' }), true)
  assert.equal(gpuEnvOverride({ TESTAPP_GPU: '' }), undefined)
  assert.equal(gpuEnvOverride({}), undefined)
})

// ── wheelhouse ───────────────────────────────────────────────────────────────

function wheelhouseDir(manifest: unknown): string {
  const dir = tempDir('wheelhouse-')
  writeFileSync(join(dir, 'wheelhouse.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return dir
}

const goodManifest = {
  app: 'testapp', version: '1.2.3', platform: 'win_amd64', python: '3.13.12', extras: ['gpu'],
}

test('readWheelhouse parses a valid manifest', () => {
  assert.deepEqual(readWheelhouse(wheelhouseDir(goodManifest)), goodManifest)
})

test('readWheelhouse is null for missing, unparseable, or foreign manifests', () => {
  assert.equal(readWheelhouse(emptyDir()), null)
  assert.equal(readWheelhouse(wheelhouseDir('{not json')), null)
  assert.equal(readWheelhouse(wheelhouseDir({ ...goodManifest, app: 'other' })), null)
})

test('findWheelhouse returns the first valid directory', () => {
  const a = wheelhouseDir({ ...goodManifest, app: 'other' })
  const b = wheelhouseDir(goodManifest)
  const c = wheelhouseDir({ ...goodManifest, version: '9' })
  const found = findWheelhouse([emptyDir(), a, b, c])
  assert.equal(found?.dir, b)
  assert.equal(found?.manifest.version, '1.2.3')
  assert.equal(findWheelhouse([emptyDir()]), null)
})

test('wheelhouseCandidates are ordered option, env, resources, userData, exec dir', () => {
  const got = wheelhouseCandidates(
    { wheelhouse: '/opt', resourcesPath: '/res', userData: '/ud' },
    { TESTAPP_WHEELHOUSE: '/env' },
    join('/bin', 'app.exe'),
  )
  assert.deepEqual(got, ['/opt', '/env', join('/res', 'wheelhouse'),
    join('/ud', 'wheelhouse'), join('/bin', 'wheelhouse')])
  // Unset option / env are skipped, not left as holes.
  assert.deepEqual(
    wheelhouseCandidates({ wheelhouse: null, resourcesPath: '/res', userData: '/ud' }, {}, '/bin/app'),
    [join('/res', 'wheelhouse'), join('/ud', 'wheelhouse'), join('/bin', 'wheelhouse')])
})

test('platformMatches is loose but os/arch aware', () => {
  assert.equal(platformMatches('win_amd64', 'win32', 'x64'), true)
  assert.equal(platformMatches('win_amd64', 'linux', 'x64'), false)
  assert.equal(platformMatches('manylinux_2_28_x86_64', 'linux', 'x64'), true)
  assert.equal(platformMatches('macosx_11_0_arm64', 'darwin', 'arm64'), true)
  assert.equal(platformMatches('macosx_11_0_arm64', 'darwin', 'x64'), false)
})

test('fileUrl uses forward slashes with a three-slash drive form', () => {
  assert.equal(fileUrl('C:\\wh\\python'), 'file:///C:/wh/python')
  assert.equal(fileUrl('/wh/python'), 'file:///wh/python')
})

test('offlinePlan builds the python, venv, export, pip-install sequence', () => {
  const plan = offlinePlan({
    wheelhouse: join('/wh'), manifest: { python: '3.13.12' },
    envDir: join('/ud', 'python-env'), userData: '/ud', extras: ['gpu'],
  })
  assert.equal(plan.env.UV_OFFLINE, '1')
  assert.equal(plan.env.UV_PYTHON_DOWNLOADS, 'automatic')
  assert.ok(plan.env.UV_PYTHON_INSTALL_MIRROR.startsWith('file://'))
  assert.ok(plan.env.UV_PYTHON_INSTALL_MIRROR.endsWith('/python'))
  assert.deepEqual(plan.python, ['python', 'install', '3.13.12'])
  assert.deepEqual(plan.venv, ['venv', '--python', '3.13.12', '--managed-python',
    '--allow-existing', join('/ud', 'python-env')])
  assert.deepEqual(plan.export.slice(0, 7),
    ['export', '--frozen', '--no-dev', '--no-emit-project', '--no-emit-workspace',
     '--extra', 'gpu'])
  assert.equal(plan.export.at(-1), plan.requirementsFile)
  assert.equal(plan.requirementsFile, join('/ud', 'requirements.offline.txt'))
  for (const flag of ['--offline', '--no-index', '--require-hashes']) {
    assert.ok(plan.install.includes(flag), flag)
  }
  assert.equal(plan.install[plan.install.indexOf('--find-links') + 1], join('/wh'))
  assert.equal(plan.install[plan.install.indexOf('-r') + 1], plan.requirementsFile)
  assert.equal(plan.install.at(-1), venvPython(join('/ud', 'python-env')))
})

test('checkWheelhouseExtras names the missing extra', () => {
  const m = { ...goodManifest, extras: [] }
  assert.throws(() => checkWheelhouseExtras(['gpu'], m), /built without the 'gpu' extra/)
  checkWheelhouseExtras([], m)   // gpu disabled → not effective → fine
  checkWheelhouseExtras(['gpu'], goodManifest)
})

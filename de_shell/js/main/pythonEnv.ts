/**
 * pythonEnv.ts — resolve (and on first run, create) the Python sidecar env.
 *
 * The uv-managed distribution model: the installer ships a tiny
 * payload — the bundled `uv`, the project (`pyproject.toml` + `uv.lock`) and the
 * app's Python source — under <resources>/python. On first launch we run
 * `uv sync` into a venv in the user's WRITABLE data dir (the app bundle is
 * read-only / code-signed), so the GPU-correct torch wheel is fetched per
 * machine and updates are a cheap incremental `uv sync`.
 *
 * torch is resolved PER MACHINE (win32/linux): the lock pins torch to the cu124
 * index (the dev box's backend), which would force the cu124 wheel onto every
 * user. Instead the first-run install is two-step:
 *   1. `uv sync --frozen --no-dev --no-install-package torch`  (lock-exact for
 *      everything EXCEPT torch)
 *   2. `uv pip install torch==<locked release> --torch-backend=auto
 *       --python <env python>`  (uv probes the machine's driver and picks the
 *      matching CUDA / CPU wheel — verified: `--python` is required, uv pip
 *      IGNORES UV_PROJECT_ENVIRONMENT; needs uv >= 0.5, the staged uv is 0.10.x)
 * Any step-2 failure falls back to the plain full `uv sync` (the old cu124
 * path), so the working install path can never regress. macOS keeps the plain
 * sync (no CUDA pin there; PyPI torch already carries MPS).
 *
 * Extras: `ShellConfig.pythonExtras` are always installed (`--extra X`) and
 * `gpuExtras` only when an NVIDIA GPU is found (`hasNvidiaGpu`). The effective
 * extras are folded into the lock stamp, so gaining a GPU or adding an extra
 * re-syncs while an app with no extras keeps its bare-hash stamp (no re-sync on
 * upgrade).
 *
 * Offline: when a WHEELHOUSE (see `readWheelhouse`) is found, the network is not
 * touched at all — see `offlinePlan` for why this is venv + export + pip install
 * rather than `uv sync`.
 *
 * No residue: every packaged uv call pins `UV_PYTHON_INSTALL_DIR` under
 * userData, so uv's managed interpreters do not land in %APPDATA%\uv\python,
 * turns off uv's ~/.local/bin launchers and registry entries, and requires a
 * managed interpreter so the env never links to a Python the app does not own.
 *
 * In development (no bundled payload) we fall back to `uv run` from the repo
 * root — exactly the previous behaviour.
 */
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
// Extension spelled out so node:test can load this module without a bundler
// (native type-stripping resolves relative imports literally).
import { envPrefix, shellConfig } from './config.ts'

export interface ResolvedPython {
  cmd: string[]      // argv to spawn, e.g. [pythonExe, '-m', 'spyde']  (module from ShellConfig)
  cwd: string        // working directory for the spawn
}

export interface EnsureOptions {
  isPackaged: boolean
  resourcesPath: string   // process.resourcesPath (packaged) — holds <…>/python
  projectRoot: string     // repo root (dev) — holds pyproject.toml
  userData: string        // app.getPath('userData') — writable venv lives here
  onProgress?: (line: string) => void
  /** Force the GPU decision (true = add `gpuExtras`, false = never), skipping
   *  the `nvidia-smi` probe. Beats the `<APPID>_GPU` env var. */
  gpu?: boolean
  /** Explicit wheelhouse directory for an offline install; first candidate
   *  (see `wheelhouseCandidates`). null/undefined = search the defaults. */
  wheelhouse?: string | null
}

const isWin = process.platform === 'win32'

export function venvPython(envDir: string): string {
  return isWin ? join(envDir, 'Scripts', 'python.exe') : join(envDir, 'bin', 'python')
}

function uvBinaryName(): string {
  return isWin ? 'uv.exe' : 'uv'
}

/**
 * Resolve uv to an ABSOLUTE path: each PATH entry first, then the standard
 * per-user install locations that a spawned app's PATH routinely misses —
 * winget's Links dir (win32), `~/.local/bin` (uv's own installer) and
 * `~/.cargo/bin` (cargo installs). Returns null when uv is nowhere; the caller
 * keeps the bare 'uv' so the spawn-error trap reports the absence readably
 * instead of this module deciding startup policy.
 *
 * `env` is injectable for tests; both binary spellings are tried on every
 * platform so the resolution logic itself stays platform-agnostic.
 */
export function findUv(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = ['uv.exe', 'uv']
  const pathVar = env.PATH ?? env.Path ?? ''
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const candidates = [
    ...pathVar.split(isWin ? ';' : ':').filter(Boolean),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')] : []),
    ...(home ? [join(home, '.local', 'bin'), join(home, '.cargo', 'bin')] : []),
  ]
  for (const dir of candidates) {
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** Paths of the bundled project + managed env, and whether each exists — the
 *  single "is there a managed environment?" answer, shared by the first-run
 *  setup and the GPU-triage Fix handler (index.ts). In dev there is no bundled
 *  payload, so `bundled` is false and the triage UI goes report-only. */
export function managedEnvPaths(resourcesPath: string, userData: string): {
  projectDir: string
  envDir: string
  pythonExe: string
  bundled: boolean
  envExists: boolean
} {
  const projectDir = join(resourcesPath, 'python')
  const envDir = join(userData, 'python-env')
  const pythonExe = venvPython(envDir)
  return {
    projectDir,
    envDir,
    pythonExe,
    bundled: existsSync(join(projectDir, 'uv.lock')),
    envExists: existsSync(pythonExe),
  }
}

/**
 * The locked torch release for THIS platform, parsed from `<projectDir>/uv.lock`.
 *
 * The lock carries TWO torch entries (platform-conditional sources): the
 * `download.pytorch.org/whl/cu124` one (win32 per pyproject's source marker,
 * e.g. "2.6.0+cu124") and the PyPI one (everything else, e.g. "2.13.0"). Pick
 * the entry whose source matches this platform and strip any `+cuXXX` local
 * tag — `--torch-backend=auto` owns the backend variant; we only pin the
 * release so the resolved wheel stays lock-adjacent. torch is the ONLY
 * torch-family package in the lock (no torchvision/torchaudio), so one
 * `--no-install-package torch` + one pip install covers the family. Returns
 * null when the lock is missing/unparseable (caller uses the plain full sync).
 */
export function readLockedTorchVersion(projectDir: string): string | null {
  const lock = readSafe(join(projectDir, 'uv.lock'))
  if (!lock) return null
  // Each entry: [[package]] \n name = "torch" \n version = "…" \n source = { registry = "…" }
  const re = /\[\[package\]\]\s*\r?\nname = "torch"\s*\r?\nversion = "([^"]+)"\s*\r?\nsource = \{ registry = "([^"]+)" \}/g
  const entries: Array<{ version: string; registry: string }> = []
  for (let m = re.exec(lock); m; m = re.exec(lock)) {
    entries.push({ version: m[1], registry: m[2] })
  }
  if (!entries.length) return null
  const preferPytorchIndex = isWin   // pyproject pins the cu124 index for win32 only
  const pick =
    entries.find((e) => preferPytorchIndex === e.registry.includes('download.pytorch.org')) ??
    entries[0]
  return pick.version.split('+')[0]   // "2.6.0+cu124" → "2.6.0"
}

// ── GPU probe ────────────────────────────────────────────────────────────────

/** Runs a command and reports its exit code + stdout. Injectable so the probe's
 *  parsing is testable without nvidia-smi. A spawn failure may reject or return
 *  code null — `hasNvidiaGpu` treats both as "no GPU". */
export type CommandRunner = (
  cmd: string, args: string[], timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>

const defaultRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: out })
    }
    let proc: ReturnType<typeof spawn>
    // A hung driver must not hang app start-up: kill after the timeout.
    const timer = setTimeout(() => { try { proc?.kill() } catch { /* gone */ } done(null) }, timeoutMs)
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch { done(null); return }
    proc.stdout?.on('data', (b: Buffer) => { out += b.toString() })
    proc.on('error', () => done(null))   // nvidia-smi absent (ENOENT) → no GPU
    proc.on('close', (code) => done(code))
  })

/**
 * Is an NVIDIA GPU usable on this machine? `nvidia-smi -L` lists one
 * `GPU 0: <name> (UUID: …)` line per device and ships with the driver, so it
 * answers "driver + device present" — the condition under which the CuPy-style
 * GPU extras can actually work. Never throws: a missing binary, non-zero exit,
 * timeout or output without a `GPU ` line is simply false (a CPU install is
 * always a safe fallback).
 */
export async function hasNvidiaGpu(run: CommandRunner = defaultRunner): Promise<boolean> {
  try {
    const { code, stdout } = await run('nvidia-smi', ['-L'], 5000)
    return code === 0 && /^GPU /m.test(stdout ?? '')
  } catch { return false }
}

/** The `<APPID>_GPU` override: '0'/'false' → false, '1'/'true' → true, else
 *  undefined (no override). */
export function gpuEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const v = (env[`${envPrefix()}_GPU`] ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return undefined
}

/** Effective extras, in config order, de-duplicated: `pythonExtras` plus
 *  `gpuExtras` when `gpu`. Pure. */
export function effectiveExtras(
  pythonExtras: string[] | undefined, gpuExtras: string[] | undefined, gpu: boolean,
): string[] {
  return [...new Set([...(pythonExtras ?? []), ...(gpu ? (gpuExtras ?? []) : [])])]
}

/**
 * The stamp written to `.<appId>-lock-hash`. With NO extras it is the bare
 * sha256 of uv.lock — byte-identical to what earlier versions wrote, so
 * upgrading de-shell does not force every existing install to re-sync. With
 * extras it is `<hash>+extras=<sorted,comma-joined>` so a new extra, or a
 * machine gaining a GPU, re-syncs (order-insensitive: config order is not
 * semantic).
 */
export function lockStamp(lockHash: string, extras: string[]): string {
  return extras.length ? `${lockHash}+extras=${[...extras].sort().join(',')}` : lockHash
}

/** `['--extra','a','--extra','b']` for `uv sync` / `uv export`. */
export function extraArgs(extras: string[]): string[] {
  return extras.flatMap((e) => ['--extra', e])
}

/** Every `uv sync` argv in one place so the torch two-step and the plain
 *  fallback cannot drift apart on extras. `skipPackages` → `--no-install-package`. */
export function buildSyncArgs(
  projectArgs: string[], extras: string[], skipPackages: string[] = [],
): string[] {
  return [
    'sync', '--frozen', '--no-dev', ...projectArgs, ...extraArgs(extras),
    ...skipPackages.flatMap((p) => ['--no-install-package', p]),
  ]
}

// ── Wheelhouse (offline install) ─────────────────────────────────────────────

/** `wheelhouse.json`, written by the wheelhouse builder. The directory beside
 *  it holds a flat set of `*.whl` plus `python/<release-tag>/<archive>`, a
 *  `uv python install` mirror. */
export interface WheelhouseManifest {
  app: string
  version: string
  platform: string   // e.g. 'win_amd64'
  python: string     // full version, e.g. '3.13.12'
  extras: string[]
}

/** Parsed manifest, or null when missing/unparseable/for another app. */
export function readWheelhouse(dir: string): WheelhouseManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'wheelhouse.json'), 'utf8'))
    if (!m || typeof m !== 'object' || m.app !== shellConfig().appId) return null
    return {
      app: m.app,
      version: String(m.version ?? ''),
      platform: String(m.platform ?? ''),
      python: String(m.python ?? ''),
      extras: Array.isArray(m.extras) ? m.extras.map(String) : [],
    }
  } catch { return null }
}

/** First candidate directory holding a valid manifest for this app. */
export function findWheelhouse(
  candidates: string[],
): { dir: string; manifest: WheelhouseManifest } | null {
  for (const dir of candidates) {
    const manifest = readWheelhouse(dir)
    if (manifest) return { dir, manifest }
  }
  return null
}

/** Where to look for a wheelhouse, most explicit first: the option, the
 *  `<APPID>_WHEELHOUSE` env var, beside the bundled payload, in userData (copied
 *  there by hand), and next to the executable (a USB-stick-style install). */
export function wheelhouseCandidates(
  opts: Pick<EnsureOptions, 'wheelhouse' | 'resourcesPath' | 'userData'>,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string[] {
  return [
    opts.wheelhouse,
    env[`${envPrefix()}_WHEELHOUSE`],
    join(opts.resourcesPath, 'wheelhouse'),
    join(opts.userData, 'wheelhouse'),
    join(dirname(execPath), 'wheelhouse'),
  ].filter((d): d is string => !!d)
}

/** Does a wheel platform tag (`win_amd64`, `manylinux_2_28_x86_64`,
 *  `macosx_11_0_arm64`) plausibly describe this machine? Deliberately loose —
 *  it only drives a warning; uv's hash check is the real guard. */
export function platformMatches(
  tag: string, platform: string = process.platform, arch: string = process.arch,
): boolean {
  const t = tag.toLowerCase()
  const osOk = platform === 'win32' ? t.startsWith('win')
    : platform === 'darwin' ? t.startsWith('macosx')
    : t.includes('linux')
  const archs: Record<string, string[]> = {
    x64: ['amd64', 'x86_64'], arm64: ['arm64', 'aarch64'], ia32: ['win32', 'i686'],
  }
  return osOk && (archs[arch] ?? [arch]).some((a) => t.includes(a))
}

/** `file:///C:/x/python` (Windows) or `file:///x/python` (posix). */
export function fileUrl(dir: string): string {
  const p = dir.replace(/\\/g, '/')
  return p.startsWith('/') ? `file://${p}` : `file:///${p}`
}

export interface OfflinePlan {
  /** Extra env for every offline uv call. */
  env: Record<string, string>
  /** argv (after `uv`) for each step, in order. */
  python: string[]
  venv: string[]
  export: string[]
  install: string[]
  /** Where `uv export` writes the hashed requirements. */
  requirementsFile: string
}

/**
 * The offline install, as argv — pure so it is testable without spawning uv.
 *
 * Why not `uv sync --offline --find-links`: for a frozen sync uv only looks for
 * registry-locked wheels in its CACHE, never in find-links, so it cannot
 * install from a wheelhouse. Instead:
 *   1. `uv python install <ver>` — the interpreter comes from the wheelhouse's
 *      python-build-standalone mirror (UV_PYTHON_INSTALL_MIRROR=file://…).
 *      It has to be its own step: under UV_OFFLINE `uv venv` refuses to fetch
 *      an interpreter even from a file:// mirror ("a managed Python download
 *      is available … but uv is set to offline mode"), while `uv python
 *      install` treats the mirror as the source it was told to use.
 *      Then `uv venv --managed-python` over the interpreter just installed.
 *   2. `uv export --frozen` — reads only the lock (no network) and emits every
 *      third-party pin WITH hashes.
 *   3. `uv pip install --offline --no-index --find-links <wheelhouse>
 *      --require-hashes` — lock-exact, hash-verified, no network. Torch is
 *      therefore lock-exact too (no per-machine two-step).
 * The staged member/app wheels are then installed by `installAppWheel` as usual.
 */
export function offlinePlan(p: {
  wheelhouse: string
  manifest: Pick<WheelhouseManifest, 'python'>
  envDir: string
  userData: string
  extras: string[]
}): OfflinePlan {
  const requirementsFile = join(p.userData, 'requirements.offline.txt')
  return {
    env: {
      UV_OFFLINE: '1',
      UV_PYTHON_INSTALL_MIRROR: fileUrl(join(p.wheelhouse, 'python')),
      UV_PYTHON_DOWNLOADS: 'automatic',
    },
    python: ['python', 'install', p.manifest.python],
    venv: ['venv', '--python', p.manifest.python, '--managed-python',
           '--allow-existing', p.envDir],
    export: ['export', '--frozen', '--no-dev', '--no-emit-project', '--no-emit-workspace',
             ...extraArgs(p.extras), '-o', requirementsFile],
    install: ['pip', 'install', '--offline', '--no-index', '--find-links', p.wheelhouse,
              '--require-hashes', '-r', requirementsFile, '--python', venvPython(p.envDir)],
    requirementsFile,
  }
}

/** Fail loudly when the wheelhouse lacks an extra we need. `gpuExtras` are only
 *  required when `gpu` is true — a user who set gpu=false never asked for them,
 *  and they are not in `extras` then. */
export function checkWheelhouseExtras(extras: string[], manifest: WheelhouseManifest): void {
  for (const e of extras) {
    if (!manifest.extras.includes(e)) {
      throw new Error(
        `this wheelhouse was built without the '${e}' extra ` +
        `(it has: ${manifest.extras.join(', ') || 'none'}). Rebuild it with '${e}', ` +
        `or disable the GPU install with ${envPrefix()}_GPU=0 if '${e}' is a GPU extra.`,
      )
    }
  }
}

/** Resolve the command to launch the app's backend, creating the venv if needed. */
export async function resolvePythonEnv(opts: EnsureOptions): Promise<ResolvedPython> {
  const cfg = shellConfig()
  const bundledProject = join(opts.resourcesPath, 'python')
  const bundledLock = join(bundledProject, 'uv.lock')

  // Development (or any build without the staged payload): resolve uv up front
  // — PATH, then the standard per-user install dirs — so a uv that is installed
  // but off this process's PATH still works. When it is truly nowhere, keep the
  // bare 'uv': the spawn-error trap turns that into a readable report.
  if (!opts.isPackaged || !existsSync(bundledLock)) {
    const uv = findUv() ?? 'uv'
    return { cmd: [uv, 'run', 'python', '-m', cfg.pythonModule], cwd: opts.projectRoot }
  }

  const envDir = join(opts.userData, 'python-env')
  const pythonExe = venvPython(envDir)
  const stampFile = join(envDir, `.${cfg.appId}-lock-hash`)
  const lockHash = createHash('sha256').update(readFileSync(bundledLock)).digest('hex')

  // GPU decision: option > <APPID>_GPU > nvidia-smi probe. The probe only runs
  // when the app declared gpuExtras — otherwise there is nothing to decide. An
  // explicit choice (option or env var) is strict; a probed one may be dropped
  // when the install source cannot satisfy it (see the wheelhouse branch below).
  const gpuExtras = cfg.gpuExtras ?? []
  const gpuExplicit = opts.gpu ?? gpuEnvOverride()
  const gpu = gpuExtras.length === 0 ? false
    : (gpuExplicit ?? await hasNvidiaGpu())
  let extras = effectiveExtras(cfg.pythonExtras, gpuExtras, gpu)
  let stamp = lockStamp(lockHash, extras)
  // The stamp written when a probed GPU was dropped because the wheelhouse was
  // built without the GPU extras. Accepting it below is what stops an
  // air-gapped GPU machine from re-syncing — online, so failing — on every
  // launch; a new lock, or an explicit <APPID>_GPU=1, re-evaluates.
  const cpuOnly = effectiveExtras(cfg.pythonExtras, gpuExtras, false)
  const gpuUnavailableStamp = `${lockStamp(lockHash, cpuOnly)}+gpu=unavailable`

  // Skip the sync if the venv already matches the shipped lock AND extras.
  const onDisk = existsSync(stampFile) ? readSafe(stampFile) : null
  const upToDate =
    existsSync(pythonExe) &&
    (onDisk === stamp ||
      (gpu && gpuExplicit === undefined && onDisk === gpuUnavailableStamp))

  if (!upToDate) {
    if (gpuExtras.length) {
      opts.onProgress?.(gpu
        ? `[env-setup] ${gpuExplicit ? 'GPU install requested' : 'NVIDIA GPU detected'} → extras: ${gpuExtras.join(', ')}
`
        : `[env-setup] no NVIDIA GPU (or disabled) → skipping extras: ${gpuExtras.join(', ')}
`)
    }
    const found = findWheelhouse(wheelhouseCandidates(opts))
    if (found) {
      // A probed GPU whose extras the wheelhouse lacks degrades to a CPU
      // install rather than failing: the site still gets a working app, and
      // the stamp remembers why. Anything else missing (an app extra, or a GPU
      // the user asked for explicitly) fails in checkWheelhouseExtras.
      const missingGpu = gpu && gpuExplicit === undefined &&
        gpuExtras.some((e) => !found.manifest.extras.includes(e))
      if (missingGpu) {
        opts.onProgress?.(
          `[env-setup] this wheelhouse has no GPU packages (${gpuExtras.join(', ')}); ` +
          `installing without them. Set ${envPrefix()}_GPU=1 to require them.
`)
        extras = cpuOnly
        stamp = gpuUnavailableStamp
      }
      checkWheelhouseExtras(extras, found.manifest)
    }
    if (clearBrokenEnv(envDir)) {
      opts.onProgress?.('[env-setup] removed an incomplete Python environment left by an earlier install\n')
    }
    await setupEnv({
      projectDir: bundledProject, envDir, appVersion: readAppVersion(bundledProject),
      extras, wheelhouse: found, onProgress: opts.onProgress,
    })
    try {
      mkdirSync(envDir, { recursive: true })
      writeFileSync(stampFile, stamp, 'utf8')
    } catch { /* a missing stamp just forces a re-sync next launch */ }
  }

  // Run from the ENV, not the bundled project: a working directory is an open
  // handle on that directory, and every process the sidecar spawns inherits it.
  // Rooted in the install directory, that handle is what stops a Windows update
  // from removing the old version — and the installer cannot even find the
  // holder, because an app-running check scans for processes whose EXECUTABLE
  // is under the install directory and this interpreter lives out here. Nothing
  // wants the project directory: the app is installed into the env as a wheel,
  // and what it reads from the bundle it reads by absolute path.
  return { cmd: [pythonExe, '-m', cfg.pythonModule], cwd: envDir }
}

/**
 * Remove `envDir` if it exists but is not a virtual environment (no
 * pyvenv.cfg). uv refuses such a directory outright ("cannot be used because it
 * is not a valid Python environment"), so without this a half-removed env — an
 * uninstall that could not delete every file, or a crash mid-delete — would
 * stop the app at env setup on every launch until someone deleted it by hand.
 * The directory is the shell's own, so nothing else lives in it. Returns
 * whether it removed anything.
 */
export function clearBrokenEnv(envDir: string): boolean {
  if (!existsSync(envDir) || existsSync(join(envDir, 'pyvenv.cfg'))) return false
  rmSync(envDir, { recursive: true, force: true, maxRetries: 3 })
  return true
}

function readSafe(p: string): string {
  try { return readFileSync(p, 'utf8').trim() } catch { return '' }
}

/**
 * The version bundle-python.mjs baked into `<projectDir>/.<appId>-version`
 * (X.Y.Z, resolved at CI bundle time when git history exists). Empty string in
 * dev (no marker) — the dev repo has `.git`, so setuptools_scm works normally.
 */
function readAppVersion(projectDir: string): string {
  return readSafe(join(projectDir, `.${shellConfig().appId}-version`))
}

/**
 * Build the env for a uv invocation against the managed env.
 *
 * `appVersion` (from the .<appId>-version marker) is exported as
 * SETUPTOOLS_SCM_PRETEND_VERSION_FOR_<DIST> so building the editable app package
 * succeeds even though the staged tree has NO `.git` — without it
 * setuptools_scm raises `LookupError: unable to detect version` and `uv sync`
 * exits 1 (the first-launch crash). Absent in dev (marker not present) → the
 * env is unchanged and setuptools_scm resolves from the repo's git history.
 */
function uvEnv(
  envDir: string, appVersion: string, projectDir?: string,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  // Pretend-version env for setuptools_scm. The dist-name–scoped var is the
  // precise one; the plain SETUPTOOLS_SCM_PRETEND_VERSION is a harmless
  // belt-and-braces fallback in case the dist name ever changes.
  //
  // setuptools_scm normalises the dist name to the env-var suffix by
  // uppercasing and replacing runs of non-alphanumerics with `_`
  // ("de-shell" → "DE_SHELL", "spyde" → "SPYDE").
  const scmSuffix = String(shellConfig().pythonDist)
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const scmEnv: Record<string, string> = appVersion
    ? {
        [`SETUPTOOLS_SCM_PRETEND_VERSION_FOR_${scmSuffix}`]: appVersion,
        SETUPTOOLS_SCM_PRETEND_VERSION: appVersion,
      }
    : {}
  // Put the vendored portable git (bundle-python.mjs staged it at
  // <projectDir>/git) on PATH so `uv sync` can resolve `git+https://…` deps
  // (the hyperspy fork) on machines with no system git. MinGit's launcher is in
  // git/cmd on Windows; git/bin holds it on posix. Prepend so ours wins; fall
  // through to any system git if the vendored one is absent (dev builds).
  const gitDir = projectDir ? join(projectDir, 'git') : ''
  const gitBins = gitDir
    ? [join(gitDir, 'cmd'), join(gitDir, 'bin')].filter((d) => existsSync(d))
    : []
  const pathKey = isWin ? 'Path' : 'PATH'
  const basePath = process.env[pathKey] ?? process.env.PATH ?? ''
  const mergedPath = gitBins.length
    ? [...gitBins, basePath].join(isWin ? ';' : ':')
    : basePath

  return {
    ...process.env,
    ...scmEnv,
    [pathKey]: mergedPath,
    // UV_PROJECT_ENVIRONMENT redirects `uv sync`'s venv out of the read-only
    // resources into the writable user dir. (Ignored by `uv pip install`,
    // which targets via --python — verified; harmless to set for both.)
    UV_PROJECT_ENVIRONMENT: envDir,
    // Keep uv's own cache/tools next to the env so an air-gapped re-run is
    // self-contained and we never write into the read-only bundle.
    UV_CACHE_DIR: join(envDir, '..', 'uv-cache'),
    // No residue outside userData: uv's managed interpreters default to
    // %APPDATA%\uv\python (~/.local/share/uv/python), which an uninstall never
    // cleans. Existing venvs keep working after this moves — their pyvenv.cfg
    // records the absolute path of the interpreter they were created with.
    UV_PYTHON_INSTALL_DIR: join(envDir, '..', 'python'),
    // ...and nothing else of uv's leaks out either. `uv python install` (the
    // offline path, and any automatic download) otherwise also drops a
    // python3.X.exe launcher into ~/.local/bin and registers the interpreter
    // under HKCU\Software\Python\Astral (PEP 514). Both outlive an uninstall
    // and point into a folder it deletes.
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    // Only ever build the env on an interpreter in that folder. Without it uv
    // takes the first suitable Python it discovers -- one on PATH, or a
    // launcher another tool left in ~/.local/bin -- and the venv's pyvenv.cfg
    // then points at something this app neither owns nor removes, and which
    // may vanish under it. Seen in testing: a venv linked to a stray launcher.
    UV_MANAGED_PYTHON: '1',
    ...extraEnv,
  }
}

/** Spawn the bundled (or PATH) uv with `args`, streaming output to onProgress. */
function runUv(
  projectDir: string,
  envDir: string,
  args: string[],
  appVersion: string,
  onProgress?: (line: string) => void,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const uv = join(projectDir, uvBinaryName())
  // Fall back to a resolved PATH/per-user uv if not bundled (dev builds).
  const uvCmd = existsSync(uv) ? uv : (findUv() ?? 'uv')
  return new Promise((resolve, reject) => {
    const proc = spawn(uvCmd, args, {
      cwd: projectDir,
      env: uvEnv(envDir, appVersion, projectDir, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const relay = (b: Buffer) => onProgress?.(b.toString())
    proc.stdout?.on('data', relay)
    proc.stderr?.on('data', relay)   // uv prints progress to stderr
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`uv ${args[0]} exited with code ${code}`)),
    )
  })
}

/** uv's words for copying an interpreter from its install mirror. */
const PYTHON_DOWNLOAD_LINE = /^ *Download(?:ing|ed) cpython-/

/**
 * A progress relay for the wheelhouse's interpreter step. Its mirror is the
 * wheelhouse's `python/` folder on disk, but uv words the copy as a download
 * ("Downloading cpython-…", "Downloaded cpython-…"), and the setup window would
 * show it as one. Those lines are dropped and the rest passed on. Whole lines
 * only: a chunk's unfinished last line is held until its end arrives, or `flush`.
 */
export function withoutPythonDownloadLines(onProgress?: (line: string) => void): {
  relay: (chunk: string) => void
  flush: () => void
} {
  let held = ''
  const pass = (text: string) => {
    const kept = text.split(/(?<=\n)/).filter((line) => !PYTHON_DOWNLOAD_LINE.test(line)).join('')
    if (kept) onProgress?.(kept)
  }
  return {
    relay(chunk) {
      const text = held + chunk
      const end = text.lastIndexOf('\n') + 1
      held = text.slice(end)
      if (end) pass(text.slice(0, end))
    },
    flush() {
      if (held) pass(held)
      held = ''
    },
  }
}

/**
 * Install the locked torch release into the managed env with the backend
 * resolved for THIS machine (`--torch-backend=auto`: uv probes the NVIDIA
 * driver and picks the matching cuXXX wheel, or the much smaller CPU wheel when
 * no GPU is present). Shared by first-run setup (step 2) and the GPU-triage
 * "Fix PyTorch install" handler. Throws on failure (caller decides fallback).
 */
export function installTorchPerMachine(
  projectDir: string,
  envDir: string,
  onProgress?: (line: string) => void,
): Promise<void> {
  const torchVersion = readLockedTorchVersion(projectDir)
  if (!torchVersion) {
    return Promise.reject(new Error('could not read the locked torch version from uv.lock'))
  }
  onProgress?.(`[env-setup] installing torch==${torchVersion} with --torch-backend=auto\n`)
  return runUv(
    projectDir, envDir,
    ['pip', 'install', `torch==${torchVersion}`, '--torch-backend=auto',
     '--python', venvPython(envDir)],
    '',   // no scm pretend-version needed for a plain pip install
    onProgress,
  )
}

/** The pre-built app wheel staged by bundle-python.mjs at <projectDir>/wheels/
 *  (a single py3-none-any .whl). Null in dev (no staged wheel) → the caller
 *  installs the project from source the old way (dev tree is writable).
 *
 *  Matched by the DIST name with its separators normalised: a wheel filename
 *  uses `_` where the dist name may use `-` ("de-shell" → "de_shell-0.1.0-…"). */
function stagedAppWheel(projectDir: string): string | null {
  const dir = join(projectDir, 'wheels')
  if (!existsSync(dir)) return null
  const prefix = String(shellConfig().pythonDist).replace(/-/g, '_').toLowerCase()
  try {
    const whl = readdirSync(dir).find(
      (f) => f.toLowerCase().replace(/-/g, '_').startsWith(prefix) && f.endsWith('.whl'),
    )
    return whl ? join(dir, whl) : null
  } catch { return null }
}

/**
 * Every wheel staged beside the app's own — the workspace MEMBERS.
 *
 * The app is one package in a uv workspace, and its siblings are path
 * dependencies. They cannot be built on the user's machine for the same reason
 * the app cannot (setuptools' egg_info writes into a read-only tree), so
 * `bundle-python.mjs` builds them all with `uv build --all-packages` and they
 * are installed from wheels here.
 */
function stagedMemberWheels(projectDir: string, appWheel: string | null): string[] {
  const dir = join(projectDir, 'wheels')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.whl'))
      .map((f) => join(dir, f))
      .filter((f) => f !== appWheel)
  } catch { return []; }
}

/**
 * The distribution name a wheel file installs, from its filename.
 *
 * Wheel names are `{name}-{version}-…`, and the name has `-` normalised to `_`.
 * uv accepts either spelling for `--no-install-package`.
 */
function wheelPackageName(wheel: string): string {
  return (wheel.split(/[\\/]/).pop() || '').split('-')[0]
}

/**
 * Install the PRE-BUILT app wheel into the managed env with no dependency
 * resolution (`--no-deps` — the sync already installed every dependency). This
 * is the whole reason the wheel exists: it avoids building the app from the
 * read-only shipped source tree (setuptools' egg_info write → "Access is
 * denied", the rc.2/rc.3 first-launch crash). Throws on failure.
 */
function installAppWheel(
  projectDir: string,
  envDir: string,
  wheel: string,
  onProgress?: (line: string) => void,
  offlineEnv?: Record<string, string>,
): Promise<void> {
  onProgress?.(
    `[env-setup] installing ${shellConfig().pythonDist} from wheel ` +
    `${wheel.split(/[\\/]/).pop()}\n`,
  )
  return runUv(
    projectDir, envDir,
    ['pip', 'install', ...(offlineEnv ? ['--offline'] : []), '--no-deps',
     '--python', venvPython(envDir), wheel],
    '', onProgress, offlineEnv,
  )
}

/**
 * Create/refresh the managed env. On win32/linux (the platforms where the lock
 * pins CUDA torch) this is the two-step per-machine install; on failure — or on
 * macOS, or when the lock has no readable torch pin — the plain full
 * `uv sync --frozen --no-dev` (the original, known-good path) runs instead.
 *
 * When a pre-built app wheel is staged (the packaged app), the syncs use
 * `--no-install-project` (resolve + install DEPS only, never build the app) and
 * the app is installed from the wheel afterwards — so NOTHING is built from the
 * read-only source tree. In dev (no staged wheel) the project installs from
 * source as before. Logs which path ran to the progress stream.
 */
async function setupEnv(o: {
  projectDir: string
  envDir: string
  appVersion: string
  extras: string[]
  wheelhouse: { dir: string; manifest: WheelhouseManifest } | null
  onProgress?: (line: string) => void
}): Promise<void> {
  const { projectDir, envDir, appVersion, extras, wheelhouse, onProgress } = o
  const wheel = stagedAppWheel(projectDir)
  const memberWheels = stagedMemberWheels(projectDir, wheel)
  // With a staged wheel, tell uv sync NOT to touch the project (the app builds
  // from the read-only tree otherwise); we install the wheel separately.
  //
  // `--no-install-project` covers the ROOT project only, so every workspace
  // MEMBER needs excluding by name as well. Without that, uv tries to build
  // them from the payload — which carries their pyproject.toml for workspace
  // discovery and nothing else — and first launch dies before installing
  // anything ("Distribution not found at: file:///…/packages/de-shell").
  const projectArgs = wheel ? ['--no-install-project'] : ['--no-editable']
  for (const memberWheel of memberWheels) {
    projectArgs.push('--no-install-package', wheelPackageName(memberWheel))
  }

  if (wheelhouse) {
    const { dir, manifest } = wheelhouse
    if (!platformMatches(manifest.platform)) {
      onProgress?.(`[env-setup] WARNING: wheelhouse is for ${manifest.platform}, this machine is ${process.platform}/${process.arch}\n`)
    }
    if (appVersion && manifest.version && manifest.version !== appVersion) {
      onProgress?.(`[env-setup] WARNING: wheelhouse is for version ${manifest.version}, app is ${appVersion}\n`)
    }
    onProgress?.(`[env-setup] offline install from wheelhouse ${dir}\n`)
    const plan = offlinePlan({ wheelhouse: dir, manifest, envDir, userData: join(envDir, '..'), extras })
    mkdirSync(join(envDir, '..'), { recursive: true })
    onProgress?.(`[env-setup] installing Python ${manifest.python} from the wheelhouse
`)
    const python = withoutPythonDownloadLines(onProgress)
    try {
      await runUv(projectDir, envDir, plan.python, appVersion, python.relay, plan.env)
    } finally {
      python.flush()
    }
    await runUv(projectDir, envDir, plan.venv, appVersion, onProgress, plan.env)
    await runUv(projectDir, envDir, plan.export, appVersion, onProgress, plan.env)
    await runUv(projectDir, envDir, plan.install, appVersion, onProgress, plan.env)
    for (const memberWheel of memberWheels) {
      await installAppWheel(projectDir, envDir, memberWheel, onProgress, plan.env)
    }
    if (wheel) await installAppWheel(projectDir, envDir, wheel, onProgress, plan.env)
    onProgress?.('[env-setup] offline install complete\n')
    return
  }

  const twoStep =
    (process.platform === 'win32' || process.platform === 'linux') &&
    readLockedTorchVersion(projectDir) !== null

  if (twoStep) {
    try {
      onProgress?.('[env-setup] two-step install: uv sync (lock-exact, torch deferred) '
        + 'then torch via --torch-backend=auto\n')
      // Step 1: every DEPENDENCY except torch, exactly as locked. torch is the
      // only torch-family package in the lock, so one exclusion covers it.
      await runUv(
        projectDir, envDir,
        buildSyncArgs(projectArgs, extras, ['torch']),
        appVersion, onProgress,
      )
      // Step 2: torch resolved for this machine.
      await installTorchPerMachine(projectDir, envDir, onProgress)
      // Step 3: the workspace members, then the app — all from pre-built
      // wheels (packaged only). Members first: the app wheel depends on them
      // and `--no-deps` means nothing else will pull them in.
      for (const memberWheel of memberWheels) {
        await installAppWheel(projectDir, envDir, memberWheel, onProgress)
      }
      if (wheel) await installAppWheel(projectDir, envDir, wheel, onProgress)
      onProgress?.('[env-setup] per-machine torch install complete\n')
      return
    } catch (err) {
      onProgress?.(`[env-setup] per-machine torch install failed (${(err as Error)?.message ?? err}); `
        + 'falling back to the full locked sync\n')
      // fall through to the plain sync
    }
  }

  onProgress?.('[env-setup] running full locked uv sync\n')
  await runUv(projectDir, envDir, buildSyncArgs(projectArgs, extras), appVersion, onProgress)
  for (const memberWheel of memberWheels) {
    await installAppWheel(projectDir, envDir, memberWheel, onProgress)
  }
  if (wheel) await installAppWheel(projectDir, envDir, wheel, onProgress)
}

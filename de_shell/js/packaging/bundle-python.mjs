#!/usr/bin/env node
/**
 * bundle-python.mjs — stage the Python sidecar payload for electron-builder.
 *
 *   node shell/packaging/bundle-python.mjs [flags]       (from the app's electron/ dir)
 *
 * Writes the exact layout de-shell's main/pythonEnv.ts reads at
 * `<resources>/python`:
 *
 *   pyproject.toml, uv.lock     the project, for a reproducible first-launch `uv sync`
 *   .python-version             pins the PACKAGED interpreter only (see below)
 *   .<appId>-version            the release version, for setuptools_scm
 *   wheels/*.whl                the app's wheel AND every workspace member's
 *   uv(.exe)                    the platform uv that runs the sync
 *   git/                        optional portable git (MinGit) for git+https deps
 *
 * electron-builder ships the directory as an extraResource; the venv itself is
 * NOT bundled (tiny installer, and uv picks the right wheels per machine) —
 * unless the app also ships a wheelhouse, see build-wheelhouse.mjs.
 *
 * CONFIGURATION — flags win over the `deShell` block of the app's
 * electron/package.json, which wins over the defaults:
 *
 *   flag                    deShell key       meaning
 *   --app-id <id>           appId             the shell's appId (names the version marker)  REQUIRED
 *   --python-dist <name>    pythonDist        the app's distribution name (SCM pretend var) default: appId
 *   --project-root <dir>    projectRoot       the uv project, relative to electron/          default: ..
 *   --python-version <v>    pythonVersion     interpreter for the packaged env               default: <projectRoot>/.python-version
 *   --mingit                includeMingit     stage electron/vendor/git/<platform> (error if missing)
 *   --no-mingit                               do not stage git even when it exists
 *   --uv <path>             uvSource          the uv binary to ship                          default: vendor/uv/<platform>/uv, else PATH
 *   --out <dir>             out               staging dir, relative to electron/             default: resources/python
 *   --electron-dir <dir>                      the app's electron/ dir                        default: cwd
 *
 * No npm dependencies: node builtins only, so it runs before `npm ci` has
 * anything to offer and from inside a site-packages tree.
 */
import {
  cpSync, existsSync, mkdirSync, rmSync, copyFileSync, chmodSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const isWin = process.platform === 'win32'
const uvName = isWin ? 'uv.exe' : 'uv'

function log(msg) { console.log(`[bundle-python] ${msg}`) }

/** `--flag value` / `--flag=value` / bare `--flag` -> { flag: value|true }. */
function parseFlags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i])
    if (!m) throw new Error(`unexpected argument ${argv[i]}`)
    const [, key, inline] = m
    if (inline !== undefined) out[key] = inline
    else if (['mingit', 'no-mingit'].includes(key)) out[key] = true
    else out[key] = argv[++i]
  }
  return out
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

const flags = parseFlags(process.argv.slice(2))
const electronDir = resolve(flags['electron-dir'] ?? process.cwd())
const pkg = readJson(join(electronDir, 'package.json'))
const cfg = pkg.deShell ?? {}

const appId = flags['app-id'] ?? cfg.appId
if (!appId) throw new Error('appId is required: pass --app-id or set deShell.appId in electron/package.json')
const pythonDist = flags['python-dist'] ?? cfg.pythonDist ?? appId
const projectRoot = resolve(electronDir, flags['project-root'] ?? cfg.projectRoot ?? '..')
const outDir = resolve(electronDir, flags.out ?? cfg.out ?? join('resources', 'python'))
const uvOverride = flags.uv ?? cfg.uvSource
const includeMingit = flags['no-mingit'] ? false : (flags.mingit ? true : (cfg.includeMingit ?? null))

/**
 * The release version to bake into the staged payload.
 *
 * The staged tree has NO `.git`, and an app whose pyproject derives its version
 * from setuptools_scm would fail its first-launch `uv sync` with `LookupError:
 * unable to detect version`. So the version is resolved HERE (CI has git and
 * tags) and written to `.<appId>-version`; pythonEnv.ts exports it as
 * SETUPTOOLS_SCM_PRETEND_VERSION_FOR_<DIST>. electron/package.json's `version`
 * wins: the release workflow verifies it equals the pushed tag, so it is the
 * already-validated release version (and a plain X.Y.Z is valid PEP 440).
 */
function resolveVersion() {
  if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim()
  try {
    const v = execFileSync('uv', ['run', 'python', '-m', 'setuptools_scm'], {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (v) return v
  } catch { /* no git / no uv / not scm — leave the marker unwritten */ }
  return null
}

/** The `.python-version` pin: flag > deShell > the project's own file. */
function resolvePythonVersion() {
  const v = flags['python-version'] ?? cfg.pythonVersion
  if (v) return String(v).trim()
  try {
    const first = readFileSync(join(projectRoot, '.python-version'), 'utf8').split(/\r?\n/)[0].trim()
    if (first) return first
  } catch { /* fall through */ }
  throw new Error(
    'no interpreter version: pass --python-version, set deShell.pythonVersion, or commit a ' +
    `.python-version in ${projectRoot}. (Unpinned, first-launch uv grabs the NEWEST CPython, ` +
    "which may have no wheels for the app's dependencies yet.)")
}

const version = resolveVersion()
const pythonVersion = resolvePythonVersion()

// Fresh staging dir.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// 1. Project metadata + lock (reproducible `uv sync`).
for (const f of ['pyproject.toml', 'uv.lock']) {
  const src = join(projectRoot, f)
  if (!existsSync(src)) throw new Error(`missing ${f} in ${projectRoot}`)
  copyFileSync(src, join(outDir, f))
  log(`staged ${f}`)
}

// Pin the interpreter for the PACKAGED env only. Without this, first-launch
// `uv sync` picks the newest CPython. We write `.python-version` ONLY into the
// payload, never at the project root: a root file would also hijack dev + the
// CI test matrix (every `uv run` re-creates the venv at that version). Scoped
// to the staged tree, shipped users get the pinned Python while dev/CI stay
// free to pick their own.
writeFileSync(join(outDir, '.python-version'), pythonVersion + '\n', 'utf8')
log(`staged .python-version = ${pythonVersion}`)

// 2. PRE-BUILT wheels — the app's and every workspace member's — NOT source.
//    Building from source on first launch is impossible when the app is
//    installed read-only (e.g. C:\Program Files): setuptools' build_wheel runs
//    egg_info, which writes `<pkg>.egg-info` INTO the source dir -> "Access is
//    denied", `uv sync` exits 1 (--no-editable does not help; a wheel build
//    still writes egg_info into the tree). So we build HERE, where the repo is
//    writable, and pythonEnv.ts installs the .whl files with `uv pip install
//    --no-deps` after syncing the dependencies without the project itself, so
//    NOTHING is built on the user's machine. --all-packages is what picks up
//    the siblings that are path dependencies of the app. Pure-Python wheels are
//    py3-none-any and serve every platform we ship.
const wheelsDir = join(outDir, 'wheels')
mkdirSync(wheelsDir, { recursive: true })
const scmSuffix = pythonDist.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
const buildEnv = version
  ? { ...process.env, [`SETUPTOOLS_SCM_PRETEND_VERSION_FOR_${scmSuffix}`]: version,
      SETUPTOOLS_SCM_PRETEND_VERSION: version }
  : process.env
execFileSync('uv', ['build', '--all-packages', '--wheel', '--out-dir', wheelsDir], {
  cwd: projectRoot, stdio: 'inherit', env: buildEnv,
})
// `uv build` drops a catch-all .gitignore into --out-dir; it is not payload.
rmSync(join(wheelsDir, '.gitignore'), { force: true })
const builtWheels = readdirSync(wheelsDir).filter((f) => f.endsWith('.whl'))
if (!builtWheels.length) throw new Error('uv build produced no wheels')
log(`staged ${builtWheels.length} wheel(s): ${builtWheels.join(', ')}`)

// 3. The uv binary: --uv / deShell.uvSource, else a vendored copy at
//    electron/vendor/uv/<platform>/uv[.exe], else the `uv` on PATH (CI installs
//    a pinned one, so that is what ships).
let uvSrc = uvOverride ? resolve(electronDir, uvOverride) : join(electronDir, 'vendor', 'uv', process.platform, uvName)
if (!existsSync(uvSrc)) {
  if (uvOverride) throw new Error(`uv binary not found at ${uvSrc}`)
  try {
    uvSrc = execFileSync(isWin ? 'where' : 'which', ['uv']).toString().trim().split(/\r?\n/)[0]
    log(`vendor/ uv not found; using uv from PATH: ${uvSrc}`)
  } catch {
    throw new Error('no uv binary: pass --uv, add electron/vendor/uv/<platform>/uv, or install uv on PATH')
  }
}
const uvDst = join(outDir, uvName)
copyFileSync(uvSrc, uvDst)
if (!isWin) chmodSync(uvDst, 0o755)
log(`staged ${uvName}`)

// 3b. Vendored git (portable). Dependencies that are `git+https://…` sources
//     are resolved by `git clone`, and a clean user machine often has NO git
//     on PATH -> "Git operation failed" and first-launch setup dies. So an app
//     with such deps ships a portable git (MinGit on Windows) in the payload;
//     pythonEnv.ts prepends its cmd/ and bin/ to PATH for the sync. Staged from
//     electron/vendor/git/<platform>/. `includeMingit: true` makes absence an
//     error (a shippable build must have it); unset stages it when present.
const vendoredGit = join(electronDir, 'vendor', 'git', process.platform)
if (includeMingit !== false && existsSync(vendoredGit)) {
  const gitDst = join(outDir, 'git')
  cpSync(vendoredGit, gitDst, { recursive: true })
  // Make the git executables runnable on posix (Windows ignores the mode).
  if (!isWin) {
    for (const sub of ['bin', 'libexec/git-core']) {
      const d = join(gitDst, sub)
      if (existsSync(d)) {
        for (const f of readdirSync(d)) {
          try { chmodSync(join(d, f), 0o755) } catch { /* best-effort */ }
        }
      }
    }
  }
  log('staged vendored git')
} else if (includeMingit === true) {
  throw new Error(`includeMingit is set but ${vendoredGit} does not exist — populate it (the release workflow does) before bundling`)
} else {
  log(includeMingit === false
    ? 'git not requested; NOT staging it'
    : `vendor/git/${process.platform} not found; NOT staging git — first-launch ` +
      "`uv sync` will need a git on the user's PATH if any dependency is a git source.")
}

// 4. Version marker (see resolveVersion for why the staged tree needs it).
if (version) {
  writeFileSync(join(outDir, `.${appId}-version`), version, 'utf8')
  log(`staged .${appId}-version = ${version}`)
} else {
  log(`WARNING: could not resolve a version — .${appId}-version NOT written; ` +
      'first-launch `uv sync` may fail with a setuptools_scm LookupError')
}

log(`done -> ${outDir}`)

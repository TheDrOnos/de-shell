#!/usr/bin/env node
/**
 * build-wheelhouse.mjs — build the OFFLINE wheelhouse for one target platform.
 *
 *   node shell/packaging/build-wheelhouse.mjs --platform win_amd64 --out wheelhouse [flags]
 *
 * A normal packaged install runs `uv sync` against PyPI on first launch. A
 * wheelhouse is the same install with the network taken out: every locked
 * wheel for one platform, plus the python-build-standalone interpreter archive,
 * so a lab machine with no internet can set up from a folder (or a zip on a
 * USB stick). De-shell's main/pythonEnv.ts is the consumer; THE LAYOUT BELOW IS
 * THAT CONTRACT:
 *
 *   <out>/wheelhouse.json     {"app","version","platform","python","extras":[…]}
 *   <out>/*.whl               every locked wheel for the platform, flat
 *   <out>/python/<tag>/<archive>
 *                             the interpreter, at the path uv's
 *                             UV_PYTHON_INSTALL_MIRROR expects: the URL path
 *                             after `…/releases/download/`, file name URL-decoded
 *
 * HOW. The lock is the source of truth, exactly as for the online install:
 *   1. `uv export --frozen` writes the locked, hashed requirement set (no dev
 *      group, no project/workspace members — those are wheels the payload
 *      already carries, see bundle-python.mjs — plus the chosen extras).
 *   2. Environment markers are evaluated HERE against the TARGET platform. pip
 *      downloading for a foreign platform still evaluates markers against the
 *      HOST, so a Linux CI runner would silently drop win32-only dependencies
 *      (colorama, pywin32 …) from the Windows wheelhouse.
 *   3. `pip download --only-binary=:all: --no-deps --platform …` fetches the
 *      wheels. pip checks the hashes in the file, so the wheelhouse is exactly
 *      what the lock says, and `--require-hashes` works on the install side.
 *      A package with no wheel for the platform fails the build loudly; an
 *      sdist would have to be compiled on the user's machine, which is the very
 *      thing an offline install cannot do.
 *   4. The interpreter archive URL comes from `uv python list`, so the archive
 *      is the one uv itself would have downloaded for that version.
 * pip is run via `uv tool run pip`, so nothing needs installing.
 *
 * FLAGS (override the `deShell` block of electron/package.json, same keys as
 * bundle-python.mjs):
 *   --platform <tag>        win_amd64 | win_arm64 | macosx_11_0_arm64 | macosx_10_13_x86_64 |
 *                           manylinux2014_x86_64 | manylinux2014_aarch64      REQUIRED
 *   --out <dir>             output dir                                        default: wheelhouse-<platform>
 *   --extra <name>          an optional-dependency extra to include (repeatable; or deShell.wheelhouseExtras)
 *   --no-extras             none, even when deShell.wheelhouseExtras names some
 *   --python-version <v>    3.13 or 3.13.12; default <projectRoot>/.python-version
 *   --app-id, --version, --project-root, --electron-dir   as bundle-python.mjs
 *   --app-name <name>       display name for the zip file     default: deShell.productName, else appId
 *   --package <name>        `uv export --package` for a workspace member app
 *   --zip                   also write <App>-<version>-wheels-<platform>.zip next to <out>
 *
 * Node builtins only (fetch needs Node 18+).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

function log(msg) { console.log(`[build-wheelhouse] ${msg}`) }

function parseFlags(argv) {
  const out = { extra: [] }
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i])
    if (!m) throw new Error(`unexpected argument ${argv[i]}`)
    const [, key, inline] = m
    const val = inline !== undefined ? inline : (['zip', 'no-extras'].includes(key) ? true : argv[++i])
    if (key === 'extra') out.extra.push(val)
    else out[key] = val
  }
  return out
}

// ── target platform ─────────────────────────────────────────────────────────

/**
 * What a pip platform tag means: the python-build-standalone os/arch/libc to
 * fetch, the tags to hand pip (`--platform`, repeated: a manylinux machine
 * accepts several generations, and a single tag would miss wheels published
 * only as manylinux_2_28), and the values environment markers see.
 */
function describePlatform(tag) {
  let m
  if ((m = /^win_(amd64|arm64)$/.exec(tag))) {
    const arm = m[1] === 'arm64'
    return {
      pbs: { os: 'windows', arch: arm ? 'aarch64' : 'x86_64' }, pip: [tag],
      env: { sys_platform: 'win32', platform_system: 'Windows', os_name: 'nt', platform_machine: arm ? 'ARM64' : 'AMD64' },
    }
  }
  if ((m = /^macosx_\d+_\d+_(arm64|x86_64)$/.exec(tag))) {
    const arm = m[1] === 'arm64'
    return {
      pbs: { os: 'darwin', arch: arm ? 'aarch64' : 'x86_64' }, pip: [tag],
      env: { sys_platform: 'darwin', platform_system: 'Darwin', os_name: 'posix', platform_machine: m[1] },
    }
  }
  if ((m = /^manylinux\w*_(x86_64|aarch64)$/.exec(tag))) {
    const a = m[1]
    return {
      pbs: { os: 'linux', arch: a, libc: 'gnu' },
      pip: [...new Set([tag, `manylinux2014_${a}`, `manylinux_2_28_${a}`])],
      env: { sys_platform: 'linux', platform_system: 'Linux', os_name: 'posix', platform_machine: a },
    }
  }
  throw new Error(`unsupported --platform ${tag}`)
}

// ── environment markers (PEP 508), evaluated for the target ────────────────

function evalMarker(marker, env) {
  const toks = marker.match(/\(|\)|===|==|!=|<=|>=|~=|<|>|'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*/g) || []
  let i = 0
  const value = (t) => (/^['"]/.test(t) ? t.slice(1, -1) : t)
  const isExtra = (t) => t === 'extra'
  const vparts = (s) => (/^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null)
  function cmp(a, op, b) {
    if (op === 'in') return b.includes(a)
    if (op === 'not in') return !b.includes(a)
    const pa = vparts(a); const pb = vparts(b)
    let c
    if (pa && pb) {
      c = 0
      for (let k = 0; k < Math.max(pa.length, pb.length) && !c; k++) c = (pa[k] ?? 0) - (pb[k] ?? 0)
    } else c = a < b ? -1 : a > b ? 1 : 0
    switch (op) {
      case '==': case '===': return c === 0
      case '!=': return c !== 0
      case '<': return c < 0
      case '<=': return c <= 0
      case '>': return c > 0
      case '>=': return c >= 0
      case '~=': return c >= 0 && (pa && pb ? pa.slice(0, Math.max(1, pb.length - 1)).join('.') === pb.slice(0, Math.max(1, pb.length - 1)).join('.') : true)
      default: throw new Error(`marker operator ${op}`)
    }
  }
  function atom() {
    if (toks[i] === '(') { i++; const v = orExpr(); i++; return v }
    const l = toks[i++]
    let op = toks[i++]
    if (op === 'not') { op = 'not in'; i++ }
    const r = toks[i++]
    // `extra == 'x'`: true when x is one of the selected extras.
    if (isExtra(l) || isExtra(r)) {
      const name = value(isExtra(l) ? r : l)
      const has = env.extras.includes(name)
      return op === '!=' ? !has : has
    }
    const get = (t) => (/^['"]/.test(t) ? value(t) : String(env[t] ?? ''))
    return cmp(get(l), op, get(r))
  }
  function andExpr() { let v = atom(); while (toks[i] === 'and') { i++; v = atom() && v } return v }
  function orExpr() { let v = andExpr(); while (toks[i] === 'or') { i++; v = andExpr() || v } return v }
  return orExpr()
}

/**
 * Re-write an exported requirements file for the target: drop entries whose
 * marker is false there, strip the markers that are kept (pip would otherwise
 * re-evaluate them against the HOST), keep the --hash lines.
 */
function filterRequirements(text, env) {
  const joined = text.replace(/\\\r?\n/g, ' ')
  const out = []
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('-')) { out.push(line); continue }
    const hashAt = line.indexOf(' --hash')
    const req = hashAt < 0 ? line : line.slice(0, hashAt)
    const hashes = hashAt < 0 ? '' : line.slice(hashAt).trim()
    const [spec, marker] = req.split(/\s*;\s*/, 2)
    if (marker && !evalMarker(marker, env)) continue
    out.push([spec.trim(), ...hashes.split(/\s+(?=--hash)/).filter(Boolean)].join(' \\\n    '))
  }
  return out.join('\n') + '\n'
}

// ── the interpreter ─────────────────────────────────────────────────────────

/** Find the install_only CPython archive uv itself would download. */
function findPythonArchive(want, pbs) {
  const json = execFileSync('uv', ['python', 'list', '--all-platforms', '--all-arches', '--all-versions',
    '--only-downloads', '--show-urls', '--output-format', 'json'],
  { encoding: 'utf8', maxBuffer: 64 << 20 })
  const key = (v) => v.split('.').map(Number)
  const newer = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0 }
  const hits = JSON.parse(json).filter((p) =>
    p.implementation === 'cpython' && p.variant === 'default' && p.url &&
    p.os === pbs.os && p.arch === pbs.arch && (!pbs.libc || p.libc === pbs.libc) &&
    (p.version === want || p.version.startsWith(`${want}.`)) && !p.version.includes('-'))
  if (!hits.length) throw new Error(`uv knows no CPython ${want} download for ${pbs.os}/${pbs.arch}`)
  hits.sort((a, b) => newer(b.version, a.version))
  return hits[0]
}

/** The mirror-relative path: what follows `/releases/download/`, URL-decoded. */
function mirrorPath(url) {
  const marker = '/releases/download/'
  const at = url.indexOf(marker)
  if (at < 0) throw new Error(`cannot place ${url} under a mirror: no ${marker}`)
  return decodeURIComponent(url.slice(at + marker.length))
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function zipDir(dir, zipPath) {
  rmSync(zipPath, { force: true })
  if (process.platform === 'win32') {
    // bsdtar ships with Windows 10+ and writes a zip for `-a` on a .zip name.
    // Named by full path: under Git Bash `tar` is GNU tar, which has no -a.
    const bsdtar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
    execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, '-C', dir, '.'], { stdio: 'inherit' })
    return
  }
  try {
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: dir, stdio: 'inherit' })
  } catch {
    execFileSync('python3', ['-m', 'zipfile', '-c', zipPath, '.'], { cwd: dir, stdio: 'inherit' })
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const flags = parseFlags(process.argv.slice(2))
const electronDir = resolve(flags['electron-dir'] ?? process.cwd())
let pkg = {}
try { pkg = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')) } catch { /* flags only */ }
const cfg = pkg.deShell ?? {}

const appId = flags['app-id'] ?? cfg.appId
if (!appId) throw new Error('appId is required: pass --app-id or set deShell.appId in electron/package.json')
const version = flags.version ?? pkg.version
if (!version) throw new Error('no app version: pass --version or set "version" in electron/package.json')
const platform = flags.platform
if (!platform) throw new Error('--platform is required (e.g. win_amd64)')
const target = describePlatform(platform)
const projectRoot = resolve(electronDir, flags['project-root'] ?? cfg.projectRoot ?? '..')
// --extra replaces deShell.wheelhouseExtras rather than adding to it; --no-extras
// is the way to say "none" when the config names some (a CPU-only wheelhouse).
if (flags['no-extras'] && flags.extra.length) throw new Error('--no-extras and --extra are mutually exclusive')
const extras = flags['no-extras'] ? []
  : flags.extra.length ? flags.extra : (cfg.wheelhouseExtras ?? [])
const outDir = resolve(electronDir, flags.out ?? `wheelhouse-${platform}`)
const appName = (flags['app-name'] ?? cfg.productName ?? appId).replace(/\s+/g, '-')

let pyWant = flags['python-version'] ?? cfg.pythonVersion
if (!pyWant) {
  try { pyWant = readFileSync(join(projectRoot, '.python-version'), 'utf8').split(/\r?\n/)[0].trim() } catch { /* below */ }
}
if (!pyWant) throw new Error('no interpreter version: pass --python-version or commit a .python-version')
const archive = findPythonArchive(pyWant, target.pbs)
const pyFull = archive.version
const pyMinor = pyFull.split('.').slice(0, 2).join('.')
log(`app ${appId} ${version}, ${platform}, CPython ${pyFull}, extras [${extras.join(', ')}]`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// 1. The locked requirement set.
const exportArgs = ['export', '--frozen', '--no-dev', '--no-emit-project', '--no-emit-workspace',
  '--no-header', '--no-annotate']
if (flags.package) exportArgs.push('--package', flags.package)
for (const x of extras) exportArgs.push('--extra', x)
const exported = execFileSync('uv', exportArgs, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 << 20 })
const reqText = filterRequirements(exported, { ...target.env, extras,
  python_version: pyMinor, python_full_version: pyFull,
  implementation_name: 'cpython', platform_python_implementation: 'CPython' })
// A git / path / URL requirement has no hash and no wheel to download, and pip
// would fail on it with a message about hashing version-control repositories.
// Say what is actually wrong: a wheelhouse can only carry index-published
// packages, so such a source has to be released (or become a workspace member,
// which bundle-python ships as a wheel) first.
const unhashable = reqText.split(/\r?\n/)
  .filter((l) => /^\s*[A-Za-z0-9._-]+(\[[^\]]*\])?\s*@\s*\S/.test(l) || /^\s*(-e\s|git\+|file:|\.{1,2}[\\/])/.test(l))
if (unhashable.length) {
  throw new Error('the lock has dependencies that are not on a package index, so they cannot go in a '
    + `wheelhouse:\n  ${unhashable.map((l) => l.trim()).join('\n  ')}\n`
    + 'Publish them, or make them workspace members, first.')
}
const reqFile = join(outDir, '..', `.${basename(outDir)}.requirements.txt`)
writeFileSync(reqFile, reqText)

// 2. The wheels.
try {
  const pipArgs = ['tool', 'run', 'pip', 'download', '-r', reqFile, '-d', outDir,
    '--only-binary=:all:', '--no-deps', '--python-version', pyMinor, '--implementation', 'cp']
  for (const p of target.pip) pipArgs.push('--platform', p)
  execFileSync('uv', pipArgs, { stdio: 'inherit' })
} finally {
  rmSync(reqFile, { force: true })
}
const wheels = readdirSync(outDir).filter((f) => f.endsWith('.whl'))
log(`${wheels.length} wheel(s)`)

// 3. The interpreter, at the mirror layout.
const rel = mirrorPath(archive.url)
log(`python archive ${rel}`)
await download(archive.url, join(outDir, 'python', ...rel.split('/')))

// 4. The manifest pythonEnv.ts keys on.
writeFileSync(join(outDir, 'wheelhouse.json'),
  JSON.stringify({ app: appId, version, platform, python: pyFull, extras }, null, 2) + '\n')

if (flags.zip) {
  const zipPath = join(dirname(outDir), `${appName}-${version}-wheels-${platform}.zip`)
  zipDir(outDir, zipPath)
  log(`zip -> ${zipPath}`)
}
log(`done -> ${outDir}`)

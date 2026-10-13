# DE Shell

[![PyPI](https://img.shields.io/pypi/v/de-shell.svg)](https://pypi.org/project/de-shell/)
[![CI](https://github.com/directelectron/de-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/directelectron/de-shell/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The substrate Direct Electron's desktop apps are assembled from: **SpyDE**
(offline analysis), **Ground Crew** (manual camera control) and **Autopilot**
(automated acquisition). Each app is an Electron window over a Python
sidecar, and everything the three have in common lives here — the
Python↔JS message pipe, the window and its menus, the figure bridge over
[anyplotlib](https://pypi.org/project/anyplotlib/), the sidecar process
manager and its Python environment, the updater, the problem reporter, the
Playwright harness.

It contains **no domain logic**. No detectors, no microscopes, no signal
types, no analysis. `tests/test_boundary.py` enforces that in a clean
subprocess: the shell must stay installable without the science stack, so
the live in-memory apps never acquire it transitively.

```bash
pip install de-shell
```

## One package

The shell is **one pip package**, and the TypeScript rides inside the wheel:

```
pyproject.toml          the package: de-shell
de_shell/               app loop, session base, actions, IPC, figures, compute, logging
de_shell/js/            the TypeScript half, one folder per Electron target
  main/                 Electron main: window, sidecar + stdout demuxer, python env, updater, reports
  preload/              the contextBridge surface (exposeShellBridge)
  renderer/             React: figure bridge, FigureFrame, the chrome slice of state
  testing/              the Playwright harness (launchApp)
tests/                  the Python suite (incl. the boundary test)
package.json            DEV ONLY: typechecks and unit-tests de_shell/js; nothing is published to npm
```

The JavaScript that speaks the sidecar protocol ships in the same artifact
as the Python that speaks it. One `pip install -U de-shell` moves both, and
an app cannot end up with the two halves at different versions. The
TypeScript is shipped as **source** and compiled by the consuming app's
bundler, so there is no build step here and an editable install is
live-editable from the app.

## Consuming it

**Python** — an ordinary dependency:

```toml
dependencies = ["de-shell>=0.2,<0.3"]
```

For hacking on the shell and an app at once, a sibling checkout as an
editable path source (uv) or `pip install -e ../de-shell` overlays it.

**Electron** — ask the installed package where its TypeScript is and link
it into the project at a fixed path, then alias and `paths` through the link:

```
python -m de_shell.js        # prints …/de_shell/js
```

The shell makes the link itself:

```
uv run python -m de_shell.js link electron          # electron/shell -> …/de_shell/js
```

That makes `electron/shell` a junction (a symlink off Windows) to that
folder. It re-points a stale link rather than trusting it, and refuses to
replace a real directory; `--soft` turns the refusal into a warning, which is
what npm's postinstall wants. The same logic ships as
`shell/packaging/shell-link.mjs` for the vite config to call on every build,
once the first link exists. The copies the apps carried as
`electron/scripts/shell-link.mjs` can go. With the link in place:

```ts
// electron.vite.config.ts
import { ensureShellLink } from './shell/packaging/shell-link.mjs'
const shell = ensureShellLink(__dirname)
resolve: { alias: { '@de/shell-main': resolve(shell, 'main', 'index.ts') },
           dedupe: ['react', 'react-dom'] }
```

```json
// tsconfig.json
"noEmit": true, "allowImportingTsExtensions": true,
"paths": { "@de/shell-main": ["./shell/main/index.ts"], … }
```

`dedupe` matters: an editable checkout carries its own `node_modules` for
its typecheck, and without it the renderer would bundle a second React. The
peer dependencies — react, electron, electron-updater, @playwright/test —
are the app's to declare; every app already does. The e2e specs take the
harness from `shell/testing/harness.cjs`.

All three apps are wired this way: Autopilot, SpyDE
([directelectron/spyde#152](https://github.com/directelectron/spyde/pull/152))
and Ground Crew ([directelectron/de_ground_crew#183](https://github.com/directelectron/de_ground_crew/pull/183)),
pinned to the `0.2` line.

## Shipping an app

An app ships as a per-user NSIS installer (an AppImage on Linux, a dmg on
macOS). The installer is about 150 MB because the Python environment is **not**
inside it. On first launch the shell builds the environment into `userData`,
and an update re-syncs it only when the lock changed. Everything the pipeline
needs lives in `shell/packaging/`.

**The app provides:**

* **A `deShell` block in `electron/package.json`.** This is read by
  `bundle-python.mjs` and `build-wheelhouse.mjs`:

  ```json
  "deShell": { "appId": "groundcrew", "pythonDist": "de-ground-crew",
               "pythonVersion": "3.13", "wheelhouseExtras": ["gpu"] }
  ```

* **`electron/electron-builder.yml`.** It extends the shell's base and adds
  only what is the app's own:

  ```yaml
  extends: shell/packaging/electron-builder.base.yml
  appId: com.directelectron.groundcrew
  productName: Ground Crew
  publish: { provider: github, owner: directelectron, repo: de_ground_crew }
  ```

* **`.github/workflows/release.yml`.** It calls the shared pipeline on a tag.
  The pipeline runs in the app's repo and publishes to the app's releases:

  ```yaml
  on: { push: { tags: ["v*"] } }
  jobs:
    release:
      permissions: { contents: write }
      uses: directelectron/de-shell/.github/workflows/electron-release.yml@v0.5.0
      with: { app-name: Ground Crew, wheelhouse-extras: gpu }
      secrets: inherit
  ```

  The workflow links the shell with `uv run --frozen --no-dev`, so it syncs the
  app's locked environment on the runner. It also attaches a
  `<App>-<ver>-wheels-win_amd64.zip` offline wheelhouse to the release, and
  signs Windows builds with Azure Trusted Signing when the `AZURE_*` secrets
  and the `azure-*` inputs are set.

* **Main-process wiring:**

  ```ts
  configureShell({ appId: 'groundcrew', appName: 'Ground Crew',
                   pythonModule: 'de_groundcrew', pythonDist: 'de-ground-crew',
                   gpuExtras: ['gpu'] })
  registerShellDialogs(); registerUpdaterIpc(); registerProblemReportIpc()
  const py = app.isPackaged
    ? await runEnvSetup(win, { isPackaged: true, resourcesPath: process.resourcesPath,
                               projectRoot, userData: app.getPath('userData') })
    : await resolvePythonEnv({ isPackaged: false, resourcesPath: '', projectRoot, userData: '' })
  ```

  The renderer shows `EnvSetupOverlay` while `state.envSetup` is set, and
  `UpdateCard`/`UpdateDialog` and `ReportProblemDialog` where the app wants
  them.

**Extras and the GPU.** `pythonExtras` are always installed. `gpuExtras` are
installed when `nvidia-smi` finds a device. `<APPID>_GPU=0|1` overrides the
probe either way.

**Offline sites.** Unzip the release's wheelhouse into the install
folder (next to the app's `.exe`) or into `userData/wheelhouse`, or let the
user choose it with "Install from a folder…" when the online install fails. The first launch then installs with no network:

* the interpreter comes from the wheelhouse's python-build-standalone mirror;
* the packages are the exported lock, installed with `uv pip install --offline
  --no-index --require-hashes`.

A frozen `uv sync --offline --find-links` cannot do this, because uv looks for
registry-locked wheels only in its cache. A GPU machine given a wheelhouse
built without the GPU extra installs CPU-only and remembers that. It does not
fail.

**No residue.** The env, the uv cache and uv's managed interpreters all live
under `userData`. The uninstaller offers to remove them. The answer defaults to
No, and is always No for silent runs and updates, so an update never
re-downloads the environment.

## Developing it

```bash
uv sync --extra tests && uv run pytest        # the Python suite
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install   # types only; drop the variable to run Electron
npm run typecheck                             # every target, tests included, under tsconfig.json
npm run test:unit                             # node --test over de_shell/js
uv build                                      # the wheel — CI checks it carries de_shell/js
```

The unit tests run under Node's native type stripping, which resolves
relative imports literally — so shell modules import their siblings with the
`.ts` extension spelled out, and every tsconfig that compiles them (this one
and each app's) sets `allowImportingTsExtensions`.

CI (`.github/workflows/ci.yml`) runs the Python suite on Linux, Windows and
macOS at the oldest and newest supported Python, the typecheck and unit
tests, and builds the wheel and checks what it carries.

## Releasing

The version is written once, in `de_shell/__init__.py`. To release:

1. Run **Prepare Release** from the Actions tab and pick the bump (`minor`,
   `bugfix`, `major`, `pre-release`, or `finalize` to drop a `bN` suffix). It
   bumps `__version__`, assembles `CHANGELOG.rst` from the news fragments in
   `upcoming_changes/`, runs the pre-flight checks, and opens a release PR that
   names the one tag that will pass.
2. Review and merge that PR, then tag the merge commit and push the tag — the
   PR body has the exact commands.

The tag has to match `__version__` exactly; going through the workflow makes
them agree by construction, because the PR *is* the bump. To assemble the
changelog by hand instead, `uv tool run towncrier build --version X.Y.Z` does
the same thing — but stage `upcoming_changes/` with `git add -A`, because
towncrier deletes the fragments it consumed and a plain `git add CHANGELOG.rst`
leaves the deletions behind for the next release to re-publish.

`.github/workflows/publish.yml` builds the distributions, refuses a tag that
does not match `__version__`, and uploads to PyPI through trusted publishing
— on pypi.org the project must list this repository, that workflow file and
the `pypi` environment as a publisher (no token lives in the repo). Semver,
with the 0.x caveat: a breaking change to the sidecar protocol bumps the
minor, and the apps pin `>=0.x,<0.(x+1)`.

## Provenance

Merged 2026-09-02 from the three vendored copies, three-way against the
SpyDE commit the app copies were taken from:

* SpyDE `main` @ 1f3331d (v0.4.3): the problem reporter (`errorReport`,
  `problemLog`, `sentryEnvelope`), `recentBackendOutput`, the workspace-member
  wheels in `pythonEnv`, the update handoff that tree-kills the sidecar first,
  `run_on_worker`'s in-flight count and `ComputeHandle` in `lifecycle.py`.
* Autopilot @ 7f0651e: the sidecar's close handler forgets only ITS child, the
  malformed-message report, the figure/stream fixes ported from the siblings,
  the renderer state and FigureFrame changes.
* Ground Crew `main` @ 26e853a: the spawn-error trap and 5 s tree-kill grace,
  the resolved `uv` path, the open-directory dialog, `_pin_tile_band` (black
  panes on large stills), JSON emit that never writes bare `NaN`, the harness
  hardening, and the unit tests for all of it.

* Ground Crew `main` @ 0382549 (0.2.1): the chunk-list stdout demuxer, the
  size reporter and StrictMode-safe registration in `FigureFrame`, the figure
  document's scroll pin, and the anyplotlib 0.8.0 floor.

## Rules

* **Nothing here mentions a detector, a signal type, or an analysis.** If
  extracting something into the shell requires touching one, the boundary is
  in the wrong place.
* **The Python side stays tiny.** Every dependency added is one all three
  apps install: numpy, anyplotlib, pyyaml, and that is the list.
* **The protocol is the contract.** `PLOTAPP:` JSON lines and `PLOTBIN:`
  binary frames over the sidecar's stdio. Both halves of it live in this one
  package on purpose; keep it that way.
* **Every pull request carries its own changelog entry**, as a news fragment
  under [`upcoming_changes/`](upcoming_changes/README.rst) — one file per PR,
  so two of them never conflict over the same lines of `CHANGELOG.rst`.
* **LF line endings**, enforced by `.gitattributes`.

## License

MIT — see [LICENSE](LICENSE).

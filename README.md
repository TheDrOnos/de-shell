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

Autopilot's `electron/scripts/shell-link.mjs` is the reference: it makes
`electron/shell` a junction (a symlink off Windows) to that folder, runs from
npm's postinstall and from the vite config on every build, and re-points a
stale link rather than trusting it. With it in place:

```ts
// electron.vite.config.ts
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

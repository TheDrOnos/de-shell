=========
Changelog
=========

All notable changes to ``de-shell`` are recorded here. Entries are written per
pull request as fragment files under ``upcoming_changes/`` and assembled at
release time by `towncrier <https://towncrier.readthedocs.io/>`_ — see
``upcoming_changes/README.rst``.

Versioning is `semver <https://semver.org/>`_ with the 0.x caveat: a breaking
change to the sidecar protocol bumps the minor.

.. towncrier release notes start

0.5.0b1 (2026-10-13)
====================

API and Behaviour Changes
-------------------------

- In packaged builds, the Python environment now uses only interpreters it
  manages itself, and they live under ``<userData>/python``. An uninstall can
  therefore remove everything the app downloaded.

  * Every packaged uv call sets ``UV_PYTHON_INSTALL_DIR`` to ``<userData>/python``.
    Previously uv used ``%APPDATA%\uv\python``, which no uninstaller owns.
  * Every packaged uv call also sets ``UV_PYTHON_INSTALL_BIN=0`` and
    ``UV_PYTHON_INSTALL_REGISTRY=0``. This stops uv leaving a ``python3.X``
    launcher in ``~/.local/bin`` and a PEP 514 registry entry.
  * Every packaged uv call sets ``UV_MANAGED_PYTHON=1``, so the env never links to
    a Python found on ``PATH``.
  * An existing environment keeps working until its next re-sync, which happens
    when the lock or the extras change. That re-sync may rebuild it once on an
    interpreter in the new location. (`#15 <https://github.com/directelectron/de-shell/pull/15>`_)


New Features
------------

- The packaged first-run environment (``resolvePythonEnv``) can now install
  optional extras and works offline.

  * ``ShellConfig`` takes ``pythonExtras``, which are always installed, and
    ``gpuExtras``. The GPU extras are added only when ``nvidia-smi`` finds a
    device. An app or user can override the probe with ``EnsureOptions.gpu`` or
    ``<APPID>_GPU=0|1``.
  * The lock stamp now records the chosen extras. A machine that gains a GPU, or
    an app that adds an extra, re-syncs. Installs with no extras keep the old
    stamp and do not re-sync on upgrade.
  * An **offline wheelhouse** installs with no network at all. It is a folder
    holding ``wheelhouse.json``, every locked wheel and a python-build-standalone
    mirror, built by ``packaging/build-wheelhouse.mjs``. The install is the
    interpreter from the mirror, then a hash-checked ``uv pip install --offline
    --no-index`` of the exported lock.
  * The wheelhouse is looked for in ``EnsureOptions.wheelhouse``,
    ``<APPID>_WHEELHOUSE``, ``<resources>/wheelhouse``, ``<userData>/wheelhouse``
    and next to the executable.
  * A probed GPU whose extras the wheelhouse lacks falls back to a CPU install.
    It does not fail, and later launches remember the choice. A GPU the user
    asked for explicitly still fails if its extras are missing.

  The packaging pipeline that SpyDE ships with now lives in the shell, so apps no
  longer keep their own copies. It is in ``de_shell/js/packaging/``, which
  reaches an app as ``electron/shell/packaging/``:

  * ``python -m de_shell.js link <electronDir> [--soft]`` makes the
    ``electron/shell`` link. It replaces the ``scripts/shell-link.mjs`` each app
    carried, and a generalised ``shell-link.mjs`` ships as well for apps that
    want a node script. Unlike the old script, both refuse to replace a real
    directory.
  * ``bundle-python.mjs`` stages the ``<resources>/python`` payload: the lock,
    the app and workspace-member wheels, a pinned ``uv``, and optionally MinGit.
    It is configured by flags or a ``deShell`` block in ``electron/package.json``.
  * ``build-wheelhouse.mjs`` builds the offline wheelhouse for one target
    platform. It evaluates markers for the target rather than the build host, and
    can optionally zip the result.
  * ``installer.nsh`` replaces electron-builder's dead-end "cannot be closed"
    check with a tree-kill of the app and of its sidecar, limited to this app's
    own data. It also *offers* to remove the managed environment on uninstall.
    The answer defaults to No, and is always No for silent and update runs.
  * ``electron-builder.base.yml`` is a shared base config for an app to
    ``extends``.
  * ``.github/workflows/electron-release.yml`` is a reusable release workflow
    (``workflow_call``). It handles stable/beta channels and the draft →
    build-matrix → finalize sequence. It also attaches the Windows offline
    wheelhouse zip, and signs with Azure Trusted Signing when the secrets are
    present.

  First-run setup, updates and problem reports can now each be wired with one
  call.

  * **Main process:**
    * ``runEnvSetup(win, opts)`` wraps ``resolvePythonEnv``. It streams throttled
      ``env_setup`` messages to the renderer. On failure it waits for the user
      rather than rejecting: Retry, install from a folder (a wheelhouse) or Quit.
    * ``registerUpdaterIpc()`` and ``registerProblemReportIpc()`` register the
      namespaced channels over the existing updater and reporter.
  * **Preload:** ``createShellBridge`` gains ``updater``, ``report`` and
    ``envSetup``. ``ShellBridge`` is exported as a type, so apps no longer
    restate the bridge's shape.
  * **Renderer:** ``EnvSetupOverlay``, ``UpdateCard``, ``UpdateDialog``,
    ``ReportProblemDialog`` and ``useUpdateStatus``. These are generalised from
    SpyDE, with every string taken from props and colours from ``--shell-*``
    CSS variables. ``shellReducer`` gains ``ENV_SETUP_ERROR`` and still accepts
    the old ``env_setup`` message shape. (`#15 <https://github.com/directelectron/de-shell/pull/15>`_)


Bug Fixes
---------

- The packaged sidecar runs from its Python environment rather than the install
  directory, so a Windows update can remove the old version. Its working
  directory used to hold the install directory open, and the update stalled at
  "cannot be closed. Please close it manually and click Retry". (`#4 <https://github.com/directelectron/de-shell/pull/4>`_)


0.4.0 (2026-09-26)
==================

New Features
------------

- Apps gained a way to serve their backend's protocol to a remote client: ``createRelay`` (exported from ``@de/shell-main`` with the ``encodeMessage`` and ``encodeBinary`` encoders) listens on a TCP port and speaks the PLOTAPP/PLOTBIN framing, and ``de_shell.remote_client`` is its synchronous, standard-library Python client. (`#12 <https://github.com/directelectron/de-shell/pull/12>`_)


0.3.0 (2026-09-24)
==================

Bug Fixes
---------

- An end-to-end launch through the testing harness left its temporary Electron
  profile directory behind — a few megabytes per launch, and a downstream app's
  full suite added about 150. ``closeApp`` now removes it once the process is
  down, on the clean-close, hard-kill and no-app paths alike, and ``launchApp``
  reports the path as ``profileDir``. (`#2 <https://github.com/directelectron/de-shell/pull/2>`_)


Maintenance
-----------

- A **Prepare Release** workflow bumps the version, assembles the changelog and
  opens the release pull request, so the tag and ``de_shell.__version__`` agree by
  construction rather than being checked against each other after the tag is
  pushed. (`#7 <https://github.com/directelectron/de-shell/pull/7>`_)
- The changelog is now assembled by `towncrier
  <https://towncrier.readthedocs.io/>`_ from one news fragment per pull request
  under ``upcoming_changes/``, as SpyDE and anyplotlib already do, and lives in
  ``CHANGELOG.rst`` rather than ``CHANGELOG.md``.


0.2.2 (2026-09-22)
==================

New Features
------------

- ``FigureView.add_rectangle_widget``: a draggable rectangle with an optional
  ``max_extent`` size cap; ``on_change(x, y, w, h)`` fires when a drag settles.
- ``FigureView.add_texts``: text labels at image-pixel positions, with an
  optional halo; the same ``name`` replaces them in place.
- ``FigureView.set_readout_visible`` and ``FigureFrame``'s ``onReadout``: every
  figure frame relays anyplotlib's hover readout to the host page, so an app
  can hide the on-image pill and print the position and value in its own units.

API and Behaviour Changes
-------------------------

- anyplotlib floor raised to 0.10.0, for the readout event and text halos.

0.2.1 (2026-09-02)
==================

Ground Crew's shell work from after the merge base, so it can move onto the
package too.

New Features
------------

- ``createStdoutDemux`` (main): the sidecar's stdout demuxer as a chunk-list
  accumulator that copies each byte once. The inline parser re-copied the whole
  buffered prefix per chunk, O(N^2/chunkSize) while a large frame streamed in
  (11.9 s per 64 MB frame at 64 KiB chunks). A malformed ``PLOTAPP:`` line is
  now reported on stderr rather than swallowed.
- ``createSizeReporter`` (renderer): ``FigureFrame`` skips the zero-size first
  layout and any resize whose rounded size is unchanged, and holds its
  ``onResize`` in a ref so an inline callback no longer re-runs the effect
  (measured at ~1,500 sends/s over constant geometry before).
- ``attachFigure`` (renderer): figure registration is owned by an effect and
  re-registers on every run, so React StrictMode's double-invoke no longer
  leaves a figure registered nowhere with its pane black.
- ``PIN_SCROLL``: every figure document undoes the focus-scroll that shifted a
  fresh pane by half its overflow on first hover.

API and Behaviour Changes
-------------------------

- anyplotlib floor raised to 0.8.0, for its fix to a tiled image born on a
  placeholder rendering solid black.

0.2.0 (2026-09-02)
==================

The first release as its own package. Until now the shell lived as a vendored
copy inside each of SpyDE, Ground Crew and Autopilot, and the three had
diverged.

New Features
------------

- **One package.** The TypeScript half (``de_shell/js``: the Electron main
  process, the preload bridge, the React renderer kernel, the Playwright
  harness) ships inside the wheel, so ``pip install -U de-shell`` moves both
  halves of the sidecar protocol together. ``python -m de_shell.js`` prints
  where the tree is; apps link it into their Electron project.
- From SpyDE 0.4.3: the problem reporter (``errorReport``, ``problemLog``,
  ``sentryEnvelope``), ``recentBackendOutput``, workspace-member wheels in the
  environment setup, an update handoff that tree-kills the sidecar first,
  ``run_on_worker``'s in-flight count and ``ComputeHandle`` for cancelling a
  superseded compute.
- From Ground Crew: the sidecar spawn-error trap, a 5 s tree-kill grace, a
  resolved ``uv`` path, the open-directory dialog channel, ``_pin_tile_band``
  for large stills, JSON emit that never writes bare ``NaN``, harness
  hardening, and the unit tests for all of it.
- From Autopilot: the close handler forgets only its own child process, a
  report for malformed protocol messages, ``useFigureEventForwarding``, and a
  ``LOG_CLEAR`` action in the renderer state.

API and Behaviour Changes
-------------------------

- License: MIT (the vendored copies were GPL-3.0-or-later inside SpyDE).
- Line endings are LF throughout, enforced by ``.gitattributes``.

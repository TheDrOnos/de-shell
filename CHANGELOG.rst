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

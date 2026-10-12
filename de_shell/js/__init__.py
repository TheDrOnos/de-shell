"""The TypeScript half of the shell, shipped inside the wheel.

Four folders, one per Electron target (plus ``packaging/``, below), each a self-contained tree of
TypeScript that the consuming app's bundler compiles:

* ``main/``     — the Electron main process: the window and menus, the Python
                  sidecar and its stdout demuxer, the managed environment, the
                  updater, the problem reporter.
* ``preload/``  — the contextBridge surface (``exposeShellBridge``).
* ``renderer/`` — React: the figure bridge over anyplotlib, ``FigureFrame``,
                  the chrome slice of the reducer.
* ``testing/``  — the Playwright harness (``launchApp``) the e2e specs use.

They live HERE rather than on npm so that the JavaScript that speaks the
sidecar protocol ships in the same artifact as the Python that speaks it: one
``pip install -U de-shell`` moves both halves together, and two versions of the
protocol in one app cannot happen. An app finds the tree by asking this module
(``python -m de_shell.js``) and links it into its Electron project — see the
README — which also makes an editable install live-editable.

``packaging/`` is not compiled into the app: it is the build-time half — the
Node scripts and config an app runs from its ``electron/`` directory to ship an
installer (``bundle-python.mjs``, ``build-wheelhouse.mjs``, ``shell-link.mjs``,
``installer.nsh``, ``electron-builder.base.yml``). ``python -m de_shell.js link
<electronDir>`` creates the ``shell`` link without needing any of them.

The peer dependencies (react, electron, electron-updater, @playwright/test) are
the app's to declare; every app already does.
"""
from __future__ import annotations

from pathlib import Path

TARGETS = ("main", "preload", "renderer", "testing", "packaging")


def path(target: str | None = None) -> Path:
    """The directory holding the TypeScript, or one target's folder."""
    root = Path(__file__).resolve().parent
    if target is None:
        return root
    if target not in TARGETS:
        raise ValueError(f"unknown shell target {target!r}; one of {TARGETS}")
    return root / target

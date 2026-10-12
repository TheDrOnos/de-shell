The packaged first-run environment (``resolvePythonEnv``) can now install
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

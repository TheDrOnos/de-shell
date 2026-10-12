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

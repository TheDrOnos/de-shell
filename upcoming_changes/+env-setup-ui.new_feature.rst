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
  the old ``env_setup`` message shape.

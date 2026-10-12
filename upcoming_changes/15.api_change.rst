Packaged builds now keep uv-managed Python interpreters under
``<userData>/python`` (``UV_PYTHON_INSTALL_DIR``), so an uninstall can remove
everything the app downloaded. Previously uv put them in ``%APPDATA%\uv\python``,
which no uninstaller owns.

Existing environments keep working, because a venv records its interpreter's
path in ``pyvenv.cfg``. Only new or rebuilt environments use the new location.

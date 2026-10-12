"""``python -m de_shell.js`` — where the TypeScript is, and how to link it.

    python -m de_shell.js                          print …/de_shell/js (build scripts rely on this)
    python -m de_shell.js link <electronDir> [--soft]
                                                    make <electronDir>/shell point at it

``link`` is the Python twin of ``packaging/shell-link.mjs``: a junction on
Windows (no admin or developer mode needed, unlike a symlink), a symlink
elsewhere. CI and ``postinstall`` use it so an app does not need to carry its
own copy of the script. Semantics, identical to the mjs:

* an up-to-date link is left alone;
* a stale link (a venv that moved, an editable install that was re-pointed) is
  re-pointed, never trusted;
* a REAL directory at the link path is refused, not deleted — someone put it
  there, and a build script has no business removing it;
* ``--soft`` turns every failure into a warning and exit 0, for an ``npm
  install`` that runs before the first ``uv sync``.
"""
from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

from . import path

_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class LinkError(RuntimeError):
    pass


def _is_link(p: Path) -> bool:
    """A symlink OR a Windows junction (``Path.is_symlink`` misses junctions
    before 3.12, and a junction is exactly what we create there)."""
    try:
        st = os.lstat(p)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    return bool(getattr(st, "st_file_attributes", 0) & _REPARSE_POINT)


def _unlink(p: Path) -> None:
    # rmdir removes a junction / directory symlink without touching its target
    # on Windows; unlink is the POSIX spelling. Try both.
    try:
        os.unlink(p)
    except OSError:
        os.rmdir(p)


def _make_link(link: Path, target: Path) -> None:
    if os.name != "nt":
        os.symlink(target, link, target_is_directory=True)
        return
    try:
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    except (ImportError, AttributeError, OSError):
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise LinkError(f"could not create a junction at {link}: {(r.stderr or r.stdout).strip()}")


def link(electron_dir: str | os.PathLike, *, quiet: bool = False) -> Path:
    """Make ``<electron_dir>/shell`` point at this install's ``de_shell/js``."""
    electron_dir = Path(electron_dir)
    if not electron_dir.is_dir():
        raise LinkError(f"{electron_dir} is not a directory")
    target = path().resolve()
    lnk = electron_dir / "shell"
    if _is_link(lnk):
        if lnk.resolve() == target:
            return lnk
        _unlink(lnk)
    elif lnk.exists():
        raise LinkError(f"{lnk} exists and is not a link; refusing to replace it. Remove it by hand.")
    _make_link(lnk, target)
    if not quiet:
        print(f"[shell-link] {lnk} -> {target}")
    return lnk


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(path())
        return 0
    if argv[0] != "link":
        print(f"usage: python -m de_shell.js [link <electronDir> [--soft]]", file=sys.stderr)
        return 2
    soft = "--soft" in argv
    rest = [a for a in argv[1:] if a != "--soft"]
    if len(rest) != 1:
        print("usage: python -m de_shell.js link <electronDir> [--soft]", file=sys.stderr)
        return 2
    try:
        link(rest[0])
    except (LinkError, OSError) as err:
        if not soft:
            print(f"[shell-link] {err}", file=sys.stderr)
            return 1
        print(f"[shell-link] not linked yet: {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

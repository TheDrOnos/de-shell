"""``python -m de_shell.js`` and its ``link`` subcommand (de_shell/js/__main__.py)."""
from __future__ import annotations

import os
import subprocess
import sys

import pytest

import de_shell.js as shell_js
from de_shell.js import __main__ as cli

TARGET = shell_js.path().resolve()


def test_no_args_prints_the_path(capsys):
    assert cli.main([]) == 0
    assert capsys.readouterr().out.strip() == str(shell_js.path())


def test_no_args_as_a_module_is_unchanged():
    # What shell-link.mjs and every app's build scripts shell out to.
    out = subprocess.run([sys.executable, "-m", "de_shell.js"], capture_output=True,
                         text=True, check=True).stdout
    assert out.strip().splitlines()[-1] == str(shell_js.path())


def test_packaging_is_a_target():
    assert shell_js.path("packaging").name == "packaging"
    assert (shell_js.path("packaging") / "bundle-python.mjs").is_file()


def test_link_creates(tmp_path, capsys):
    assert cli.main(["link", str(tmp_path)]) == 0
    link = tmp_path / "shell"
    assert cli._is_link(link)
    assert link.resolve() == TARGET
    assert (link / "main" / "index.ts").is_file()


def test_link_is_idempotent(tmp_path, capsys):
    cli.main(["link", str(tmp_path)])
    capsys.readouterr()
    assert cli.main(["link", str(tmp_path)]) == 0
    assert capsys.readouterr().out == ""  # an up-to-date link is left alone


def test_link_repoints_a_stale_link(tmp_path):
    stale = tmp_path / "elsewhere"
    stale.mkdir()
    (stale / "keep.txt").write_text("x")
    cli._make_link(tmp_path / "shell", stale)
    assert (tmp_path / "shell").resolve() == stale.resolve()
    assert cli.main(["link", str(tmp_path)]) == 0
    assert (tmp_path / "shell").resolve() == TARGET
    assert (stale / "keep.txt").exists()  # the old target is never followed on removal


def test_link_refuses_a_real_directory(tmp_path, capsys):
    real = tmp_path / "shell"
    real.mkdir()
    (real / "mine.txt").write_text("precious")
    assert cli.main(["link", str(tmp_path)]) == 1
    assert "not a link" in capsys.readouterr().err
    assert (real / "mine.txt").read_text() == "precious"
    assert not cli._is_link(real)


def test_soft_turns_failure_into_a_warning(tmp_path, capsys):
    (tmp_path / "shell").mkdir()
    assert cli.main(["link", str(tmp_path), "--soft"]) == 0
    assert "not linked yet" in capsys.readouterr().err
    assert cli.main(["link", str(tmp_path / "missing"), "--soft"]) == 0


def test_missing_electron_dir_is_an_error(tmp_path, capsys):
    assert cli.main(["link", str(tmp_path / "missing")]) == 1


def test_usage_errors(capsys):
    assert cli.main(["link"]) == 2
    assert cli.main(["bogus"]) == 2

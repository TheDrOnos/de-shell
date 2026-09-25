"""
test_remote_client.py — the synchronous relay client.

The decoder is fed bytes written by the REAL Python writers (ipc.emit,
ipc._write_line, and anyplotlib's encode_frame through ipc._write_binary)
across a socketpair, whole and one byte at a time, and must produce the same
trace both ways.
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys

import pytest
from anyplotlib._binary_frame import encode_frame

from de_shell import ipc
from de_shell.remote_client import _Decoder

NASTY = b"\nPLOTBIN:9:9\nPLOTAPP:{}\n" + bytes(i & 0xFF for i in range(3000))


def _through_socketpair(monkeypatch, write) -> bytes:
    """Point ipc's protocol channel at one end of a socketpair, run ``write()``,
    and return every byte that came out of the other end. Kept a few KiB, well
    under any socketpair buffer, so nothing needs a reader thread."""
    a, b = socket.socketpair()
    try:
        out = a.makefile("w", encoding="utf-8", newline="\n")
        monkeypatch.setattr(ipc, "_PROTOCOL_OUT", out)
        write()
        out.flush()
        out.close()
        a.shutdown(socket.SHUT_WR)
        b.settimeout(5.0)
        data = bytearray()
        while chunk := b.recv(65536):
            data += chunk
        return bytes(data)
    finally:
        a.close()
        b.close()


def _write_session() -> None:
    ipc._write_line("starting up\n")
    ipc.emit({"type": "status", "text": "Cluster ready"})
    ipc._write_binary(encode_frame("f1", "image", {"dims": [2, 1500], "dtype": "uint8"}, NASTY))
    ipc.emit({"type": "fit", "label": "εxx Å", "value": float("nan")})  # ipc sanitizes NaN to null
    ipc._write_line("\n")
    ipc._write_line("   \n")
    ipc._write_line("mid-run log\n")
    ipc._write_binary(encode_frame("f2", "spec", {}, b""))
    ipc.emit({"type": "done"})


EXPECTED = [
    ("stream", "starting up"),
    ("message", {"type": "status", "text": "Cluster ready"}),
    ("binary", {"dims": [2, 1500], "dtype": "uint8", "fig_id": "f1", "key": "image"}, NASTY),
    ("message", {"type": "fit", "label": "εxx Å", "value": None}),
    ("stream", "mid-run log"),
    ("binary", {"fig_id": "f2", "key": "spec"}, b""),
    ("message", {"type": "done"}),
]


def _trace(data: bytes, step: int) -> list:
    decoder = _Decoder()
    units = []
    for pos in range(0, len(data), step):
        decoder.feed(data[pos:pos + step])
        while (unit := decoder.pop()) is not None:
            units.append(unit)
    assert decoder.buffered == 0, "bytes left over after the last unit"
    return units


def test_the_writers_output_decodes_to_the_expected_trace(monkeypatch):
    data = _through_socketpair(monkeypatch, _write_session)
    assert _trace(data, len(data)) == EXPECTED


def test_the_trace_is_the_same_one_byte_at_a_time(monkeypatch):
    data = _through_socketpair(monkeypatch, _write_session)
    assert _trace(data, 1) == EXPECTED
    assert _trace(data, 7) == EXPECTED


def test_a_frame_split_at_every_byte_reassembles():
    frame = encode_frame("x", "image", {"label": "εxx"}, NASTY[:64])
    whole = [("binary", {"label": "εxx", "fig_id": "x", "key": "image"}, NASTY[:64])]
    for cut in range(1, len(frame)):
        decoder = _Decoder()
        units = []
        for part in (frame[:cut], frame[cut:]):
            decoder.feed(part)
            while (unit := decoder.pop()) is not None:
                units.append(unit)
        assert units == whole, f"split at byte {cut}"


def test_a_malformed_prefix_raises_with_the_line_and_the_next_unit_decodes():
    decoder = _Decoder()
    decoder.feed(b'PLOTBIN:12:x\nPLOTAPP:{"type":"after"}\n')
    with pytest.raises(ValueError, match="PLOTBIN prefix") as excinfo:
        decoder.pop()
    assert excinfo.value.line == b"PLOTBIN:12:x"
    assert decoder.pop() == ("message", {"type": "after"})


def test_bad_json_after_plotapp_raises_with_the_line_and_the_next_unit_decodes():
    decoder = _Decoder()
    decoder.feed(b'PLOTAPP:{nope\nPLOTAPP:{"type":"after"}\n')
    with pytest.raises(ValueError, match="PLOTAPP message") as excinfo:
        decoder.pop()
    assert excinfo.value.line == "PLOTAPP:{nope"
    assert decoder.pop() == ("message", {"type": "after"})


def test_a_malformed_header_raises_after_consuming_the_frame():
    decoder = _Decoder()
    decoder.feed(b"PLOTBIN:7:3\n{brokenabc" + b'PLOTAPP:{"type":"after"}\n')
    with pytest.raises(ValueError, match="PLOTBIN header") as excinfo:
        decoder.pop()
    assert excinfo.value.line == b"{broken"
    assert decoder.pop() == ("message", {"type": "after"})


def test_crlf_is_stripped_and_bytes_that_are_not_utf8_become_replacement_characters():
    decoder = _Decoder()
    decoder.feed(b"log line\r\n" + b"f\xff\xfe\n")
    assert decoder.pop() == ("stream", "log line")
    assert decoder.pop() == ("stream", "f\ufffd\ufffd")
    assert decoder.pop() is None


def test_the_client_imports_only_the_standard_library():
    probe = (
        "import json, sys\n"
        "import de_shell.remote_client\n"
        "heavy = ('numpy', 'anyplotlib', 'asyncio', 'yaml')\n"
        "print(json.dumps(sorted(m for m in heavy if m in sys.modules)))\n"
    )
    proc = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip().splitlines()[-1]) == []

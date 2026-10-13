"""
test_remote_client.py — the synchronous relay client.

The decoder is fed bytes written by the REAL Python writers (ipc.emit,
ipc._write_line, and anyplotlib's encode_frame through ipc._write_binary)
across a socketpair, whole and one byte at a time, and must produce the same
trace both ways.
"""
from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from anyplotlib._binary_frame import encode_frame

from de_shell import ipc, remote_client
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


def test_an_overlong_prefix_number_raises_with_the_line_and_the_decoder_recovers():
    decoder = _Decoder()
    decoder.feed(b"PLOTBIN:" + b"9" * 5000 + b":1\nPLOTAPP:{}\n")
    with pytest.raises(ValueError, match="PLOTBIN prefix") as excinfo:
        decoder.pop()
    assert excinfo.value.line == b"PLOTBIN:" + b"9" * 5000 + b":1"
    assert decoder.pop() == ("message", {})


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


# --- Connection, on a loopback TCP pair ---------------------------------------


@pytest.fixture
def pair():
    """A client Connection and the raw server-side socket it is connected to."""
    server = socket.create_server(("127.0.0.1", 0))
    port = server.getsockname()[1]
    conn = remote_client.connect("127.0.0.1", port, timeout=5.0)
    peer, _ = server.accept()
    server.close()
    peer.settimeout(5.0)
    try:
        yield conn, peer, port
    finally:
        conn.close()
        peer.close()


def _read_line(sock: socket.socket) -> bytes:
    data = bytearray()
    while not data.endswith(b"\n"):
        chunk = sock.recv(65536)
        assert chunk, "the client closed before a full line"
        data += chunk
    return bytes(data)


def test_connect_reports_the_remote(pair):
    conn, _, port = pair
    assert conn.remote == ("127.0.0.1", port)


def test_send_writes_one_compact_json_line(pair):
    conn, peer, _ = pair
    obj = {"type": "hello", "note": "εxx Å", "text": "a\nb"}
    conn.send(obj)
    line = _read_line(peer)
    assert line == (json.dumps(obj, separators=(",", ":")) + "\n").encode("ascii")
    assert line.count(b"\n") == 1
    assert json.loads(line) == obj


def test_send_refuses_a_non_finite_number_and_writes_nothing(pair):
    conn, peer, _ = pair
    with pytest.raises(ValueError):
        conn.send({"type": "fit", "value": float("nan")})
    conn.send({"ok": True})
    assert _read_line(peer) == b'{"ok":true}\n'


def test_recv_returns_each_unit_kind(pair):
    conn, peer, _ = pair
    peer.sendall(
        b'PLOTAPP:{"type":"a"}\n'
        + encode_frame("f", "k", {}, b"\x00\n\x01")
        + b"log line\r\n"
    )
    assert conn.recv(timeout=5) == ("message", {"type": "a"})
    assert conn.recv(timeout=5) == ("binary", {"fig_id": "f", "key": "k"}, b"\x00\n\x01")
    assert conn.recv(timeout=5) == ("stream", "log line")


def test_recv_timeout_raises_and_keeps_the_partial_unit(pair):
    conn, peer, _ = pair
    frame = encode_frame("f", "image", {"n": 1}, b"\x00\n\x01PLOTBIN:")
    peer.sendall(b'PLOTAPP:{"type":"par')
    with pytest.raises(TimeoutError):
        conn.recv(timeout=0.2)
    peer.sendall(b'tial"}\n' + frame[:10])
    assert conn.recv(timeout=5) == ("message", {"type": "partial"})
    with pytest.raises(TimeoutError):
        conn.recv(timeout=0.2)
    peer.sendall(frame[10:])
    assert conn.recv(timeout=5) == (
        "binary", {"n": 1, "fig_id": "f", "key": "image"}, b"\x00\n\x01PLOTBIN:",
    )


def test_units_received_before_eof_come_first_then_connection_error(pair):
    conn, peer, _ = pair
    peer.sendall(b'PLOTAPP:{"type":"last"}\n')
    peer.shutdown(socket.SHUT_WR)
    assert conn.recv(timeout=5) == ("message", {"type": "last"})
    with pytest.raises(ConnectionError):
        conn.recv(timeout=5)


def test_eof_inside_a_unit_raises_connection_error(pair):
    conn, peer, _ = pair
    peer.sendall(b'PLOTAPP:{"type":')
    peer.shutdown(socket.SHUT_WR)
    with pytest.raises(ConnectionError, match="incomplete"):
        conn.recv(timeout=5)


def test_a_malformed_unit_on_the_wire_raises_value_error_and_the_next_one_decodes(pair):
    conn, peer, _ = pair
    peer.sendall(b'PLOTBIN:12:x\nPLOTAPP:{"type":"after"}\n')
    with pytest.raises(ValueError) as excinfo:
        conn.recv(timeout=5)
    assert excinfo.value.line == b"PLOTBIN:12:x"
    assert conn.recv(timeout=5) == ("message", {"type": "after"})


def test_close_is_idempotent_and_later_calls_raise_connection_error(pair):
    conn, _, _ = pair
    conn.close()
    conn.close()
    with pytest.raises(ConnectionError):
        conn.recv(timeout=0.1)
    with pytest.raises(ConnectionError):
        conn.send({"type": "late"})


def test_a_short_recv_poll_on_one_thread_does_not_break_a_long_send_on_another(pair):
    # The connector's shape: one thread polls recv() with a short timeout while
    # another sends. A per-call socket timeout would cut a blocked send short
    # (TimeoutError partway through a line: a corrupt stream); the client waits
    # on a selector instead. Many 1 MiB sends, not one big one: Windows accepts
    # a single large non-blocking send whole, so only later sends ever block.
    conn, peer, _ = pair
    count = 32
    stop = threading.Event()
    errors: list[BaseException] = []

    def poll() -> None:
        while not stop.is_set():
            try:
                conn.recv(timeout=0.01)
            except TimeoutError:
                continue
            except BaseException as e:
                errors.append(e)
                return

    received = bytearray()

    def slow_reader() -> None:
        time.sleep(0.3)  # the sends block on full socket buffers while the poller runs
        try:
            while received.count(b"\n") < count:
                chunk = peer.recv(1 << 16)
                if not chunk:
                    return
                received.extend(chunk)
        except OSError:
            return  # the sender gave up; the assertions below say why

    poller = threading.Thread(target=poll, daemon=True)
    reader = threading.Thread(target=slow_reader, daemon=True)
    poller.start()
    reader.start()
    block = "x" * (1 << 20)
    try:
        for i in range(count):
            conn.send({"type": "blob", "i": i, "data": block})
    finally:
        reader.join(timeout=30)
        stop.set()
        poller.join(timeout=5)
    assert errors == []
    lines = bytes(received).splitlines()
    assert [json.loads(line)["i"] for line in lines] == list(range(count))
    assert all(json.loads(line)["data"] == block for line in lines)


# --- cross-runtime: a real createRelay under Node -----------------------------

REPO = Path(__file__).resolve().parents[1]
HELPER = Path(__file__).with_name("relay_echo_server.mjs")

# The frame the helper sends after the first line: every byte value, plus
# newline and marker lookalikes inside the payload.
_probe = bytearray(i & 0xFF for i in range(256 * 1024))
_probe[1000:1013] = b"\nPLOTBIN:9:9\n"
PROBE = bytes(_probe)


def _node_that_strips_types() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not on PATH")
    probe = subprocess.run(
        [node, "-p", "Boolean(process.features.typescript)"],
        capture_output=True, text=True, timeout=60,
    )
    if probe.stdout.strip() != "true":
        pytest.skip("node on PATH cannot strip TypeScript types (needs Node >= 22.18)")
    return node


@pytest.fixture
def relay():
    """The helper running a real createRelay; yields (port, process)."""
    node = _node_that_strips_types()
    proc = subprocess.Popen(
        [node, str(HELPER)], cwd=REPO,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        first = proc.stdout.readline().decode("ascii", "replace").strip()
        if not first.startswith("PORT "):
            proc.kill()
            _, err = proc.communicate(timeout=10)
            pytest.fail(f"relay helper did not start: {first!r}\n{err.decode('utf-8', 'replace')}")
        yield int(first.split()[1]), proc
    finally:
        if proc.poll() is None:
            proc.stdin.close()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        proc.stdout.close()
        proc.stderr.close()


def test_round_trip_against_a_real_relay(relay):
    port, proc = relay
    conn = remote_client.connect("127.0.0.1", port, timeout=10.0)
    try:
        assert conn.remote == ("127.0.0.1", port)
        conn.send({"type": "hello", "client": "pytest"})
        assert conn.recv(timeout=10) == (
            "message", {"type": "echo", "line": '{"type":"hello","client":"pytest"}'},
        )
        kind, header, payload = conn.recv(timeout=10)
        assert kind == "binary"
        assert header == {"fig_id": "probe", "key": "image", "label": "εxx Å"}
        assert payload == PROBE
        action = {"type": "action", "name": "snap", "note": "εxx Å"}
        conn.send(action)
        kind, msg = conn.recv(timeout=10)
        assert (kind, msg["type"], json.loads(msg["line"])) == ("message", "echo", action)
        conn.send({"type": "bye"})
        assert conn.recv(timeout=10) == ("message", {"type": "echo", "line": '{"type":"bye"}'})
        with pytest.raises(ConnectionError):
            conn.recv(timeout=10)  # the app closed the connection after the echo
    finally:
        conn.close()
    proc.stdin.close()
    assert proc.wait(timeout=10) == 0

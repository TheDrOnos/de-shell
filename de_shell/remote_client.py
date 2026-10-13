"""
remote_client.py — the Python end of a de-shell relay (``de_shell/js/main/relay.ts``).

The relay speaks the backend's own framing to a remote peer: the peer sends
bare JSON lines; the relay sends ``PLOTAPP:<json>\\n`` messages and
``PLOTBIN:<hlen>:<plen>\\n<header json><payload>`` binary frames. This module
is that peer: one blocking socket, no threads, no reconnect, no auth, no
policy. Those belong to the app that uses it.

Standard library only: importable without numpy, anyplotlib, asyncio or
Electron (tests/test_remote_client.py checks it in a clean interpreter).

Errors are the standard library's:

- ``TimeoutError``: ``recv(timeout)`` passed without a complete unit. Bytes
  already received are kept for the next call.
- ``ConnectionError`` (or a subclass): the relay closed or reset the
  connection, or this Connection was closed.
- ``ValueError``: a malformed ``PLOTBIN`` prefix or header, or bad JSON after
  ``PLOTAPP:``. The unit is consumed first, so the next ``recv`` continues
  with what follows. The offending text or bytes are on ``.line``.
"""
from __future__ import annotations

import json
import re
import selectors
import socket
import time

__all__ = ["Connection", "connect"]

_PLOTAPP = "PLOTAPP:"
_PLOTBIN = b"PLOTBIN:"
_PREFIX = re.compile(rb"PLOTBIN:(\d{1,15}):(\d{1,15})")  # bounded: int() refuses > 4300 digits
_RECV_BYTES = 1 << 20


def _malformed(what: str, line: str | bytes) -> ValueError:
    """A ValueError naming the unit, with the offending text or bytes on ``.line``."""
    err = ValueError(f"malformed {what}: {line[:200]!r}")
    err.line = line
    return err


class _Decoder:
    """Bytes in, protocol units out.

    Mirrors ``stdoutDemux.ts``: the unit trace does not depend on how the bytes
    are chunked, and a frame waits for all ``hlen + plen`` bytes. One
    difference: a malformed unit raises ``ValueError`` (after it is consumed,
    so the next ``pop`` continues) instead of being dropped.
    """

    def __init__(self) -> None:
        self._buf = bytearray()
        self._scan = 0  # self._buf[:self._scan] holds no b"\n": never rescan it

    @property
    def buffered(self) -> int:
        """Bytes received and not yet part of a returned unit."""
        return len(self._buf)

    def feed(self, data: bytes) -> None:
        self._buf += data

    def pop(self) -> tuple | None:
        """The next complete unit, or None until more bytes arrive.

        ``("message", dict)`` for a PLOTAPP line, ``("binary", header, payload)``
        for a PLOTBIN frame, ``("stream", str)`` for any other non-blank line
        (without its line ending). Blank lines are skipped.
        """
        buf = self._buf
        while buf:
            nl = buf.find(b"\n", self._scan)
            if nl < 0:
                self._scan = len(buf)
                return None
            # A buffer that starts with the 8-byte marker has no newline before
            # byte 8, so a newline found earlier always ends a text line.
            if buf.startswith(_PLOTBIN):
                prefix = bytes(buf[:nl])
                match = _PREFIX.fullmatch(prefix)
                if match is None:
                    self._consume(nl + 1)
                    raise _malformed("PLOTBIN prefix", prefix)
                hlen, plen = int(match.group(1)), int(match.group(2))
                end = nl + 1 + hlen + plen
                if len(buf) < end:
                    return None
                raw_header = bytes(buf[nl + 1:nl + 1 + hlen])
                with memoryview(buf) as mv:  # one copy; released before the resize below
                    payload = bytes(mv[nl + 1 + hlen:end])
                self._consume(end)
                try:
                    header = json.loads(raw_header.decode("utf-8"))
                except ValueError:  # UnicodeDecodeError and JSONDecodeError alike
                    raise _malformed("PLOTBIN header", raw_header) from None
                if not isinstance(header, dict):
                    raise _malformed("PLOTBIN header", raw_header)
                return ("binary", header, payload)
            line = bytes(buf[:nl]).decode("utf-8", errors="replace")
            self._consume(nl + 1)
            if line.endswith("\r"):
                line = line[:-1]
            if line.startswith(_PLOTAPP):
                try:
                    msg = json.loads(line[len(_PLOTAPP):])
                except ValueError:
                    raise _malformed("PLOTAPP message", line) from None
                if not isinstance(msg, dict):
                    raise _malformed("PLOTAPP message", line)
                return ("message", msg)
            if line.strip():
                return ("stream", line)
        return None

    def _consume(self, n: int) -> None:
        del self._buf[:n]
        self._scan = 0


class Connection:
    """One connection to a relay. Make it with :func:`connect`.

    ``recv`` may run on one thread while ``send`` runs on another: ``recv``
    waits on a selector with its own timeout and never changes the socket's
    timeout, which stays the one ``connect`` set and bounds a ``send``. Two
    concurrent ``recv`` calls, or two concurrent ``send`` calls, are not
    supported. Call ``close`` once the reading thread has stopped.
    """

    def __init__(self, sock: socket.socket, timeout: float) -> None:
        self._sock = sock
        self._sock.settimeout(timeout)
        self._selector = selectors.DefaultSelector()
        self._selector.register(sock, selectors.EVENT_READ)
        self._decoder = _Decoder()
        self._closed = False
        host, port = sock.getpeername()[:2]
        self.remote: tuple[str, int] = (host, port)

    def send(self, obj: dict) -> None:
        """One bare JSON line, sent whole. A non-finite number raises ValueError, sending nothing."""
        if self._closed:
            raise ConnectionError("connection is closed")
        line = json.dumps(obj, allow_nan=False, separators=(",", ":")) + "\n"
        self._sock.sendall(line.encode("utf-8"))

    def recv(self, timeout: float | None = None) -> tuple:
        """The next unit: ``("message", dict)``, ``("binary", header, payload)``
        or ``("stream", str)``. ``timeout=None`` waits indefinitely."""
        if self._closed:
            raise ConnectionError("connection is closed")
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            unit = self._decoder.pop()
            if unit is not None:
                return unit
            if deadline is None:
                ready = self._selector.select(None)
            else:
                ready = self._selector.select(max(0.0, deadline - time.monotonic()))
            if not ready:
                raise TimeoutError(
                    f"no complete unit within {timeout} s "
                    f"({self._decoder.buffered} bytes of one buffered)")
            chunk = self._sock.recv(_RECV_BYTES)
            if not chunk:
                if self._decoder.buffered:
                    raise ConnectionError(
                        f"the relay closed the connection inside an incomplete unit "
                        f"({self._decoder.buffered} bytes dropped)")
                raise ConnectionError("the relay closed the connection")
            self._decoder.feed(chunk)

    def close(self) -> None:
        """Idempotent. Later ``send``/``recv`` raise ConnectionError."""
        if self._closed:
            return
        self._closed = True
        self._selector.close()
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # already reset or never fully connected
        self._sock.close()


def connect(host: str, port: int, timeout: float = 10.0) -> Connection:
    """Connect to a relay. ``timeout`` bounds the connect and every ``send``."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        return Connection(sock, timeout)
    except BaseException:
        sock.close()
        raise

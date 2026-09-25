"""
remote_client.py — the Python end of a de-shell relay (``de_shell/js/main/relay.ts``).

The relay speaks the backend's own framing to a remote peer: the peer sends
bare JSON lines; the relay sends ``PLOTAPP:<json>\\n`` messages and
``PLOTBIN:<hlen>:<plen>\\n<header json><payload>`` binary frames. This module
decodes that stream.

Standard library only: importable without numpy, anyplotlib, asyncio or
Electron (tests/test_remote_client.py checks it in a clean interpreter).
"""
from __future__ import annotations

import json
import re

_PLOTAPP = "PLOTAPP:"
_PLOTBIN = b"PLOTBIN:"
_PREFIX = re.compile(rb"PLOTBIN:(\d+):(\d+)")


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
                payload = bytes(buf[nl + 1 + hlen:end])
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

/**
 * framing.ts — encoders for the backend wire format; the inverse of
 * stdoutDemux.ts.
 *
 *   PLOTAPP:<json>\n                                  a message
 *   PLOTBIN:<hlen>:<plen>\n<header json><payload>     a binary frame
 *
 * The layout ipc.emit and anyplotlib's _binary_frame.encode_frame write on the
 * Python side. hlen and plen are byte counts. The JSON text is JSON.stringify's
 * own (compact, raw UTF-8); every decoder of the format accepts it. Imports
 * nothing.
 */

/** JSON.stringify replacer: a non-finite number is not JSON, so refuse it rather than emit null or NaN. */
function refuseNonFinite(key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`cannot frame the non-finite number ${value}${key ? ` at key "${key}"` : ''}`)
  }
  return value
}

/** `PLOTAPP:<json>\n`. JSON escapes every newline inside a string, so the message is one line. */
export function encodeMessage(obj: Record<string, unknown>): Buffer {
  return Buffer.from(`PLOTAPP:${JSON.stringify(obj, refuseNonFinite)}\n`, 'utf8')
}

/**
 * The prefix line and the header bytes of a PLOTBIN frame. The payload is the
 * caller's Buffer, written as its own chunk after these two, never copied.
 */
export function encodeBinary(header: Record<string, unknown>, payload: Buffer): [Buffer, Buffer] {
  const head = Buffer.from(JSON.stringify(header, refuseNonFinite), 'utf8')
  return [Buffer.from(`PLOTBIN:${head.length}:${payload.length}\n`, 'ascii'), head]
}

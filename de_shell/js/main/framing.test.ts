/**
 * framing.test.ts — the encoders against the existing demuxer: whatever
 * framing.ts writes, stdoutDemux.ts must read back unchanged, whole or split
 * one byte at a time.
 *
 * Run: `node --test de_shell/js/main/framing.test.ts`, or via `npm run test:unit`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeBinary, encodeMessage } from './framing.ts'
import { createStdoutDemux } from './stdoutDemux.ts'

type Event =
  | { kind: 'message'; msg: Record<string, unknown> }
  | { kind: 'stream'; text: string }
  | { kind: 'binary'; header: Record<string, unknown>; payload: string }

/** Feed `stream` to a fresh demuxer in `step`-byte slices; return the event trace. */
function decode(stream: Buffer, step = stream.length || 1): Event[] {
  const events: Event[] = []
  const demux = createStdoutDemux({
    onMessage: (msg) => events.push({ kind: 'message', msg }),
    onStream: (text) => events.push({ kind: 'stream', text }),
    onBinary: (header, payload) =>
      events.push({ kind: 'binary', header, payload: payload.toString('hex') }),
  })
  for (let pos = 0; pos < stream.length; pos += step) {
    demux.push(stream.subarray(pos, pos + step))
  }
  return events
}

/** A whole binary frame as it goes on the wire: prefix, header, then the caller's payload. */
function frame(header: Record<string, unknown>, payload: Buffer): Buffer {
  return Buffer.concat([...encodeBinary(header, payload), payload])
}

function patternPayload(n: number): Buffer {
  const p = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) p[i] = i & 0xff // includes 0x0a bytes
  return p
}

test('a message is one PLOTAPP line and decodes to the same object', () => {
  const msg = { type: 'state_update', key: 'clim', value: [0, 255], nested: { ok: true, none: null } }
  const bytes = encodeMessage(msg)
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'PLOTAPP:')
  assert.equal(bytes.indexOf(0x0a), bytes.length - 1, 'exactly one newline, at the end')
  assert.deepEqual(decode(bytes), [{ kind: 'message', msg }])
})

test('a newline inside a string stays escaped, so the message is still one line', () => {
  const msg = { type: 'status', text: 'line one\nline two\r\n' }
  const bytes = encodeMessage(msg)
  assert.equal(bytes.indexOf(0x0a), bytes.length - 1)
  assert.deepEqual(decode(bytes), [{ kind: 'message', msg }])
})

test('a frame with an empty payload decodes with an empty payload', () => {
  assert.deepEqual(decode(frame({ fig_id: 'f3', key: 'spec' }, Buffer.alloc(0))), [
    { kind: 'binary', header: { fig_id: 'f3', key: 'spec' }, payload: '' },
  ])
})

test('a payload holding newlines and PLOTBIN:/PLOTAPP: lookalikes decodes whole, at any chunking', () => {
  const nasty = Buffer.concat([
    Buffer.from('\nPLOTBIN:9:9\nPLOTAPP:{}\n', 'ascii'),
    patternPayload(3000),
  ])
  const stream = Buffer.concat([
    frame({ fig_id: 'f1', key: 'image' }, nasty),
    encodeMessage({ type: 'done' }),
  ])
  const expected: Event[] = [
    { kind: 'binary', header: { fig_id: 'f1', key: 'image' }, payload: nasty.toString('hex') },
    { kind: 'message', msg: { type: 'done' } },
  ]
  for (const step of [stream.length, 65536, 7, 1]) {
    assert.deepEqual(decode(stream, step), expected, `diverged at ${step}-byte chunks`)
  }
})

test('a non-ASCII header: hlen counts UTF-8 bytes, not characters', () => {
  const header = { fig_id: 'f', key: 'k', label: 'εxx Å' }
  const [prefix, head] = encodeBinary(header, Buffer.from([1, 2, 3]))
  const json = JSON.stringify(header)
  assert.notEqual(Buffer.byteLength(json, 'utf8'), json.length, 'the fixture must be multi-byte')
  assert.equal(prefix.toString('ascii'), `PLOTBIN:${Buffer.byteLength(json, 'utf8')}:3\n`)
  assert.equal(head.toString('utf8'), json)
  assert.deepEqual(decode(frame(header, Buffer.from([1, 2, 3])), 1), [
    { kind: 'binary', header, payload: '010203' },
  ])
})

test('encodeBinary returns the prefix and header only; the payload is never copied', () => {
  const payload = patternPayload(64)
  const parts = encodeBinary({ fig_id: 'f', key: 'k' }, payload)
  assert.equal(parts.length, 2)
  assert.ok(!parts.includes(payload))
  assert.match(parts[0].toString('ascii'), /^PLOTBIN:\d+:64\n$/)
})

test('the layout is the documented wire format, byte for byte', () => {
  // PLOTBIN:<hlen>:<plen>\n<header json><payload>, as anyplotlib's
  // _binary_frame.encode_frame writes it and stdoutDemux.ts parses it.
  const header = { fig_id: 'f', key: 'k', dims: [2, 2] }
  const payload = Buffer.from([0, 10, 255, 10])
  const json = JSON.stringify(header)
  assert.deepEqual(frame(header, payload), Buffer.concat([
    Buffer.from(`PLOTBIN:${Buffer.byteLength(json)}:4\n${json}`, 'utf8'),
    payload,
  ]))
  assert.deepEqual(encodeMessage({ type: 'done' }), Buffer.from('PLOTAPP:{"type":"done"}\n', 'utf8'))
})

test('a non-finite number is refused rather than framed', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => encodeMessage({ type: 'fit', value: bad }), RangeError)
    assert.throws(
      () => encodeBinary({ fig_id: 'f', key: 'k', clim: [0, bad] }, Buffer.alloc(0)),
      RangeError,
    )
  }
  assert.throws(() => encodeMessage({ a: { b: [1, NaN] } }), /non-finite/)
})

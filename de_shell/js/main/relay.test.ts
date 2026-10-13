/**
 * relay.test.ts — node:test suite for relay.ts on real loopback sockets
 * (127.0.0.1, port 0), no Electron. The relay's timers run on an injected fake
 * clock, so no test waits for a real timeout.
 *
 * Run: `node --test de_shell/js/main/relay.test.ts`, or via `npm run test:unit`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as net from 'node:net'
import { CLOSE_GRACE_MS, createRelay } from './relay.ts'
import { createStdoutDemux } from './stdoutDemux.ts'
import type { Relay, RelayCloseReason, RelayConnection, RelayOptions } from './relay.ts'

type Ev =
  | { kind: 'connection'; conn: number }
  | { kind: 'line'; conn: number; line: string }
  | { kind: 'close'; conn: number; reason: RelayCloseReason; err?: Error }

interface Hooks {
  onConnection?: (c: RelayConnection) => void
  onLine?: (c: RelayConnection, line: string) => void
}

interface Harness {
  relay: Relay
  events: Ev[]
  conns: RelayConnection[]
}

/** A relay on 127.0.0.1:0 that records every callback; `hooks` run after the record. */
async function startRelay(extra: Partial<RelayOptions> = {}, hooks: Hooks = {}): Promise<Harness> {
  const events: Ev[] = []
  const conns: RelayConnection[] = []
  const relay = await createRelay({
    host: '127.0.0.1',
    port: 0,
    onConnection: (c) => {
      conns.push(c)
      events.push({ kind: 'connection', conn: conns.indexOf(c) })
      hooks.onConnection?.(c)
    },
    onLine: (c, line) => {
      events.push({ kind: 'line', conn: conns.indexOf(c), line })
      hooks.onLine?.(c, line)
    },
    onClose: (c, reason, err) => {
      events.push({ kind: 'close', conn: conns.indexOf(c), reason, err })
    },
    ...extra,
  })
  return { relay, events, conns }
}

function linesOf(events: Ev[], conn = 0): string[] {
  return events.flatMap((e) => (e.kind === 'line' && e.conn === conn ? [e.line] : []))
}

function reasonsOf(events: Ev[], conn = 0): RelayCloseReason[] {
  return events.flatMap((e) => (e.kind === 'close' && e.conn === conn ? [e.reason] : []))
}

function closeOf(events: Ev[], conn = 0): Extract<Ev, { kind: 'close' }> | undefined {
  return events.find(
    (e): e is Extract<Ev, { kind: 'close' }> => e.kind === 'close' && e.conn === conn,
  )
}

function connectClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.on('error', () => { /* resets on relay-initiated closes are expected */ })
    s.once('error', reject)
    s.once('connect', () => resolve(s))
  })
}

function socketClosed(s: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (s.closed) resolve()
    else s.once('close', () => resolve())
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

interface Spied {
  socket: net.Socket
  log: string[]
}

/**
 * A createServer factory that records the server it made and every socket it
 * accepted, with a log of the calls the relay makes on each socket
 * ('setKeepAlive:true,15000', 'setNoDelay:true', 'cork', 'write:<bytes>', …).
 */
function spyServer() {
  const servers: net.Server[] = []
  const accepted: Spied[] = []
  const createServer = ((listener?: (s: net.Socket) => void): net.Server => {
    const server = net.createServer(listener)
    servers.push(server)
    // Prepended so it runs before the relay's own connection listener.
    server.prependListener('connection', (socket: net.Socket) => {
      const log: string[] = []
      const target = socket as unknown as Record<string, (...a: unknown[]) => unknown>
      for (const name of ['setKeepAlive', 'setNoDelay', 'cork', 'uncork', 'write', 'end', 'destroy']) {
        const orig = target[name].bind(socket)
        target[name] = (...a: unknown[]) => {
          if (name === 'write') log.push(`write:${(a[0] as Buffer).length}`)
          else log.push(a.length ? `${name}:${a.map(String).join(',')}` : name)
          return orig(...a)
        }
      }
      accepted.push({ socket, log })
    })
    return server
  })
  return { createServer, servers, accepted }
}

test('reports the bound address and the ephemeral port', async () => {
  const h = await startRelay()
  try {
    assert.equal(h.relay.address, '127.0.0.1')
    assert.ok(h.relay.port > 0 && h.relay.port < 65536, `port ${h.relay.port}`)
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('a bind to an address this machine lacks rejects with the OS error and leaves nothing listening', async () => {
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): assigned to no interface anywhere.
  const spy = spyServer()
  await assert.rejects(
    createRelay({
      host: '192.0.2.1',
      port: 0,
      onConnection: () => {},
      onLine: () => {},
      onClose: () => {},
      createServer: spy.createServer,
    }),
    (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'EADDRNOTAVAIL')
      return true
    },
  )
  assert.equal(spy.servers.length, 1, 'the injected factory made the server')
  assert.equal(spy.servers[0].listening, false)
})

test('an empty host rejects with a TypeError before any server is made', async () => {
  const spy = spyServer()
  await assert.rejects(
    createRelay({
      host: '',
      port: 0,
      onConnection: () => {},
      onLine: () => {},
      onClose: () => {},
      createServer: spy.createServer,
    }),
    (err: unknown) => {
      assert.ok(err instanceof TypeError, String(err))
      assert.match(err.message, /host is required/)
      return true
    },
  )
  assert.equal(spy.servers.length, 0, 'no server was made')
})

test('a port already in use rejects with EADDRINUSE', async () => {
  const first = await startRelay()
  try {
    await assert.rejects(
      createRelay({
        host: '127.0.0.1',
        port: first.relay.port,
        onConnection: () => {},
        onLine: () => {},
        onClose: () => {},
      }),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, 'EADDRINUSE')
        return true
      },
    )
  } finally {
    await first.relay.close()
  }
})

test('the injected createServer makes the listening server', async () => {
  const spy = spyServer()
  const h = await startRelay({ createServer: spy.createServer })
  try {
    assert.equal(spy.servers.length, 1)
    assert.equal(spy.servers[0].listening, true)
    assert.equal((spy.servers[0].address() as net.AddressInfo).port, h.relay.port)
    const c = await connectClient(h.relay.port)
    await waitFor(() => spy.accepted.length === 1 && h.conns.length === 1, 'the connection')
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('every client gets onConnection with its remote address; the relay imposes no count', async () => {
  const h = await startRelay()
  const clients: net.Socket[] = []
  try {
    for (let i = 0; i < 3; i++) clients.push(await connectClient(h.relay.port))
    await waitFor(() => h.conns.length === 3, 'three connections')
    for (const c of h.conns) assert.equal(c.remoteAddress, '127.0.0.1')
    assert.deepEqual(
      new Set(h.conns.map((c) => c.remotePort)),
      new Set(clients.map((c) => c.localPort)),
    )
    assert.deepEqual(reasonsOf(h.events, 0), [])
  } finally {
    for (const c of clients) c.destroy()
    await h.relay.close()
  }
})

test('lines arrive whole across chunk splits, the first line included', async () => {
  const h = await startRelay()
  try {
    const c = await connectClient(h.relay.port)
    c.setNoDelay(true)
    await waitFor(() => h.conns.length === 1, 'the connection')
    // One byte per write, so the multi-byte ε is split too.
    const bytes = Buffer.from('{"type":"hello","who":"εxx"}\n{"type":"action","name":"snap"}\n', 'utf8')
    for (let i = 0; i < bytes.length; i++) {
      c.write(bytes.subarray(i, i + 1))
      await sleep(1)
    }
    await waitFor(() => linesOf(h.events).length === 2, 'two lines')
    assert.deepEqual(linesOf(h.events), [
      '{"type":"hello","who":"εxx"}',
      '{"type":"action","name":"snap"}',
    ])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('\\r\\n is accepted and blank or whitespace-only lines are skipped', async () => {
  const h = await startRelay()
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.write('a\r\n\r\n   \n\nb\n')
    await waitFor(() => linesOf(h.events).length === 2, 'two lines')
    await sleep(20)
    assert.deepEqual(linesOf(h.events), ['a', 'b'])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('bytes that are not UTF-8 arrive as U+FFFD and the connection stays open', async () => {
  const h = await startRelay()
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.write(Buffer.from([0x66, 0xff, 0xfe, 0x0a]))
    c.write('next\n')
    await waitFor(() => linesOf(h.events).length === 2, 'two lines')
    assert.deepEqual(linesOf(h.events), ['f\uFFFD\uFFFD', 'next'])
    assert.deepEqual(reasonsOf(h.events), [])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('two clients are both delivered, each on its own connection', async () => {
  const h = await startRelay()
  try {
    const a = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'first')
    const b = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 2, 'second')
    a.write('from a\n')
    b.write('from b\n')
    await waitFor(
      () => linesOf(h.events, 0).length === 1 && linesOf(h.events, 1).length === 1,
      'both lines',
    )
    assert.deepEqual(linesOf(h.events, 0), ['from a'])
    assert.deepEqual(linesOf(h.events, 1), ['from b'])
    a.destroy()
    b.destroy()
  } finally {
    await h.relay.close()
  }
})

test('a peer that half-closes: complete lines first, the unterminated tail dropped, then peer once', async () => {
  const h = await startRelay()
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.end('one\ntwo\npartial')
    await waitFor(() => reasonsOf(h.events).length > 0, 'onClose')
    await sleep(50)
    assert.deepEqual(linesOf(h.events), ['one', 'two'])
    assert.deepEqual(reasonsOf(h.events), ['peer'])
    assert.equal(h.events.at(-1)?.kind, 'close', 'onClose comes after every line')
    await socketClosed(c)
  } finally {
    await h.relay.close()
  }
})

test('a socket error closes that connection as error with the error attached', async () => {
  const spy = spyServer()
  const h = await startRelay({ createServer: spy.createServer })
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1 && spy.accepted.length === 1, 'the connection')
    spy.accepted[0].socket.destroy(new Error('injected'))
    await waitFor(() => reasonsOf(h.events).length > 0, 'onClose')
    await sleep(50)
    assert.deepEqual(reasonsOf(h.events), ['error'])
    assert.equal(closeOf(h.events)?.err?.message, 'injected')
    await socketClosed(c)
  } finally {
    await h.relay.close()
  }
})

test('an onLine that throws closes that connection as error; the relay keeps serving', async () => {
  const boom = new Error('handler bug')
  const h = await startRelay({}, {
    onLine: (_c, line) => {
      if (line === 'bad') throw boom
    },
  })
  try {
    const a = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'first')
    a.write('bad\nnever delivered\n')
    await waitFor(() => reasonsOf(h.events, 0).length === 1, 'onClose')
    assert.deepEqual(reasonsOf(h.events, 0), ['error'])
    assert.equal(closeOf(h.events, 0)?.err, boom)
    assert.deepEqual(linesOf(h.events, 0), ['bad'])
    const b = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 2, 'second')
    b.write('fine\n')
    await waitFor(() => linesOf(h.events, 1).length === 1, 'the second client line')
    b.destroy()
  } finally {
    await h.relay.close()
  }
})

test('an onConnection that throws closes that connection as error', async () => {
  const h = await startRelay({}, {
    onConnection: () => {
      throw new Error('refused in handler')
    },
  })
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => reasonsOf(h.events).length === 1, 'onClose')
    assert.deepEqual(reasonsOf(h.events), ['error'])
    assert.equal(closeOf(h.events)?.err?.message, 'refused in handler')
    await socketClosed(c)
  } finally {
    await h.relay.close()
  }
})

test('close() ends every connection as app, stops the server, and resolves', async () => {
  const spy = spyServer()
  const h = await startRelay({ createServer: spy.createServer })
  const a = await connectClient(h.relay.port)
  const b = await connectClient(h.relay.port)
  await waitFor(() => h.conns.length === 2, 'two connections')
  await h.relay.close()
  assert.deepEqual(reasonsOf(h.events, 0), ['app'])
  assert.deepEqual(reasonsOf(h.events, 1), ['app'])
  assert.equal(spy.servers[0].listening, false)
  await Promise.all([socketClosed(a), socketClosed(b)])
})

test('close() with no connections resolves, and calling it again resolves too', async () => {
  const spy = spyServer()
  const { relay } = await startRelay({ createServer: spy.createServer })
  await Promise.all([relay.close(), relay.close()])
  await relay.close()
  assert.equal(spy.servers[0].listening, false)
})

/** A manual clock for the relay's timers: nothing fires until advance(). */
function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number)
    },
    advance(ms: number): void {
      now += ms
      const due = [...timers].filter(([, t]) => t.at <= now).sort((x, y) => x[1].at - y[1].at)
      for (const [id, t] of due) {
        if (timers.delete(id)) t.fn()
      }
    },
    get pending(): number {
      return timers.size
    },
  }
}

function clocked(clock: ReturnType<typeof fakeClock>, extra: Partial<RelayOptions> = {}): Partial<RelayOptions> {
  return { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ...extra }
}

const admitOnHello: Hooks = {
  onLine: (c, line) => {
    if (line === 'hello') c.admit()
  },
}

test('a silent client is closed as hello-timeout when the injected clock reaches helloTimeoutMs', async () => {
  const clock = fakeClock()
  const h = await startRelay(clocked(clock, { helloTimeoutMs: 10_000 }))
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    clock.advance(9_999)
    assert.deepEqual(reasonsOf(h.events), [])
    clock.advance(1)
    assert.deepEqual(reasonsOf(h.events), ['hello-timeout'])
    await socketClosed(c)
  } finally {
    await h.relay.close()
  }
})

test('the hello timer runs from accept to admit(): a line the app does not admit does not stop it', async () => {
  const clock = fakeClock()
  const h = await startRelay(clocked(clock, { helloTimeoutMs: 10_000 }))
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.write('hello\n')
    await waitFor(() => linesOf(h.events).length === 1, 'hello')
    clock.advance(10_000)
    assert.deepEqual(reasonsOf(h.events), ['hello-timeout'])
    await socketClosed(c)
  } finally {
    await h.relay.close()
  }
})

test('admit() stops the hello timer', async () => {
  const clock = fakeClock()
  const h = await startRelay(clocked(clock), admitOnHello)
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.write('hello\n')
    await waitFor(() => linesOf(h.events).length === 1, 'hello')
    assert.equal(clock.pending, 0, 'admit() cancelled the timer')
    clock.advance(1_000_000)
    c.write('still here\n')
    await waitFor(() => linesOf(h.events).length === 2, 'the second line')
    assert.deepEqual(reasonsOf(h.events), [])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('a pre-admit line over the cap closes as line-too-long; the same line after admit() passes', async () => {
  const clock = fakeClock()
  const long = 'x'.repeat(17)
  const h = await startRelay(clocked(clock, { preAdmitLineBytes: 16 }), admitOnHello)
  try {
    const a = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'first')
    a.write(`${long}\n`)
    await waitFor(() => reasonsOf(h.events, 0).length === 1, 'first onClose')
    assert.deepEqual(reasonsOf(h.events, 0), ['line-too-long'])
    assert.deepEqual(linesOf(h.events, 0), [])
    const b = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 2, 'second')
    // One write: admit() inside onLine('hello') lifts the cap for the rest of the same chunk.
    b.write(`hello\n${long}\n`)
    await waitFor(() => linesOf(h.events, 1).length === 2, 'both lines')
    assert.deepEqual(linesOf(h.events, 1), ['hello', long])
    assert.deepEqual(reasonsOf(h.events, 1), [])
    b.destroy()
  } finally {
    await h.relay.close()
  }
})

test('a line of exactly the cap passes; a pre-admit partial line past it closes as line-too-long', async () => {
  const clock = fakeClock()
  const h = await startRelay(clocked(clock, { preAdmitLineBytes: 16 }))
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.write(`${'y'.repeat(16)}\n`)
    await waitFor(() => linesOf(h.events).length === 1, 'the 16-byte line')
    c.write('z'.repeat(10))
    await sleep(50)
    assert.deepEqual(reasonsOf(h.events), [], 'ten bytes are under the cap')
    c.write('z'.repeat(7))   // no newline ever: the partial line alone crosses the cap
    await waitFor(() => reasonsOf(h.events).length === 1, 'onClose')
    assert.deepEqual(reasonsOf(h.events), ['line-too-long'])
    assert.deepEqual(linesOf(h.events), ['y'.repeat(16)])
    await socketClosed(c)
  } finally {
    await h.relay.close()
  }
})

test('after admit() the cap is lineBytes', async () => {
  const clock = fakeClock()
  const h = await startRelay(clocked(clock, { preAdmitLineBytes: 16, lineBytes: 32 }), admitOnHello)
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    c.write(`hello\n${'y'.repeat(32)}\n${'y'.repeat(33)}\n`)
    await waitFor(() => reasonsOf(h.events).length === 1, 'onClose')
    assert.deepEqual(linesOf(h.events), ['hello', 'y'.repeat(32)])
    assert.deepEqual(reasonsOf(h.events), ['line-too-long'])
  } finally {
    await h.relay.close()
  }
})

test('a connection that closes cancels its hello timer', async () => {
  const clock = fakeClock()
  const h = await startRelay(clocked(clock))
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1, 'the connection')
    assert.equal(clock.pending, 1)
    c.end()
    await waitFor(() => reasonsOf(h.events).length === 1, 'onClose')
    assert.equal(clock.pending, 0)
    clock.advance(1_000_000)
    assert.deepEqual(reasonsOf(h.events), ['peer'])
  } finally {
    await h.relay.close()
  }
})

type Unit =
  | { kind: 'message'; msg: Record<string, unknown> }
  | { kind: 'binary'; header: Record<string, unknown>; payload: Buffer }
  | { kind: 'stream'; text: string }

/** Decode everything the relay sends to `c` with the backend's own demuxer. */
function collect(c: net.Socket): Unit[] {
  const units: Unit[] = []
  const demux = createStdoutDemux({
    onMessage: (msg) => units.push({ kind: 'message', msg }),
    onStream: (text) => units.push({ kind: 'stream', text }),
    onBinary: (header, payload) => units.push({ kind: 'binary', header, payload }),
  })
  c.on('data', (chunk: Buffer) => demux.push(chunk))
  return units
}

/** Write 1 MiB frames until the socket queues bytes it cannot hand to the kernel (the peer is not reading). */
function fillUntilQueued(conn: RelayConnection): void {
  const block = Buffer.alloc(1 << 20)
  for (let i = 0; i < 256 && conn.writableLength === 0; i++) {
    conn.writeBinary({ fig_id: 'fill', key: 'k', i }, block)
  }
  assert.ok(conn.writableLength > 0, 'the socket never queued; is the peer reading?')
}

test('writeMessage and writeBinary arrive in order and decode with the demuxer', async () => {
  const nasty = Buffer.concat([Buffer.from('\nPLOTBIN:9:9\nPLOTAPP:{}\n', 'ascii'), Buffer.alloc(4096, 7)])
  const h = await startRelay({}, {
    onConnection: (conn) => {
      conn.writeMessage({ type: 'welcome', v: 1 })
      conn.writeBinary({ fig_id: 'f1', key: 'image', label: 'εxx' }, nasty)
      conn.writeMessage({ type: 'done' })
    },
  })
  try {
    const c = await connectClient(h.relay.port)
    const units = collect(c)
    await waitFor(() => units.length === 3, 'three units')
    assert.deepEqual(units, [
      { kind: 'message', msg: { type: 'welcome', v: 1 } },
      { kind: 'binary', header: { fig_id: 'f1', key: 'image', label: 'εxx' }, payload: nasty },
      { kind: 'message', msg: { type: 'done' } },
    ])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('writeBinary corks the socket around its three writes', async () => {
  const spy = spyServer()
  const h = await startRelay({ createServer: spy.createServer })
  try {
    const c = await connectClient(h.relay.port)
    await waitFor(() => h.conns.length === 1 && spy.accepted.length === 1, 'the connection')
    const log = spy.accepted[0].log
    const from = log.length
    const header = { fig_id: 'f', key: 'k' }
    h.conns[0].writeBinary(header, Buffer.alloc(1000, 1))
    const hlen = Buffer.byteLength(JSON.stringify(header))
    assert.deepEqual(log.slice(from), [
      'cork',
      `write:${`PLOTBIN:${hlen}:1000\n`.length}`,
      `write:${hlen}`,
      'write:1000',
      'uncork',
    ])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('writeMessage refuses a non-finite number and writes nothing; the connection stays usable', async () => {
  const h = await startRelay()
  try {
    const c = await connectClient(h.relay.port)
    const units = collect(c)
    await waitFor(() => h.conns.length === 1, 'the connection')
    const conn = h.conns[0]
    assert.throws(() => conn.writeMessage({ type: 'fit', value: NaN }), RangeError)
    assert.throws(
      () => conn.writeBinary({ fig_id: 'f', key: 'k', clim: [0, Infinity] }, Buffer.alloc(8)),
      RangeError,
    )
    conn.writeMessage({ type: 'after' })
    await waitFor(() => units.length === 1, 'one unit')
    await sleep(20)
    assert.deepEqual(units, [{ kind: 'message', msg: { type: 'after' } }])
    assert.deepEqual(reasonsOf(h.events), [])
    c.destroy()
  } finally {
    await h.relay.close()
  }
})

test('everything written before close() arrives before EOF, the refusal last; onClose reports app once', async () => {
  // 8 MiB ahead of the refusal, so bytes are still queued in the relay when
  // close() runs: a close that destroyed the socket would lose them (a lone
  // small write reaches the kernel at once and would not tell the two apart).
  const block = Buffer.alloc(1 << 20, 3)
  let queuedAtClose = -1
  const h = await startRelay({}, {
    onLine: (conn, line) => {
      if (line === 'hello') {
        for (let i = 0; i < 8; i++) conn.writeBinary({ fig_id: 'f', key: 'k', i }, block)
        conn.writeMessage({ type: 'refused', reason: 'not paired' })
        queuedAtClose = conn.writableLength
        conn.close()
      }
    },
  })
  try {
    const c = await connectClient(h.relay.port)
    const units = collect(c)
    c.write('hello\n')
    await socketClosed(c)
    assert.ok(queuedAtClose > 0, 'bytes were still queued in the relay when close() was called')
    assert.equal(units.length, 9)
    assert.deepEqual(
      units.slice(0, 8).map((u) => (u.kind === 'binary' ? [u.header.i, u.payload.length] : null)),
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, 1 << 20]),
    )
    assert.deepEqual(units[8], { kind: 'message', msg: { type: 'refused', reason: 'not paired' } })
    await sleep(50)
    assert.deepEqual(reasonsOf(h.events), ['app'])
  } finally {
    await h.relay.close()
  }
})

test('close() to a client that never reads destroys the socket after CLOSE_GRACE_MS', async () => {
  const clock = fakeClock()
  const spy = spyServer()
  const h = await startRelay(clocked(clock, { createServer: spy.createServer }))
  const c = await connectClient(h.relay.port)
  c.pause()
  try {
    await waitFor(() => h.conns.length === 1 && spy.accepted.length === 1, 'the connection')
    const conn = h.conns[0]
    conn.admit()
    fillUntilQueued(conn)
    conn.close()
    assert.deepEqual(reasonsOf(h.events), ['app'])
    const socket = spy.accepted[0].socket
    clock.advance(CLOSE_GRACE_MS - 1)
    assert.equal(socket.destroyed, false, 'still flushing inside the grace period')
    clock.advance(1)
    assert.equal(socket.destroyed, true)
    assert.deepEqual(reasonsOf(h.events), ['app'], 'onClose fired once')
  } finally {
    await h.relay.close()
    c.destroy()
  }
})

test('writes after close() are dropped without throwing', async () => {
  const h = await startRelay()
  try {
    const c = await connectClient(h.relay.port)
    const units = collect(c)
    await waitFor(() => h.conns.length === 1, 'the connection')
    const conn = h.conns[0]
    conn.close()
    conn.writeMessage({ type: 'late' })
    conn.writeBinary({ fig_id: 'f', key: 'k' }, Buffer.alloc(4))
    conn.close()
    conn.admit()
    await socketClosed(c)
    assert.deepEqual(units, [])
    assert.deepEqual(reasonsOf(h.events), ['app'])
  } finally {
    await h.relay.close()
  }
})

test('writableLength grows when the peer stops reading', async () => {
  const h = await startRelay()
  const c = await connectClient(h.relay.port)
  c.pause()
  try {
    await waitFor(() => h.conns.length === 1, 'the connection')
    assert.equal(h.conns[0].writableLength, 0)
    fillUntilQueued(h.conns[0])
  } finally {
    await h.relay.close()
    c.destroy()
  }
})

test('keepalive and no-delay are set on each accepted socket; keepAliveMs 0 leaves keepalive off', async () => {
  const cases: Array<[number | undefined, string | null]> = [
    [undefined, 'setKeepAlive:true,15000'],
    [2500, 'setKeepAlive:true,2500'],
    [0, null],
  ]
  for (const [keepAliveMs, expected] of cases) {
    const spy = spyServer()
    const extra: Partial<RelayOptions> = { createServer: spy.createServer }
    if (keepAliveMs !== undefined) extra.keepAliveMs = keepAliveMs
    const h = await startRelay(extra)
    try {
      const c = await connectClient(h.relay.port)
      await waitFor(() => spy.accepted.length === 1, 'the connection')
      const log = spy.accepted[0].log
      assert.ok(log.includes('setNoDelay:true'), log.join(' '))
      assert.deepEqual(
        log.filter((l) => l.startsWith('setKeepAlive')),
        expected === null ? [] : [expected],
        `keepAliveMs ${String(keepAliveMs)}`,
      )
      c.destroy()
    } finally {
      await h.relay.close()
    }
  }
})

test('relay.close() while a connection is still flushing its close: both resolve, onClose once each', async () => {
  const clock = fakeClock()
  const spy = spyServer()
  const h = await startRelay(clocked(clock, { createServer: spy.createServer }))
  const a = await connectClient(h.relay.port)
  a.pause()
  await waitFor(() => h.conns.length === 1, 'first')
  const b = await connectClient(h.relay.port)
  await waitFor(() => h.conns.length === 2, 'second')
  h.conns[0].admit()
  fillUntilQueued(h.conns[0])
  h.conns[0].close()                                  // flushing to a peer that will not read
  await Promise.all([h.relay.close(), h.relay.close()])
  assert.deepEqual(reasonsOf(h.events, 0), ['app'])
  assert.deepEqual(reasonsOf(h.events, 1), ['app'])
  assert.equal(spy.accepted[0].socket.destroyed, true)
  assert.equal(spy.servers[0].listening, false)
  await waitFor(() => clock.pending === 0, 'the grace and hello timers cancelled')
  a.destroy()
  b.destroy()
})

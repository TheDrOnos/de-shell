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
import { createRelay } from './relay.ts'
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
  }) as typeof net.createServer
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

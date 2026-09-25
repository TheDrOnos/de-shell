/**
 * relay.ts — a TCP listener that speaks the backend's framing to remote
 * clients: an app's remote-control endpoint, a GUI on another machine.
 *
 * It moves bytes and nothing else. In: '\n'-terminated UTF-8 lines, handed to
 * the app one string at a time. Out: PLOTAPP messages and PLOTBIN frames,
 * built by framing.ts. Who is admitted, what a line means and when a slow
 * client is dropped are the app's decisions. No electron import, so it loads
 * under `node --test` like backendProcess.ts.
 *
 * Until the app calls admit(), a connection is on probation: it is closed as
 * 'hello-timeout' helloTimeoutMs after accept, and as 'line-too-long' once a
 * line (or a partial one) passes preAdmitLineBytes. After admit() the cap is
 * lineBytes and there is no timer.
 *
 * Closing: onClose fires exactly once per connection, when the relay or the
 * app ends it. conn.close() flushes what the app already wrote and then sends
 * FIN, so a refusal written just before it still arrives; a peer that will not
 * read is destroyed after CLOSE_GRACE_MS. Every other close destroys at once.
 *
 * Keepalive: Windows honours the initial delay only; the probe interval is the
 * OS default. The app's own supersede rule is the half-open recovery on every
 * platform.
 */
import * as net from 'node:net'
import { encodeBinary, encodeMessage } from './framing.ts'

export interface RelayConnection {
  readonly remoteAddress: string
  readonly remotePort: number
  /** Bytes queued on the socket and not yet flushed. The relay never buffers on the app's behalf. */
  readonly writableLength: number
  /** Stops the hello timer and lifts the line cap from preAdmitLineBytes to lineBytes. */
  admit(): void
  /** Throws on a non-finite number, having written nothing. Dropped once the connection is closed. */
  writeMessage(obj: Record<string, unknown>): void
  /** Prefix, header and payload go out corked, together. The payload is not copied. Dropped once closed. */
  writeBinary(header: Record<string, unknown>, payload: Buffer): void
  /** Flush what was written, then FIN; onClose(..., 'app') fires now. */
  close(): void
}

export type RelayCloseReason = 'peer' | 'app' | 'hello-timeout' | 'line-too-long' | 'error'

export interface Relay {
  readonly address: string
  readonly port: number
  /** Ends every connection (reason 'app') and the server; resolves once the server has stopped. Safe to call twice. */
  close(): Promise<void>
}

export interface RelayOptions {
  /** Bound exactly: no fallback, no discovery. '0.0.0.0' binds every interface only when the app passes it; an empty host is refused. */
  host: string
  /** 0 = ephemeral; the bound port is reported on the Relay. */
  port: number
  onConnection: (c: RelayConnection) => void
  /** Every non-blank line, '\r\n' accepted, the first (hello) included. The relay never parses it. */
  onLine: (c: RelayConnection, line: string) => void
  /** Exactly once per connection; `err` is set for 'error'. */
  onClose: (c: RelayConnection, reason: RelayCloseReason, err?: Error) => void
  /** Accept to admit(); past it the connection is closed as 'hello-timeout'. Must be > 0 (0 is not "disabled": it fires on the next tick). Default 10 000. */
  helloTimeoutMs?: number
  /** Line cap in bytes (those before the '\n') until admit(). Default 64 KiB. */
  preAdmitLineBytes?: number
  /** Line cap in bytes after admit(). Default 16 MiB. */
  lineBytes?: number
  /** TCP keepalive initial delay on every accepted socket; 0 leaves keepalive off. Default 15 000. */
  keepAliveMs?: number
  /**
   * The TLS hook. Called once, as createServer(connectionListener), so a
   * factory returning tls.createServer(tlsOptions, connectionListener) fits.
   * Default net.createServer.
   */
  createServer?: (listener: (socket: net.Socket) => void) => net.Server
  /** The clock for the relay's timers; tests inject a fake one. Default: the global setTimeout. */
  setTimeout?: (fn: () => void, ms: number) => unknown
  /** Pairs with setTimeout. Default: the global clearTimeout. */
  clearTimeout?: (handle: unknown) => void
}

/** How long conn.close() waits for queued writes to flush before destroying the socket. */
export const CLOSE_GRACE_MS = 5000

const NL = 0x0a

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

export function createRelay(opts: RelayOptions): Promise<Relay> {
  if (!opts.host) return Promise.reject(new TypeError('createRelay: host is required; pass "0.0.0.0" to bind every interface'))
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000
  const preAdmitLineBytes = opts.preAdmitLineBytes ?? 64 * 1024
  const lineBytes = opts.lineBytes ?? 16 * 1024 * 1024
  const keepAliveMs = opts.keepAliveMs ?? 15_000
  const makeServer = opts.createServer ?? net.createServer
  const arm = opts.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const disarm = opts.clearTimeout
    ?? ((handle: unknown): void => clearTimeout(handle as Parameters<typeof clearTimeout>[0]))
  const live = new Set<() => void>()      // destroy-now closers of connections still open to the app
  const sockets = new Set<net.Socket>()   // every accepted socket not yet 'close'd, graceful closes included

  const accept = (socket: net.Socket): void => {
    sockets.add(socket)
    let admitted = false
    let closed = false
    let hello: unknown = null
    let grace: unknown = null
    let pending: Buffer[] = []   // the partial line so far, as received
    let pendingLen = 0

    const cap = (): number => (admitted ? lineBytes : preAdmitLineBytes)
    const stopHello = (): void => {
      if (hello !== null) {
        disarm(hello)
        hello = null
      }
    }

    const conn: RelayConnection = {
      remoteAddress: socket.remoteAddress ?? '',
      remotePort: socket.remotePort ?? 0,
      get writableLength(): number {
        return socket.writableLength
      },
      admit(): void {
        if (closed || admitted) return
        admitted = true
        stopHello()
      },
      writeMessage(obj: Record<string, unknown>): void {
        const bytes = encodeMessage(obj)
        if (closed) return
        socket.write(bytes)
      },
      writeBinary(header: Record<string, unknown>, payload: Buffer): void {
        const [prefix, head] = encodeBinary(header, payload)
        if (closed) return
        socket.cork()
        socket.write(prefix)
        socket.write(head)
        if (payload.length > 0) socket.write(payload)
        socket.uncork()
      },
      close(): void {
        finish('app', undefined, true)
      },
    }

    const finish = (reason: RelayCloseReason, err?: Error, graceful = false): void => {
      if (closed) return
      closed = true
      stopHello()
      live.delete(destroyNow)
      pending = []
      pendingLen = 0
      if (graceful) {
        socket.end()
        grace = arm(() => socket.destroy(), CLOSE_GRACE_MS)
      } else {
        socket.destroy()
      }
      try {
        opts.onClose(conn, reason, err)
      } catch {
        // Nowhere left to report it: the connection is already gone.
      }
    }
    const destroyNow = (): void => finish('app')

    const onData = (chunk: Buffer): void => {
      let start = 0
      while (!closed) {
        const nl = chunk.indexOf(NL, start)
        if (nl < 0) {
          if (start < chunk.length) {
            pending.push(chunk.subarray(start))
            pendingLen += chunk.length - start
          }
          // A client that never sends '\n' is capped here, not buffered without bound.
          if (pendingLen > cap()) finish('line-too-long')
          return
        }
        let bytes = chunk.subarray(start, nl)
        start = nl + 1
        if (pendingLen > 0) {
          pending.push(bytes)
          bytes = Buffer.concat(pending, pendingLen + bytes.length)
          pending = []
          pendingLen = 0
        }
        // Checked per line, so an admit() inside onLine lifts the cap for the rest of this chunk.
        if (bytes.length > cap()) {
          finish('line-too-long')
          return
        }
        let line = bytes.toString('utf8')
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.trim() === '') continue
        try {
          opts.onLine(conn, line)
        } catch (e) {
          finish('error', asError(e))
          return
        }
      }
    }

    socket.on('data', onData)
    socket.on('end', () => finish('peer'))
    socket.on('error', (err: Error) => finish('error', err))
    socket.on('close', () => {
      sockets.delete(socket)
      if (grace !== null) {
        disarm(grace)
        grace = null
      }
      finish('peer')
    })
    if (keepAliveMs > 0) socket.setKeepAlive(true, keepAliveMs)
    socket.setNoDelay(true)   // small request/reply lines must not wait on Nagle + delayed ACK
    live.add(destroyNow)
    hello = arm(() => finish('hello-timeout'), helloTimeoutMs)
    try {
      opts.onConnection(conn)
    } catch (e) {
      finish('error', asError(e))
    }
  }

  const server = makeServer(accept)
  return new Promise<Relay>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err)
    server.once('error', onListenError)
    server.listen(opts.port, opts.host, () => {
      server.off('error', onListenError)
      // After listen, a server 'error' is an accept failure (EMFILE and the
      // like): transient, and the listener stays up. Handled so it cannot
      // surface as an unhandled event in the main process.
      server.on('error', () => {})
      const bound = server.address() as net.AddressInfo
      let closing: Promise<void> | null = null
      resolve({
        address: bound.address,
        port: bound.port,
        close(): Promise<void> {
          closing ??= new Promise<void>((done) => {
            for (const destroyNow of [...live]) destroyNow()
            for (const s of [...sockets]) s.destroy()
            server.close(() => done())
          })
          return closing
        },
      })
    })
  })
}

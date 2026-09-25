/**
 * relay.ts — a TCP listener that speaks the backend's framing to remote
 * clients: an app's remote-control endpoint, a GUI on another machine.
 *
 * It moves bytes and nothing else. In: '\n'-terminated UTF-8 lines, handed to
 * the app one string at a time. Who is admitted, what a line means and when a
 * client is dropped are the app's decisions. No electron import, so it loads
 * under `node --test` like backendProcess.ts.
 */
import * as net from 'node:net'

export interface RelayConnection {
  readonly remoteAddress: string
  readonly remotePort: number
}

export type RelayCloseReason = 'peer' | 'app' | 'hello-timeout' | 'line-too-long' | 'error'

export interface Relay {
  readonly address: string
  readonly port: number
  /** Ends every connection (reason 'app') and the server; resolves once the server has stopped. Safe to call twice. */
  close(): Promise<void>
}

export interface RelayOptions {
  /** Bound exactly: no fallback, no discovery. '0.0.0.0' binds every interface only when the app passes it. */
  host: string
  /** 0 = ephemeral; the bound port is reported on the Relay. */
  port: number
  onConnection: (c: RelayConnection) => void
  /** Every non-blank line, '\r\n' accepted, the first (hello) included. The relay never parses it. */
  onLine: (c: RelayConnection, line: string) => void
  /** Exactly once per connection; `err` is set for 'error'. */
  onClose: (c: RelayConnection, reason: RelayCloseReason, err?: Error) => void
  /**
   * The TLS hook. Called once, as createServer(connectionListener), so a
   * factory returning tls.createServer(tlsOptions, connectionListener) fits.
   * Default net.createServer.
   */
  createServer?: typeof net.createServer
}

const NL = 0x0a

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

export function createRelay(opts: RelayOptions): Promise<Relay> {
  const makeServer = opts.createServer ?? net.createServer
  const live = new Set<() => void>()      // destroy-now closers of connections still open to the app
  const sockets = new Set<net.Socket>()   // every accepted socket not yet 'close'd

  const accept = (socket: net.Socket): void => {
    sockets.add(socket)
    let closed = false
    let pending: Buffer[] = []   // the partial line so far, as received
    let pendingLen = 0

    const conn: RelayConnection = {
      remoteAddress: socket.remoteAddress ?? '',
      remotePort: socket.remotePort ?? 0,
    }

    const finish = (reason: RelayCloseReason, err?: Error): void => {
      if (closed) return
      closed = true
      live.delete(destroyNow)
      pending = []
      pendingLen = 0
      socket.destroy()
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
      finish('peer')
    })
    live.add(destroyNow)
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

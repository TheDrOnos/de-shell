// relay_echo_server.mjs — a real createRelay under Node, for the cross-runtime
// round trip in test_remote_client.py (not collected by pytest).
//
// Listens on 127.0.0.1:0 and prints "PORT <n>". Every line is echoed back as
// {type: 'echo', line}. The first line on a connection also admits it and is
// followed by one PLOTBIN frame (PROBE in the test). A line containing "bye"
// is echoed, then the app closes the connection. Exits when stdin ends.
import { createRelay } from '../de_shell/js/main/relay.ts'

const payload = Buffer.alloc(256 * 1024)
for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
payload.write('\nPLOTBIN:9:9\n', 1000, 'latin1')

setTimeout(() => process.exit(3), 60_000).unref()
const greeted = new WeakSet()
const relay = await createRelay({
  host: '127.0.0.1',
  port: 0,
  onConnection: () => {},
  onLine: (c, line) => {
    c.writeMessage({ type: 'echo', line })
    if (!greeted.has(c)) {
      greeted.add(c)
      c.admit()
      c.writeBinary({ fig_id: 'probe', key: 'image', label: 'εxx Å' }, payload)
    }
    if (line.includes('"bye"')) c.close()
  },
  onClose: () => {},
})

process.stdout.write(`PORT ${relay.port}\n`)
process.stdin.resume()
process.stdin.on('end', () => {
  relay.close().then(() => process.exit(0))
})

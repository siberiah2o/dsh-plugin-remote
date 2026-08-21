import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = body.length < 126
    ? Buffer.from([0x80 | opcode, body.length])
    : body.length <= 0xffff
      ? Buffer.from([0x80 | opcode, 126, body.length >>> 8, body.length & 255])
      : (() => {
          const h = Buffer.alloc(10)
          h[0] = 0x80 | opcode
          h[1] = 127
          h.writeBigUInt64BE(BigInt(body.length), 2)
          return h
        })()
  return Buffer.concat([head, body])
}

export function acceptWebSocket(req, socket, head, handlers = {}) {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'))
  // Disable Nagle for the small control/ACK messages used by the desktop
  // protocol. Large JPEG frames are already gated by the application-level
  // backpressure window below, while input should not wait for coalescing.
  socket.setNoDelay?.(true)

  let pending = Buffer.alloc(0)
  let closed = false
  let backpressured = false
  const writeFrame = (opcode, value) => {
    if (closed || !socket.writable) return false
    const writable = socket.write(frame(opcode, value))
    if (!writable) backpressured = true
    return writable
  }
  const peer = {
    sendText(value) { return writeFrame(1, String(value)) },
    sendJson(value) { return peer.sendText(JSON.stringify(value)) },
    sendBinary(value) { return writeFrame(2, value) },
    close(code = 1000, reason = '') {
      if (closed) return
      closed = true
      const text = Buffer.from(String(reason).slice(0, 120))
      const body = Buffer.alloc(2 + text.length)
      body.writeUInt16BE(code, 0)
      text.copy(body, 2)
      try { socket.end(frame(8, body)) } catch { socket.destroy() }
    },
    get bufferedBytes() { return socket.writableLength },
    get backpressured() { return backpressured },
    socket,
  }

  function consume() {
    while (pending.length >= 2) {
      const b0 = pending[0]
      const b1 = pending[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (!fin) { peer.close(1003, 'fragmented frames unsupported'); return }
      if (length === 126) {
        if (pending.length < 4) return
        length = pending.readUInt16BE(2); offset = 4
      } else if (length === 127) {
        if (pending.length < 10) return
        const n = pending.readBigUInt64BE(2)
        if (n > 16n * 1024n * 1024n) { peer.close(1009, 'frame too large'); return }
        length = Number(n); offset = 10
      }
      if (!masked) { peer.close(1002, 'client frames must be masked'); return }
      if (pending.length < offset + 4 + length) return
      const mask = pending.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.from(pending.subarray(offset, offset + length))
      pending = pending.subarray(offset + length)
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
      if (opcode === 8) { peer.close(); return }
      if (opcode === 9) { socket.write(frame(10, payload)); continue }
      if (opcode === 10) continue
      if (opcode === 1) handlers.message?.(payload.toString('utf8'), false, peer)
      else if (opcode === 2) handlers.message?.(payload, true, peer)
      else { peer.close(1003, 'unsupported opcode'); return }
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return
    pending = Buffer.concat([pending, chunk])
    if (pending.length > 20 * 1024 * 1024) { peer.close(1009, 'buffer too large'); return }
    try { consume() } catch (error) { handlers.error?.(error, peer); peer.close(1011, 'protocol error') }
  })
  socket.on('drain', () => { backpressured = false })
  socket.on('error', (error) => handlers.error?.(error, peer))
  socket.on('close', () => {
    closed = true
    handlers.close?.(peer)
  })
  if (head?.length) socket.emit('data', head)
  handlers.open?.(peer)
  return peer
}

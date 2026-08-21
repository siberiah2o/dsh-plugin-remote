// End-to-end smoke test for the bundled desktop helper and gateway relay.
// Run after `npm run build`: node desktop-smoke.mjs
import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = 43000 + Math.floor(Math.random() * 1000)
const upstreamPort = port + 1000
const token = randomBytes(32).toString('hex')
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-remote-smoke-'))
const upstream = http.createServer((_req, res) => res.end('upstream'))
await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

const gateway = spawn(process.execPath, ['server.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DSH_PLUGIN_REMOTE_BIND_HOST: '127.0.0.1',
    DSH_PLUGIN_REMOTE_BIND_PORT: String(port),
    DSH_PLUGIN_REMOTE_UPSTREAM_PORT: String(upstreamPort),
    DSH_PLUGIN_REMOTE_DATA_DIR: dataDir,
    DSH_PLUGIN_REMOTE_DESKTOP_HOST_TOKEN: token,
    DSH_PLUGIN_REMOTE_PARENT_PID: String(process.pid),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
gateway.stdout.pipe(process.stdout)
gateway.stderr.pipe(process.stderr)
let helper

async function waitFor(url, timeout = 30000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    try { const response = await fetch(url); if (response.ok) return response } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`timeout waiting for ${url}`)
}

function maskedFrame(opcode, value) {
  const payload = Buffer.from(value)
  const mask = randomBytes(4)
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3]
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, mask, body])
}

function maskedTextFrame(value) {
  return maskedFrame(1, value)
}

class RawWebSocket {
  constructor(path, cookie, onText) {
    this.path = path
    this.cookie = cookie
    this.onText = onText
    this.socket = net.connect(port, '127.0.0.1')
    this.pending = Buffer.alloc(0)
    this.upgraded = false
    this.openPromise = new Promise((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
    })
    this.socket.on('connect', () => {
      const key = randomBytes(16).toString('base64')
      this.socket.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\nCookie: ' + cookie + '\r\n\r\n')
    })
    this.socket.on('data', (chunk) => {
      this.pending = Buffer.concat([this.pending, chunk])
      try { this.consume() } catch (error) { this.rejectOpen(error); this.socket.destroy() }
    })
    this.socket.on('error', (error) => this.rejectOpen(error))
  }

  async open() {
    return this.openPromise
  }

  consume() {
    if (!this.upgraded) {
      const end = this.pending.indexOf('\r\n\r\n')
      if (end < 0) return
      const headers = this.pending.subarray(0, end).toString()
      if (!headers.startsWith('HTTP/1.1 101')) throw new Error(headers)
      this.pending = this.pending.subarray(end + 4)
      this.upgraded = true
      this.resolveOpen()
    }
    while (this.pending.length >= 2) {
      const opcode = this.pending[0] & 15
      let length = this.pending[1] & 127
      let offset = 2
      if (length === 126) { if (this.pending.length < 4) return; length = this.pending.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (this.pending.length < 10) return; length = Number(this.pending.readBigUInt64BE(2)); offset = 10 }
      if (this.pending.length < offset + length) return
      const payload = this.pending.subarray(offset, offset + length)
      this.pending = this.pending.subarray(offset + length)
      if (opcode === 9) { this.socket.write(maskedFrame(10, payload)); continue }
      if (opcode === 8) { this.socket.destroy(); return }
      if (opcode === 1) this.onText?.(payload.toString('utf8'))
    }
  }

  sendJson(value) {
    if (!this.upgraded || this.socket.destroyed) return false
    this.socket.write(maskedTextFrame(JSON.stringify(value)))
    return true
  }

  close() {
    try { this.socket.destroy() } catch {}
  }
}

async function receiveRtcFrame(cookie) {
  const rtcModule = await import('node-datachannel')
  const rtc = rtcModule.default ?? rtcModule
  let pc
  let remoteReady = false
  let remoteCandidates = []
  let config = []
  let resolveConfig
  const configReady = new Promise((resolve) => { resolveConfig = resolve })
  let resolveFrame
  let rejectFrame
  const frameReady = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject })
  const timer = setTimeout(() => rejectFrame(new Error('WebRTC desktop frame timeout')), 15000)
  const signal = new RawWebSocket('/__remote/desktop/rtc', cookie, (raw) => {
    let message
    try { message = JSON.parse(raw) } catch { return }
    if (message.type === 'rtc-config') {
      config = message.iceServers || []
      resolveConfig(config)
      return
    }
    if (message.type === 'rtc-description' && message.description && pc) {
      try {
        mediaDescriptionSeen = /(?:^|\r?\n)m=video\s/.test(message.description.sdp || '')
        pc.setRemoteDescription(message.description.sdp, 'answer')
        remoteReady = true
        for (const item of remoteCandidates) pc.addRemoteCandidate(item.candidate, item.mid)
        remoteCandidates = []
      } catch (error) { console.error('rtc answer error', error.stack); rejectFrame(error) }
      return
    }
    if (message.type === 'rtc-candidate' && message.candidate && pc) {
      const item = { candidate: String(message.candidate), mid: String(message.mid ?? message.sdpMid ?? '') }
      if (remoteReady) pc.addRemoteCandidate(item.candidate, item.mid)
      else remoteCandidates.push(item)
      return
    }
    if (message.type === 'rtc-error') rejectFrame(new Error(message.error || 'RTC signaling error'))
  })
  await signal.open()
  await Promise.race([configReady, new Promise((resolve) => setTimeout(resolve, 1000))])
  pc = new rtc.PeerConnection('desktop-smoke-' + port, { iceServers: config, enableIceTcp: true })
  pc.onLocalDescription((sdp) => signal.sendJson({ type: 'offer', sdp }))
  pc.onLocalCandidate((candidate, mid) => signal.sendJson({ type: 'candidate', candidate, mid }))
  pc.onStateChange((state) => { if (state === 'failed' || state === 'closed') rejectFrame(new Error('WebRTC state ' + state)) })
  let mediaTrackSeen = false
  let mediaDescriptionSeen = false
  let helperStatusScheduled = false
  pc.onTrack((track) => {
    mediaTrackSeen = true
    track.onError?.((error) => console.error('rtc media track error', error))
  })
  const receiverDescription = new rtc.Video('video', 'RecvOnly')
  receiverDescription.addH264Codec(102)
  receiverDescription.addSSRC(0x44534801, 'dsh-remote-video', 'smoke-stream', 'video')
  pc.addTrack(receiverDescription)
  const control = pc.createDataChannel('control')
  pc.createDataChannel('pointer', { unordered: true, maxRetransmits: 0 })
  const frames = pc.createDataChannel('frames', { unordered: true, maxRetransmits: 0 })
  control.onOpen(() => {
    control.sendMessage(JSON.stringify({ type: 'viewer-ready', protocol: 3 }))
    control.sendMessage(JSON.stringify({ type: 'quality', mode: 'auto' }))
  })
  frames.onMessage((value) => {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (payload.length < 6 || payload[4] !== 0xff || payload[5] !== 0xd8) return
    if (helperStatusScheduled) return
    helperStatusScheduled = true
    control.sendMessage(JSON.stringify({ type: 'frame-ack', seq: payload.readUInt32BE(0), decodeMs: 1 }))
    setTimeout(async () => {
      let helperStatus = null
      try {
        helperStatus = await fetch(`http://127.0.0.1:${port}/admin/desktop/status`, { headers: { cookie } }).then((response) => response.json())
      } catch {}
      clearTimeout(timer)
      resolveFrame({ size: payload.length - 4, transport: 'webrtc', mediaTrackSeen, mediaDescriptionSeen, helperStatus })
    }, 1200)
  })
  pc.setLocalDescription('offer')
  try {
    return await frameReady
  } catch (error) {
    console.error('rtc smoke error', error.stack || error)
    throw error
  } finally {
    clearTimeout(timer)
    try { pc.close() } catch {}
    signal.close()
    try { rtc.cleanup?.() } catch {}
  }
}

function receiveDesktopFrame(cookie) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let pending = Buffer.alloc(0)
    let upgraded = false
    let frameMeta = null
    let frameSize = 0
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('desktop frame timeout')) }, 15000)
    socket.on('connect', () => {
      const key = randomBytes(16).toString('base64')
      socket.write(`GET /__remote/desktop/view HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nCookie: ${cookie}\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      if (!upgraded) {
        const end = pending.indexOf('\r\n\r\n')
        if (end < 0) return
        const headers = pending.subarray(0, end).toString()
        if (!headers.startsWith('HTTP/1.1 101')) { reject(new Error(headers)); socket.destroy(); return }
        pending = pending.subarray(end + 4); upgraded = true
        socket.write(maskedTextFrame(JSON.stringify({ type: 'viewer-ready', protocol: 2 })))
        socket.write(maskedTextFrame(JSON.stringify({ type: 'quality', mode: 'auto' })))
      }
      while (pending.length >= 2) {
        const opcode = pending[0] & 15
        let length = pending[1] & 127
        let offset = 2
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4 }
        else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10 }
        if (pending.length < offset + length) return
        const payload = pending.subarray(offset, offset + length)
        pending = pending.subarray(offset + length)
        if (opcode === 1) {
          try {
            const message = JSON.parse(payload.toString('utf8'))
            if (message.type === 'frame-meta') frameMeta = message
            if (message.type === 'qos' && message.renderFps > 0 && frameSize > 0) {
              clearTimeout(timer); socket.destroy(); resolve({ size: frameSize, qos: message }); return
            }
          } catch {}
          continue
        }
        if (opcode === 2) {
          if (!frameMeta?.seq) { reject(new Error('protocol v2 frame did not include metadata')); socket.destroy(); return }
          socket.write(maskedTextFrame(JSON.stringify({ type: 'frame-ack', seq: frameMeta.seq, decodeMs: 1 })))
          if (payload[0] !== 0xff || payload[1] !== 0xd8) reject(new Error('binary frame is not JPEG'))
          else frameSize = payload.length
        }
      }
    })
    socket.on('error', reject)
  })
}

try {
  await waitFor(`http://127.0.0.1:${port}/__health`)
  const login = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke@example.com', password: 'smoke-password' }),
  })
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('login did not set a cookie')
  const bundledDir = join(here, '..', 'native', 'windows-x64')
  const helperPath = process.env.DSH_DESKTOP_HELPER || (existsSync(join(bundledDir, 'dsh-remote-host-h264.exe'))
    ? join(bundledDir, 'dsh-remote-host-h264.exe')
    : join(bundledDir, 'dsh-remote-host.exe'))
  helper = spawn(helperPath, ['--gateway', `ws://127.0.0.1:${port}/__remote/desktop/host?token=${token}`, '--test-pattern'], { windowsHide: true })
  helper.stdout.pipe(process.stdout)
  helper.stderr.pipe(process.stderr)
  helper.on('exit', (code) => console.error(`helper exited: ${code}`))
  const onlineUntil = Date.now() + 5000
  while (Date.now() < onlineUntil) {
    const state = await fetch(`http://127.0.0.1:${port}/admin/desktop/status`, { headers: { cookie } }).then((r) => r.json())
    if (state.desktop?.online) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  console.log(await fetch(`http://127.0.0.1:${port}/admin/desktop/status`, { headers: { cookie } }).then((r) => r.text()))
  const received = await receiveDesktopFrame(cookie)
  const rtcReceived = await receiveRtcFrame(cookie)
  const status = await fetch(`http://127.0.0.1:${port}/admin/desktop/status`, { headers: { cookie } }).then((r) => r.json())
  if (!status.ok || !status.desktop.online) throw new Error('desktop status is offline')
  console.log(`desktop smoke passed: ${received.size} byte JPEG, ${status.desktop.width}x${status.desktop.height}, qos ${received.qos.latencyMs}ms/${received.qos.renderFps}fps`)
  if (!rtcReceived.mediaDescriptionSeen) throw new Error('WebRTC H264 media track was not negotiated')
  console.log('desktop WebRTC smoke passed: ' + rtcReceived.size + ' byte JPEG + H264 track over ' + rtcReceived.transport + ', helper codec ' + (rtcReceived.helperStatus?.desktop?.codec || status.desktop.codec || 'unknown'))
} finally {
  helper?.kill()
  gateway.kill()
  upstream.close()
  rmSync(dataDir, { recursive: true, force: true })
}

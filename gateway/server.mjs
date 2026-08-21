/**
 * dsh-plugin-remote gateway — custom Next.js server.
 *
 * PUBLIC entry of the remote DSH Web GUI. Responsibilities, in order:
 *   1. serve the login flow  (GET /login page, POST /login JSON, /logout)
 *   2. authenticate a session cookie on everything else
 *   3. reverse-proxy authenticated HTTP + WebSocket traffic to the loopback
 *      dsh web server (ctx.webServer), rewriting Host to that loopback
 *      authority and dropping Origin / sec-fetch-site so the /api browser
 *      trust fence passes without --trusted-host.
 *
 * Zero reverse-proxy dependencies: node:http / node:https / node:crypto only.
 * The Next.js app renders the /login page (and, later, the mobile UI).
 */
import next from 'next'
import http from 'node:http'
import https from 'node:https'
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { createWriteStream, readFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { acceptWebSocket } from './websocket.mjs'
import { DesktopRtcHub, normalizeH264AccessUnit } from './desktop-rtc.mjs'

const scrypt = promisify(scryptCb)
const VERSION = '0.2.0'

let nodeDataChannel = null
try {
  const module = await import('node-datachannel')
  nodeDataChannel = module.default ?? module
} catch (error) {
  console.warn('desktop WebRTC transport unavailable; using WebSocket fallback: ' + error.message)
}

// ── configuration from the host plugin ──────────────────────────────────────
// Env names are DSH_PLUGIN_REMOTE_*; the old DSH_H5_* names are still accepted
// as legacy aliases so a plugin process started before the rename keeps working.
const envOr = (name, legacy) => process.env[name] ?? process.env[legacy] ?? null
function jsonArrayEnv(value, fallback = []) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    console.warn('invalid WebRTC ICE server JSON; using fallback')
    return fallback
  }
}
function nodeRtcIceServers(servers) {
  const result = []
  for (const item of Array.isArray(servers) ? servers : []) {
    if (typeof item === 'string') { result.push(item); continue }
    if (!item || typeof item !== 'object') continue
    // Browser RTCConfiguration uses { urls, username, credential }, while
    // node-datachannel uses { hostname, port, username, password, relayType }.
    // Keep the public config browser-shaped and translate it at the native
    // boundary so TURN credentials work on both sides.
    if (item.hostname) { result.push(item); continue }
    const urls = Array.isArray(item.urls) ? item.urls : [item.urls]
    for (const raw of urls) {
      if (typeof raw !== 'string' || !raw) continue
      try {
        const parsed = new URL(raw)
        if (!parsed.hostname) continue
        if (parsed.protocol === 'stun:' || parsed.protocol === 'stuns:') {
          result.push(raw)
          continue
        }
        if (parsed.protocol !== 'turn:' && parsed.protocol !== 'turns:') continue
        const relayType = parsed.protocol === 'turns:'
          ? 'TurnTls'
          : parsed.searchParams.get('transport') === 'tcp' ? 'TurnTcp' : 'TurnUdp'
        result.push({
          hostname: parsed.hostname,
          port: Number(parsed.port || (parsed.protocol === 'turns:' ? 5349 : 3478)),
          username: item.username,
          password: item.credential,
          relayType,
        })
      } catch { /* ignore malformed ICE entries */ }
    }
  }
  return result
}
function browserRtcIceServers(servers) {
  return (Array.isArray(servers) ? servers : []).flatMap((item) => {
    if (typeof item === 'string' || item?.urls) return [item]
    if (!item?.hostname) return []
    const scheme = item.relayType === 'TurnTls' ? 'turns' : 'turn'
    const transport = item.relayType === 'TurnTcp' ? '?transport=tcp' : ''
    return [{
      urls: `${scheme}:${item.hostname}:${item.port || (scheme === 'turns' ? 5349 : 3478)}${transport}`,
      username: item.username,
      credential: item.password,
    }]
  })
}
const cfg = {
  bindHost: envOr('DSH_PLUGIN_REMOTE_BIND_HOST', 'DSH_H5_BIND_HOST') || '0.0.0.0',
  bindPort: Number(envOr('DSH_PLUGIN_REMOTE_BIND_PORT', 'DSH_H5_BIND_PORT') || 4080),
  upstreamHost: envOr('DSH_PLUGIN_REMOTE_UPSTREAM_HOST', 'DSH_H5_UPSTREAM_HOST') || '127.0.0.1',
  upstreamPort: Number(envOr('DSH_PLUGIN_REMOTE_UPSTREAM_PORT', 'DSH_H5_UPSTREAM_PORT') || 3080),
  siteName: envOr('DSH_PLUGIN_REMOTE_SITE_NAME', 'DSH_H5_SITE_NAME') || 'DSH Remote',
  siteHost: envOr('DSH_PLUGIN_REMOTE_SITE_HOST', 'DSH_H5_SITE_HOST') || '',
  cookieName: envOr('DSH_PLUGIN_REMOTE_COOKIE_NAME', 'DSH_H5_COOKIE_NAME') || 'dsh_plugin_remote_session',
  sessionTtlSec: Number(envOr('DSH_PLUGIN_REMOTE_SESSION_TTL_SEC', 'DSH_H5_SESSION_TTL_SEC') || 604800),
  firstUserAutoCreate: String(envOr('DSH_PLUGIN_REMOTE_FIRST_USER_AUTO_CREATE', 'DSH_H5_FIRST_USER_AUTO_CREATE')) !== 'false',
  dataDir: envOr('DSH_PLUGIN_REMOTE_DATA_DIR', 'DSH_H5_DATA_DIR') || join(process.cwd(), '.dsh-remote-data'),
  tlsCert: envOr('DSH_PLUGIN_REMOTE_TLS_CERT', 'DSH_H5_TLS_CERT') || '',
  tlsKey: envOr('DSH_PLUGIN_REMOTE_TLS_KEY', 'DSH_H5_TLS_KEY') || '',
  dev: String(envOr('DSH_PLUGIN_REMOTE_DEV', 'DSH_H5_DEV')) === 'true',
  desktopHostToken: envOr('DSH_PLUGIN_REMOTE_DESKTOP_HOST_TOKEN', 'DSH_H5_DESKTOP_HOST_TOKEN') || '',
  rtcIceServers: jsonArrayEnv(envOr('DSH_PLUGIN_REMOTE_RTC_ICE_SERVERS', 'DSH_H5_RTC_ICE_SERVERS'), ['stun:stun.l.google.com:19302']),
}

const upstream = {
  hostname: cfg.upstreamHost,
  port: cfg.upstreamPort,
  authority: cfg.upstreamHost + ':' + cfg.upstreamPort,
}
const isHttps = Boolean(cfg.tlsCert && cfg.tlsKey)

// Desktop stream hub. The bundled Windows helper is the single producer;
// authenticated browser sessions are consumers. Binary frames are complete
// JPEG images in protocol v1. Control messages are small JSON objects.
let desktopHost = null
const desktopViewers = new Set()
let desktopRtcHub = null
// RFC6455 keepalive ping (FIN + opcode 9, zero-length, unmasked server frame).
const PING_FRAME = Buffer.from([0x89, 0x00])
let desktopInfo = { online: false, width: 0, height: 0, fps: 0, bitrateKbps: 0, codec: 'jpeg', updatedAt: 0 }
const AUTO_LEVELS = [
  // The first levels are intentionally conservative. A weak link must not
  // spend its first several seconds shipping a 1,000+ px JPEG before the
  // feedback loop has enough samples to react.
  { width: 480, fps: 5, jpegQuality: 28 },
  { width: 640, fps: 8, jpegQuality: 32 },
  { width: 800, fps: 10, jpegQuality: 38 },
  { width: 960, fps: 12, jpegQuality: 45 },
  { width: 1120, fps: 15, jpegQuality: 52 },
  { width: 1280, fps: 18, jpegQuality: 58 },
]
// One frame is enough to keep a healthy link moving. Two frames can turn into
// seconds of stale video when a JPEG is larger than the available bandwidth.
const MAX_IN_FLIGHT_FRAMES = 1
const MAX_DESKTOP_SOCKET_BUFFER = 96 * 1024
let autoLevel = 2
let autoHealthyTicks = 0
let lastDesktopTune = ''
let latestDesktopFrame = null
let latestDesktopFrameGeneration = 0
const H264_PACKET_MAGIC = Buffer.from('DSH2')
const H264_PACKET_HEADER_BYTES = 8
let lastDesktopVideoMode = ''

function desktopViewerCount() {
  return desktopViewers.size + (desktopRtcHub?.viewerCount?.() || 0)
}

function ewma(previous, sample, weight = 0.25) {
  return previous > 0 ? previous * (1 - weight) + sample * weight : sample
}

function sendDesktopTune(config) {
  const key = `${config.width}/${config.fps}/${config.jpegQuality}`
  if (!desktopHost || key === lastDesktopTune) return
  lastDesktopTune = key
  desktopHost.sendJson({ type: 'tune', ...config })
}

function reconcileDesktopQuality() {
  if (!desktopHost || desktopViewerCount() === 0) return
  const modes = [
    ...[...desktopViewers].map((viewer) => viewer.qualityMode || 'auto'),
    ...(desktopRtcHub?.qualityModes?.() || []),
  ]
  const manual = modes.filter((mode) => mode !== 'auto')
  if (manual.length === 0) {
    sendDesktopTune(AUTO_LEVELS[autoLevel])
    return
  }
  const rank = { low: 0, balanced: 1, sharp: 2 }
  const mode = manual.reduce((lowest, current) => (rank[current] ?? 1) < (rank[lowest] ?? 1) ? current : lowest, manual[0])
  lastDesktopTune = ''
  desktopHost.sendJson({ type: 'quality', mode })
}

function sendViewerQos(viewer) {
  viewer.sendJson({
    type: 'qos',
    mode: viewer.qualityMode || 'auto',
    effective: AUTO_LEVELS[autoLevel],
    latencyMs: Math.round(viewer.ackLatencyMs || 0),
    decodeMs: Math.round(viewer.decodeMs || 0),
    renderFps: Math.round(viewer.renderFps || 0),
    droppedFrames: viewer.droppedFrames || 0,
    bufferedBytes: viewer.bufferedBytes,
  })
}

function offerDesktopFrame(viewer, payload, generation, now = Date.now()) {
  if (!payload) return false
  if (viewer.ackCapable) {
    // A tiny sliding window keeps the codec/network pipe occupied without
    // allowing latency to grow. RustDesk follows the same real-time rule:
    // stale video is disposable; current input state is not.
    viewer.inFlight = viewer.inFlight.filter((flight) => {
      if (now - flight.sentAt < 1500) return true
      viewer.frameTimeouts += 1
      return false
    })
    if (viewer.inFlight.length >= MAX_IN_FLIGHT_FRAMES) {
      viewer.droppedFrames += 1
      return false
    }
    // socket.write() accepts and queues data even after it returns false.
    // Never add another image while the previous one is still in the Node
    // write queue; the ACK window alone cannot see that queue.
    if (viewer.backpressured || viewer.bufferedBytes > MAX_DESKTOP_SOCKET_BUFFER) {
      viewer.droppedFrames += 1
      return false
    }
    viewer.frameSeq += 1
    viewer.sendJson({ type: 'frame-meta', seq: viewer.frameSeq, bytes: payload.length })
    viewer.sendBinary(payload)
    viewer.inFlight.push({ seq: viewer.frameSeq, sentAt: now, bytes: payload.length, generation })
    viewer.sentFrames += 1
    return true
  }
  if (!viewer.backpressured && viewer.bufferedBytes < 128 * 1024) {
    viewer.sendBinary(payload)
    return true
  }
  return false
}

const RESET_KEY_CODES = [
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'Enter', 'Escape', 'Backspace', 'Tab', 'Space', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen', 'Pause', 'ContextMenu',
  'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote',
  ...Array.from({ length: 10 }, (_, index) => `Numpad${index}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]

// Older bundled helpers do not know the input-reset message. Send explicit
// releases as a compatibility belt-and-suspenders when a viewer disconnects;
// the current helper also consumes input-reset and simply ignores these
// already-idempotent key/button-up events.
function resetDesktopInput(viewer) {
  if (!desktopHost) return
  desktopHost.sendJson({ type: 'input-reset', reason: 'disconnect', viewer })
  for (const code of RESET_KEY_CODES) desktopHost.sendJson({ type: 'key', action: 'up', code, key: '', viewer })
  for (let button = 0; button <= 4; button += 1) {
    desktopHost.sendJson({ type: 'pointer', action: 'up', x: 0.5, y: 0.5, button, buttons: 0, viewer })
  }
}

function forwardDesktopInput(message) {
  if (!desktopHost || !message) return
  if (message.type === 'input-reset' && message.reason === 'disconnect') {
    resetDesktopInput(message.viewer)
    return
  }
  desktopHost.sendJson(message)
}

// The helper can produce both codecs during a handover. Once every active
// H.264 viewer has reported that its video element is actually playing, the
// JPEG encoder can be disabled and the host spends its CPU on one stream.
// If a browser cannot decode H.264, or a legacy WebSocket viewer is present,
// keep both paths alive so the JPEG fallback remains immediate.
function reconcileDesktopVideoMode() {
  if (!desktopHost) return
  const videoSessions = [...(desktopRtcHub?.sessions || [])].filter((session) => session.video)
  const wantsH264 = videoSessions.length > 0
  const wantsJpeg = desktopViewers.size > 0 || !wantsH264 || videoSessions.some((session) => !session.videoReady)
  const mode = wantsH264 && wantsJpeg ? 'both' : wantsH264 ? 'h264' : 'jpeg'
  if (mode === lastDesktopVideoMode) return
  lastDesktopVideoMode = mode
  desktopHost.sendJson({ type: 'video-mode', mode })
}

function handleRtcState(session, state) {
  if (state === 'connected' || state === 'channel-open' || state === 'closed' || state === 'channel-closed') {
    desktopHost?.sendJson({ type: 'viewers', count: desktopViewerCount() })
    broadcastDesktopJson({ type: 'status', desktop: desktopStatus() })
    reconcileDesktopQuality()
  }
}

if (nodeDataChannel?.PeerConnection) {
  desktopRtcHub = new DesktopRtcHub({
    rtc: nodeDataChannel,
    iceServers: nodeRtcIceServers(cfg.rtcIceServers),
    onInput: forwardDesktopInput,
    onQuality(session) {
      autoHealthyTicks = 0
      session.renderFps = session.renderFps || 0
      reconcileDesktopQuality()
      desktopRtcHub?.sendQos(session, AUTO_LEVELS[autoLevel])
    },
    onVideoState() {
      reconcileDesktopVideoMode()
      desktopHost?.sendJson({ type: 'viewers', count: desktopViewerCount() })
    },
    onState: handleRtcState,
    onFrameTooLarge(session, bytes, max) {
      if (session.qualityMode === 'auto' && autoLevel > 0) {
        autoLevel -= 1
        autoHealthyTicks = 0
        lastDesktopTune = ''
        reconcileDesktopQuality()
      }
      console.warn(`desktop WebRTC frame too large (${bytes} > ${max}); reducing quality`)
    },
  })
}

function sameSecret(a, b) {
  const aa = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb)
}

function broadcastDesktopJson(value) {
  for (const viewer of desktopViewers) viewer.sendJson(value)
  if (value?.type === 'status') desktopRtcHub?.sendStatusAll?.(value.desktop)
}

function desktopStatus() {
  return {
    ...desktopInfo,
    online: Boolean(desktopHost),
    viewers: desktopViewerCount(),
    rtc: Boolean(desktopRtcHub?.available),
  }
}

// ── persistent state: shared secret + user store ────────────────────────────
// One-time migration for standalone runs: move the pre-rename data dir
// (.dsh-h5-data) to the new default (.dsh-remote-data). The plugin path is
// migrated by the plugin itself (lib/index.js resolveDataDir).
if (!existsSync(cfg.dataDir)) {
  const legacyData = join(process.cwd(), '.dsh-h5-data')
  if (existsSync(legacyData)) {
    try { renameSync(legacyData, cfg.dataDir) } catch { /* keep defaults */ }
  }
}
mkdirSync(cfg.dataDir, { recursive: true })
const SECRET_PATH = join(cfg.dataDir, 'remote-secret.key')
const LEGACY_SECRET_PATH = join(cfg.dataDir, 'h5-secret.key')
const USERS_PATH = join(cfg.dataDir, 'users.json')

function loadSecret() {
  // Keep the old secret value across the rename so existing sessions survive.
  if (existsSync(LEGACY_SECRET_PATH) && !existsSync(SECRET_PATH)) {
    renameSync(LEGACY_SECRET_PATH, SECRET_PATH)
  }
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, 'utf8').trim()
  const s = randomBytes(32).toString('hex')
  writeFileSync(SECRET_PATH, s, { mode: 0o600 })
  return s
}
const SECRET = loadSecret()

function loadUsers() {
  try {
    if (!existsSync(USERS_PATH)) return []
    const raw = JSON.parse(readFileSync(USERS_PATH, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}
function saveUsers(users) {
  const tmp = USERS_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(users, null, 2))
  renameSync(tmp, USERS_PATH)
}

// ── remote-access whitelist (allowed source IPs / CIDRs) ────────────────────
// Persisted at <dataDir>/whitelist.json as a plain string array ([] = allow
// all). Hot-reloaded per request (mtime check) so an operator can edit the
// file directly without a restart — also the escape hatch if the settings
// panel locked the current source IP out.
const WHITELIST_PATH = join(cfg.dataDir, 'whitelist.json')
let whitelistCache = { mtime: 0, entries: [], block: null }

function loadWhitelist(force = false) {
  let mtime = 0
  try { mtime = statSync(WHITELIST_PATH).mtimeMs } catch { mtime = 0 }
  if (!force && whitelistCache.mtime === mtime) return whitelistCache
  let entries = []
  try {
    const raw = JSON.parse(readFileSync(WHITELIST_PATH, 'utf8'))
    if (Array.isArray(raw)) entries = raw.filter((e) => typeof e === 'string').map((e) => e.trim()).filter(Boolean)
  } catch { entries = [] }
  const block = new BlockList()
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    try {
      if (slash === -1) block.addAddress(entry)
      else block.addSubnet(entry.slice(0, slash), Number(entry.slice(slash + 1)))
    } catch { /* skip invalid entries */ }
  }
  whitelistCache = { mtime, entries, block }
  return whitelistCache
}

function saveWhitelist(entries) {
  const tmp = WHITELIST_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(entries, null, 2))
  renameSync(tmp, WHITELIST_PATH)
  loadWhitelist(true)
}

/** Loopback sources (127.0.0.0/8, ::1) are always trusted: the server's own
 * loopback cannot originate off-machine traffic, and local management must
 * never lock itself out of the gateway. */
function isLoopback(ip) {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true
  if (isIP(ip) !== 4) return false
  return ip.split('.')[0] === '127'
}

/** True when the whitelist is non-empty and the source IP is not on it. */
function whitelistDenies(ip) {
  if (isLoopback(ip)) return false
  const wl = loadWhitelist()
  if (wl.entries.length === 0) return false
  return !wl.block.check(ip)
}

function isValidWhitelistEntry(entry) {
  const slash = entry.indexOf('/')
  try {
    if (slash === -1) return isIP(entry) !== 0
    return isIP(entry.slice(0, slash)) !== 0 && Number.isInteger(Number(entry.slice(slash + 1)))
  } catch {
    return false
  }
}

// ── request activity log: persistent, sharded by day ───────────────────────
// Every completed request is appended to <dataDir>/logs/YYYY-MM-DD.jsonl
// (JSONL, one entry per line). The settings panel reads the recent entries,
// can download every shard, and can prune shards older than 1 / 3 / 7 days.
const LOG_DIR = join(cfg.dataDir, 'logs')
mkdirSync(LOG_DIR, { recursive: true })
let logStream = null
let logStreamShard = ''

function logDate(t) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function shardPath(name) {
  return join(LOG_DIR, name + '.jsonl')
}
function logRequest(entry) {
  const shard = logDate(entry.t)
  if (logStreamShard !== shard) {
    if (logStream) { try { logStream.end() } catch { /* already closed */ } }
    logStream = createWriteStream(shardPath(shard), { flags: 'a' })
    logStream.on('error', () => { /* disk errors must not break serving */ })
    logStreamShard = shard
  }
  const line = JSON.stringify({
    t: entry.t,
    ip: entry.ip,
    m: entry.m,
    p: entry.p,
    s: entry.s,
    ...(entry.u ? { u: entry.u } : {}),
    ...(entry.denied ? { denied: true } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  }) + String.fromCharCode(10)
  try { logStream.write(line) } catch { /* ignore write errors */ }
}

/** Shard names (dates) in ascending order. */
function listLogShards() {
  try {
    return readdirSync(LOG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

function readShardEntries(name) {
  const out = []
  try {
    for (const line of readFileSync(shardPath(name), 'utf8').split('\n')) {
      const l = line.trim()
      if (!l) continue
      try { out.push(JSON.parse(l)) } catch { /* skip corrupt line */ }
    }
  } catch { /* shard missing */ }
  return out
}

/** Newest-first entries across shards, up to limit. */
function readLogs(limit = 200) {
  const out = []
  for (const name of listLogShards().reverse()) {
    for (const entry of readShardEntries(name).reverse()) {
      out.push(entry)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** Delete shards older than keepDays. Returns removed shard names. */
function pruneLogs(keepDays) {
  const cutoff = Date.now() - keepDays * 86400_000
  const removed = []
  for (const name of listLogShards()) {
    if (name === logStreamShard) continue // never delete today's active shard
    const ts = Date.parse(name + 'T00:00:00')
    if (Number.isNaN(ts) || ts >= cutoff) continue
    try { rmSync(shardPath(name)); removed.push(name) } catch { /* keep going */ }
  }
  return removed
}

function logsToCsv(entries) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const rows = entries.map((e) =>
    [new Date(e.t).toISOString(), e.ip, e.m, e.p, e.s, e.u || '', e.note || ''].map(esc).join(','))
  return ['time,ip,method,path,status,user,note', ...rows].join('\n') + '\n'
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
}

// ── auth primitives ─────────────────────────────────────────────────────────
async function hashPassword(password, salt) {
  const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return key.toString('hex')
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
  return 'v1.' + body + '.' + sig
}

function verifyToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const expected = createHmac('sha256', SECRET).update(parts[1]).digest('base64url')
  const a = Buffer.from(parts[2], 'base64url')
  const b = Buffer.from(expected, 'base64url')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null
    // Session-epoch revocation: logout bumps the user's epoch, invalidating
    // every previously issued token (the old value is rejected below).
    const users = loadUsers()
    const user = users.find((u) => u.username === payload.u)
    const want = user && typeof user.sessionEpoch === 'number' ? user.sessionEpoch : 0
    const got = typeof payload.e === 'number' ? payload.e : 0
    if (got !== want) return null
    return payload
  } catch {
    return null
  }
}

function credentialsFromCookie(req) {
  const header = req.headers.cookie
  if (!header) return null
  const parts = header.split(';')
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) return null
      return { k: part.slice(0, eq).trim(), v: part.slice(eq + 1).trim() }
    })
    .filter(Boolean)
  // Prefer the configured cookie name. The pre-rename legacy name
  // (dsh_h5_session) is only consulted when the primary cookie is absent —
  // a browser can hold both, and a stale legacy cookie must not shadow a
  // fresh session (that caused a login redirect loop after the rename).
  for (const { k, v } of parts) if (k === cfg.cookieName) return v
  if (cfg.cookieName !== 'dsh_h5_session') {
    for (const { k, v } of parts) if (k === 'dsh_h5_session') return v
  }
  return null
}

function setAuthCookie(res, token) {
  const parts = [
    cfg.cookieName + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + cfg.sessionTtlSec,
  ]
  if (isHttps) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', cfg.cookieName + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isHttps ? '; Secure' : ''))
}

// ── brute-force shield: per-IP + global windows ────────────────────────────
const WINDOW_MS = 60_000
const PER_IP_MAX = 15
const GLOBAL_MAX = 120
const loginHits = new Map()
let globalHits = []
function rateLimited(req) {
  const ip = clientIp(req)
  const now = Date.now()
  const e = loginHits.get(ip)
  if (!e || now > e.resetAt) {
    loginHits.set(ip, { n: 1, resetAt: now + WINDOW_MS })
  } else {
    e.n += 1
    if (e.n > PER_IP_MAX) return true
  }
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS)
  if (globalHits.length >= GLOBAL_MAX) return true
  globalHits.push(now)
  return false
}

// ── tiny JSON helpers ───────────────────────────────────────────────────────
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8')
        resolve(s ? JSON.parse(s) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}
function plain(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

// Username policy: a short alphanumeric id (3-32 chars, lowercase) or an
// email address (lowercased, up to 254 chars). Emails make the account id
// memorable on a shared/public gateway.
function isValidUsername(u) {
  if (u.length < 3 || u.length > 254) return false
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(u)) return true
  return /^[a-z0-9._-]{3,32}$/.test(u)
}

// ── login endpoints ─────────────────────────────────────────────────────────
async function handleLoginPost(req, res) {
  if (rateLimited(req)) {
    json(res, 429, { ok: false, code: 'rateLimited', error: 'too many attempts, try again later' })
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    json(res, 400, { ok: false, code: 'invalidBody', error: 'invalid request body' })
    return
  }
  const username = String(body.username || '').trim().toLowerCase()
  const password = String(body.password || '')
  const users = loadUsers()

  let user = users.find((u) => u.username === username)
  if (!user && cfg.firstUserAutoCreate && users.length === 0) {
    // First visit: bootstrap the initial account (like the dsh-webui-auth flow).
    if (!isValidUsername(username)) {
      json(res, 400, { ok: false, code: 'invalidUsername', error: 'username must be 3-32 chars of a-z0-9._- or a valid email address' })
      return
    }
    if (password.length < 8) {
      json(res, 400, { ok: false, code: 'passwordTooShort', error: 'password must be at least 8 characters' })
      return
    }
    const salt = randomBytes(16).toString('hex')
    user = { username, salt, hash: await hashPassword(password, salt), created: Date.now() }
    users.push(user)
    saveUsers(users)
  } else if (!user || user.disabled) {
    // Run a dummy hash to keep timing uniform.
    await hashPassword(password, 'deadbeefdeadbeefdeadbeefdeadbeef')
    json(res, 401, { ok: false, code: 'invalidCredentials', error: 'invalid username or password' })
    return
  } else {
    const hash = await hashPassword(password, user.salt)
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(user.hash, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      json(res, 401, { ok: false, code: 'invalidCredentials', error: 'invalid username or password' })
      return
    }
  }
  const now = Math.floor(Date.now() / 1000)
  const epoch = typeof user.sessionEpoch === 'number' ? user.sessionEpoch : 0
  const token = signToken({ u: user.username, iat: now, exp: now + cfg.sessionTtlSec, n: randomBytes(8).toString('hex'), e: epoch })
  setAuthCookie(res, token)
  json(res, 200, { ok: true })
}

// ── injected into the proxied DSH SPA shell ────────────────────────────────
const HTML_INJECT_MAX = 16 * 1024 * 1024

const LOGOUT_JS = "(function(){function attach(){var b=document.getElementById('dsh-plugin-remote-logout');if(!b)return;b.addEventListener('click',function(){fetch('/logout',{method:'POST',credentials:'same-origin'}).catch(function(){}).finally(function(){window.location.href='/login'})})}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach);else attach()})();"

// crypto.randomUUID is a SecureContext-only Web API: remote browsers hitting
// plain http://<ip>:port don't have it, and DSH's client mints RpcId/MessageId
// with it on every call. Shims it via getRandomValues (available everywhere).
// Injected as a classic inline script so it runs before the deferred app module.
const RANDOM_UUID_POLYFILL = '<script>(function(){var c=window.crypto;if(c&&typeof c.randomUUID!=="function"){c.randomUUID=function(){var b=c.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=(b[i]<16?"0":"")+b[i].toString(16);if(i===3||i===5||i===7||i===9){h+="-"}}return h}}})();</script>'

const LOGOUT_HTML = [
  '<style>',
  '#dsh-plugin-remote-logout{position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 14px;border-radius:8px;font-size:13px;line-height:1.4;color:#e4e4e7;background:rgba(24,24,27,.78);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(6px);cursor:pointer;font-family:system-ui,-apple-system,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none}',
  '#dsh-plugin-remote-logout:hover{background:rgba(39,39,42,.92)}',
  '</style>',
  '<div id="dsh-plugin-remote-logout" role="button" title="\u9000\u51fa\u767b\u5f55 (logout)">\u9000\u51fa\u767b\u5f55</div>',
  '<script src="/__remote/logout.js" defer></script>',
].join('\n')

function injectLogoutHtml(html) {
  const idx = html.lastIndexOf('</body>')
  const snippet = RANDOM_UUID_POLYFILL + '\n' + LOGOUT_HTML
  if (idx === -1) return html + '\n' + snippet
  return html.slice(0, idx) + snippet + '\n' + html.slice(idx)
}

// ── reverse proxy (HTTP) ────────────────────────────────────────────────────
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 })

function proxyHttp(req, res) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'sec-fetch-site' || lk === 'cookie' || lk === 'connection') continue
    headers[lk] = typeof v === 'string' ? v : v.join(', ')
  }
  headers.host = upstream.authority
  // Rewrite Origin to the loopback authority instead of stripping it: DSH's
  // /api fence accepts Origin===Host, and third-party plugins (e.g.
  // dshmarket's sameOrigin()) require an Origin matching the Host they see —
  // both pass with this single rewrite.
  headers.origin = (isHttps ? 'https' : 'http') + '://' + upstream.authority
  // No x-forwarded-for: dshmarket's trustedDownloadRequest/trustedRestartRequest
  // reject any request carrying forwarded headers (anti-proxy gate), and DSH's
  // own /api fence only looks at Host/Origin/sec-fetch-site.
  headers['x-forwarded-proto'] = isHttps ? 'https' : 'http'

  const preq = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers,
      agent: upstreamAgent,
    },
    (pres) => {
      const out = {}
      for (const [k, v] of Object.entries(pres.headers)) {
        const lk = k.toLowerCase()
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade' || lk === 'content-length') continue
        out[k] = v
      }
      const ctype = String(pres.headers['content-type'] || '').toLowerCase()
      if (ctype.includes('text/html')) {
        // Buffer HTML so the remote logout affordance can be injected into the
        // DSH SPA shell (the gateway is the auth boundary; the GUI itself has
        // no logout concept).
        const chunks = []
        let size = 0
        pres.on('data', (c) => {
          size += c.length
          if (size <= HTML_INJECT_MAX) chunks.push(c)
        })
        pres.on('end', () => {
          if (size <= HTML_INJECT_MAX) {
            const html = injectLogoutHtml(Buffer.concat(chunks).toString('utf8'))
            out['content-type'] = 'text/html; charset=utf-8'
            out['content-length'] = String(Buffer.byteLength(html, 'utf8'))
            res.writeHead(pres.statusCode || 502, out)
            res.end(html)
          } else {
            res.writeHead(pres.statusCode || 502, out)
            pres.pipe(res)
          }
        })
        pres.on('error', () => {
          try { res.destroy() } catch {}
        })
      } else {
        res.writeHead(pres.statusCode || 502, out)
        pres.pipe(res)
      }
    }
  )
  preq.on('error', (err) => {
    if (!res.headersSent) {
      plain(res, 502, 'Bad Gateway: ' + err.message)
    } else {
      res.destroy()
    }
  })
  // Client went away mid-request: tear down the upstream hop so a dropped
  // remote link never leaves a half-piped upstream connection hanging.
  req.on('aborted', () => { try { preq.destroy() } catch {} })
  res.on('close', () => {
    if (!res.writableEnded) { try { preq.destroy() } catch {} }
  })
  req.pipe(preq)
}

function proxyWs(req, socket, head) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'origin' || lk === 'sec-fetch-site' || lk === 'cookie' || lk === 'connection' || lk === 'upgrade') continue
    headers[lk] = typeof v === 'string' ? v : v.join(', ')
  }
  headers.host = upstream.authority
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const preq = http.request({
    host: upstream.hostname,
    port: upstream.port,
    path: req.url,
    method: 'GET',
    headers,
  })
  preq.on('upgrade', (pres, socket2, head2) => {
    // TCP keepalive catches half-open mobile/NAT links even when an
    // intermediary swallows WebSocket control frames. Keeping both hops warm
    // prevents an in-flight RPC (notably session.history) from being aborted
    // merely because the remote connection was idle beforehand.
    socket.setKeepAlive(true, 15_000)
    socket2.setKeepAlive(true, 15_000)
    socket.setNoDelay(true)
    socket2.setNoDelay(true)
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (const [k, v] of Object.entries(pres.headers)) {
      // Keep Connection/Upgrade on the 101: strict clients require them.
      lines.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (head2 && head2.length) socket.write(head2)
    socket2.pipe(socket)
    socket.pipe(socket2)
    const kill = () => {
      try { socket2.destroy() } catch {}
      try { socket.destroy() } catch {}
    }
    socket2.on('error', kill)
    socket.on('error', kill)
    socket2.on('close', () => socket.destroy())
    socket.on('close', () => socket2.destroy())
    // Keepalive: ping the client every 30s so NAT/proxy idle mappings stay
    // alive for the DSH event/terminal streams. A drop there aborts in-flight
    // RPCs (e.g. session.history -> 'The user aborted a request'). The
    // browser's auto-pong flows back through the pipe, warming the upstream.
    const keepalive = setInterval(() => {
      try { socket.write(PING_FRAME) } catch { /* socket gone */ }
    }, 20_000)
    keepalive.unref?.()
    const stopKeepalive = () => { try { clearInterval(keepalive) } catch {} }
    socket.on('close', stopKeepalive)
    socket2.on('close', stopKeepalive)
  })
  // Upstream answered without upgrading (e.g. 400/403/502): relay the plain
  // response and close. Without this the client socket would hang.
  preq.on('response', (pres) => {
    const lines = ['HTTP/1.1 ' + (pres.statusCode || 502) + ' ' + (pres.statusMessage || '')]
    for (const [k, v] of Object.entries(pres.headers)) {
      if (k.toLowerCase() === 'connection' || k.toLowerCase() === 'transfer-encoding' || k.toLowerCase() === 'upgrade') continue
      lines.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    pres.pipe(socket)
    pres.on('end', () => { try { socket.destroy() } catch {} })
  })
  preq.on('error', () => {
    try { socket.destroy() } catch {}
  })
  if (head && head.length) preq.write(head)
  preq.end()
}

// ── main request handler ────────────────────────────────────────────────────
function hostMatches(req) {
  if (!cfg.siteHost) return true
  const host = req.headers.host || ''
  return host === cfg.siteHost || host === cfg.siteHost.split(':')[0] + ':' + cfg.bindPort
}

function serve(nextHandler) {
  return (req, res) => {
    // Activity log: persist every completed request (newest first in the UI).
    res.on('finish', () => {
      logRequest({
        t: Date.now(),
        ip: clientIp(req),
        m: req.method,
        p: (req.url || '/').split('?')[0],
        s: res.statusCode,
        ...(req.authedUser ? { u: req.authedUser } : {}),
        ...(req.denied ? { denied: true } : {}),
        ...(req.adminNote ? { note: req.adminNote } : {}),
      })
    })

    if (!hostMatches(req)) {
      plain(res, 404, 'not found')
      return
    }
    const urlPath = (req.url || '/').split('?')[0]

    // Remote-access whitelist gate: applies to everything except the health
    // probe (the plugin supervisor must always reach it).
    if (urlPath !== '/__health') {
      if (whitelistDenies(clientIp(req))) {
        req.denied = true
        plain(res, 403, 'forbidden: source IP not in the remote-access whitelist')
        return
      }
    }

    // Health — public (only when the plugin's health probe or an operator asks).
    if (req.method === 'GET' && urlPath === '/__health') {
      json(res, 200, {
        ok: true,
        name: 'dsh-plugin-remote-gateway',
        version: VERSION,
        upstream: upstream.authority,
        port: cfg.bindPort,
        https: isHttps,
        dev: cfg.dev,
        users: loadUsers().length,
      })
      return
    }

    // Login page (Next.js) and its public assets.
    if (req.method === 'GET' && (urlPath === '/login' || urlPath === '/login/')) {
      const token = credentialsFromCookie(req)
      const authed = token ? verifyToken(token) : null
      if (authed) {
        req.authedUser = authed.u
        res.writeHead(302, { location: '/' })
        res.end()
        return
      }
      // Reaching the login page with a session cookie means it is stale or
      // invalid — drop it (current name plus the pre-rename legacy name) so
      // a leftover cookie cannot keep bouncing the user back to /login.
      const clear = (name) => name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isHttps ? '; Secure' : '')
      const stale = [clear(cfg.cookieName)]
      if (cfg.cookieName !== 'dsh_h5_session') stale.push(clear('dsh_h5_session'))
      res.setHeader('Set-Cookie', stale)
      nextHandler(req, res)
      return
    }
    if (req.method === 'GET' && urlPath.startsWith('/_next/')) {
      nextHandler(req, res)
      return
    }
    // Public assets Next.js serves from gateway/public/ (e.g. /placeholder.svg).
    if (req.method === 'GET' && urlPath === '/placeholder.svg') {
      nextHandler(req, res)
      return
    }

    // Login API — plain JSON handled here (never reaches the upstream).
    if (req.method === 'POST' && urlPath === '/login') {
      handleLoginPost(req, res)
      return
    }
    if (req.method === 'GET' && urlPath === '/login-info') {
      json(res, 200, {
        siteName: cfg.siteName,
        needsSetup: cfg.firstUserAutoCreate && loadUsers().length === 0,
      })
      return
    }
    if ((req.method === 'GET' || req.method === 'POST') && urlPath === '/logout') {
      const t = credentialsFromCookie(req)
      const payload = t ? verifyToken(t) : null
      if (payload) {
        const users = loadUsers()
        const user = users.find((u) => u.username === payload.u)
        if (user) {
          user.sessionEpoch = (typeof user.sessionEpoch === 'number' ? user.sessionEpoch : 0) + 1
          saveUsers(users)
        }
      }
      clearAuthCookie(res)
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }

    // The web manifest is static metadata referenced by the DSH index; let it
    // through without a session so browsers never get a 302->login HTML for it
    // (which parses as a manifest syntax error). Content stays in sync with DSH.
    if (req.method === 'GET' && (urlPath === '/manifest.webmanifest' || urlPath === '/favicon.svg')) {
      proxyHttp(req, res)
      return
    }

    // Asset backing the injected logout button (served same-origin).
    if (req.method === 'GET' && urlPath === '/__remote/logout.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(LOGOUT_JS)
      return
    }

    // Remote-access admin API (whitelist / accounts / activity log). Session
    // required; handled by the gateway itself, never proxied upstream.
    if (urlPath.startsWith('/admin/')) {
      handleAdmin(req, res, urlPath)
      return
    }

    // Everything else: authenticated proxy.
    const token = credentialsFromCookie(req)
    const authed = token ? verifyToken(token) : null
    if (authed) req.authedUser = authed.u
    if (!authed) {
      const wantsJson = req.headers.accept && req.headers.accept.includes('application/json')
      if (wantsJson || /^\/(api|login)/.test(urlPath)) {
        json(res, 401, { ok: false, code: 'unauthorized', error: 'unauthorized' })
      } else {
        res.writeHead(302, { location: '/login' })
        res.end()
      }
      return
    }
    proxyHttp(req, res)
  }
}

// ── remote-access admin API ────────────────────────────────────────────────
// All /admin/* endpoints require a valid session. CORS echoes any Origin so
// the settings panel also works when the DSH GUI is viewed directly on the
// loopback (same-site cross-origin fetch; the session cookie still applies).
async function handleAdmin(req, res, urlPath) {
  const origin = req.headers.origin
  const cors = origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'vary': 'Origin',
      }
    : {}

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end()
    return
  }

  const token = credentialsFromCookie(req)
  const authed = token ? verifyToken(token) : null
  if (!authed) {
    json(res, 401, { ok: false, code: 'unauthorized', error: 'unauthorized' }, cors)
    return
  }
  req.authedUser = authed.u

  if (req.method === 'GET' && urlPath === '/admin/desktop/status') {
    json(res, 200, { ok: true, desktop: desktopStatus() }, cors)
    return
  }

  if (req.method === 'GET' && urlPath === '/admin/whitelist') {
    json(res, 200, { ok: true, entries: loadWhitelist().entries }, cors)
    return
  }
  if (req.method === 'PUT' && urlPath === '/admin/whitelist') {
    let body
    try {
      body = await readJsonBody(req, 64 * 1024)
    } catch {
      json(res, 400, { ok: false, code: 'invalidBody', error: 'invalid request body' }, cors)
      return
    }
    const entries = Array.isArray(body.entries)
      ? body.entries.map((e) => String(e).trim()).filter(Boolean)
      : []
    if (entries.some((entry) => !isValidWhitelistEntry(entry))) {
      json(res, 400, { ok: false, code: 'invalidEntry', error: 'invalid entry — use an IP or CIDR, e.g. 203.0.113.7 or 10.0.0.0/8' }, cors)
      return
    }
    saveWhitelist(entries)
    req.adminNote = 'whitelist updated: ' + (entries.length ? entries.join(', ') : 'allow all')
    json(res, 200, { ok: true, entries: loadWhitelist(true).entries }, cors)
    return
  }

  if (req.method === 'GET' && urlPath === '/admin/accounts') {
    const users = loadUsers().map((u) => ({ username: u.username, created: u.created ?? 0 }))
    json(res, 200, { ok: true, users }, cors)
    return
  }
  if (req.method === 'POST' && urlPath === '/admin/password') {
    let body
    try {
      body = await readJsonBody(req, 64 * 1024)
    } catch {
      json(res, 400, { ok: false, code: 'invalidBody', error: 'invalid request body' }, cors)
      return
    }
    const target = String(body.username || '').trim().toLowerCase()
    const password = String(body.password || '')
    if (!isValidUsername(target)) {
      json(res, 400, { ok: false, code: 'invalidUsername', error: 'invalid username' }, cors)
      return
    }
    if (password.length < 8) {
      json(res, 400, { ok: false, code: 'passwordTooShort', error: 'password must be at least 8 characters' }, cors)
      return
    }
    const users = loadUsers()
    const user = users.find((u) => u.username === target)
    if (!user) {
      json(res, 404, { ok: false, code: 'noSuchAccount', error: 'no such account' }, cors)
      return
    }
    user.hash = await hashPassword(password, user.salt)
    user.sessionEpoch = (typeof user.sessionEpoch === 'number' ? user.sessionEpoch : 0) + 1
    saveUsers(users)
    req.adminNote = 'password changed for ' + target
    json(res, 200, { ok: true }, cors)
    return
  }

  if (req.method === 'GET' && urlPath === '/admin/logs') {
    const limit = Math.min(Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 200, 1000)
    json(res, 200, { ok: true, logs: readLogs(limit), shards: listLogShards() }, cors)
    return
  }
  if (req.method === 'GET' && urlPath === '/admin/logs/download') {
    const params = new URL(req.url, 'http://x').searchParams
    const shard = params.get('shard')
    const format = params.get('format') === 'csv' ? 'csv' : 'jsonl'
    const corsDL = { ...cors }
    if (origin) corsDL['access-control-expose-headers'] = 'content-disposition'
    if (shard && !/^\d{4}-\d{2}-\d{2}$/.test(shard)) {
      json(res, 400, { ok: false, code: 'invalidShard', error: 'invalid shard' }, corsDL)
      return
    }
    let body = ''
    let filename = 'gateway-logs-' + logDate(Date.now()) + '.' + format
    if (shard) {
      filename = 'gateway-logs-' + shard + '.' + format
      body = format === 'csv'
        ? logsToCsv(readShardEntries(shard))
        : (readFileSync(shardPath(shard), 'utf8') || '')
    } else {
      const all = []
      for (const name of listLogShards()) all.push(...readShardEntries(name))
      body = format === 'csv' ? logsToCsv(all) : all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : '')
    }
    req.adminNote = 'downloaded logs' + (shard ? ' (' + shard + ')' : '') + ' as ' + format
    res.writeHead(200, {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'content-disposition': 'attachment; filename="' + filename + '"',
      ...corsDL,
    })
    res.end(body)
    return
  }
  if (req.method === 'POST' && urlPath === '/admin/logs/prune') {
    let body
    try {
      body = await readJsonBody(req, 16 * 1024)
    } catch {
      json(res, 400, { ok: false, code: 'invalidBody', error: 'invalid request body' }, cors)
      return
    }
    const keepDays = Number(body.keepDays)
    if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 365) {
      json(res, 400, { ok: false, code: 'invalidKeepDays', error: 'keepDays must be an integer between 1 and 365' }, cors)
      return
    }
    const removed = pruneLogs(keepDays)
    req.adminNote = 'pruned logs: kept ' + keepDays + ' day(s), removed ' + removed.length + ' shard(s)'
    json(res, 200, { ok: true, removed }, cors)
    return
  }

  json(res, 404, { ok: false, code: 'notFound', error: 'not found' }, cors)
}

// ── config-driven account provisioning ──────────────────────────────────────
// DSH_PLUGIN_REMOTE_INITIAL_USERS (JSON [{username, password}]) is read at
// boot (legacy name DSH_H5_INITIAL_USERS still accepted):
// missing accounts are created, changed passwords are updated (session epoch
// bumped => old sessions revoked). Plaintext is never stored in users.json.
async function provisionInitialUsers() {
  const raw = process.env.DSH_PLUGIN_REMOTE_INITIAL_USERS ?? process.env.DSH_H5_INITIAL_USERS
  if (!raw) return
  let entries
  try {
    entries = JSON.parse(raw)
  } catch {
    console.error('invalid DSH_PLUGIN_REMOTE_INITIAL_USERS, ignored')
    return
  }
  if (!Array.isArray(entries) || entries.length === 0) return
  const users = loadUsers()
  let changed = false
  for (const entry of entries) {
    const username = String(entry?.username || '').trim().toLowerCase()
    const password = String(entry?.password || '')
    if (!isValidUsername(username)) {
      console.error('initialUsers: invalid username ' + JSON.stringify(username))
      continue
    }
    if (password.length < 8) {
      console.error('initialUsers: password too short for ' + username)
      continue
    }
    const existing = users.find((u) => u.username === username)
    if (existing) {
      const hash = await hashPassword(password, existing.salt)
      const a = Buffer.from(hash, 'hex')
      const b = Buffer.from(existing.hash, 'hex')
      if (a.length === b.length && timingSafeEqual(a, b)) continue
      existing.hash = hash
      existing.sessionEpoch = (typeof existing.sessionEpoch === 'number' ? existing.sessionEpoch : 0) + 1
      changed = true
      console.log('initialUsers: updated password for ' + username)
    } else {
      const salt = randomBytes(16).toString('hex')
      users.push({ username, salt, hash: await hashPassword(password, salt), created: Date.now() })
      changed = true
      console.log('initialUsers: provisioned ' + username)
    }
  }
  if (changed) saveUsers(users)
}

// ── boot ────────────────────────────────────────────────────────────────────
const dir = process.cwd()
const nextApp = next({ dev: cfg.dev, dir, hostname: cfg.bindHost, port: cfg.bindPort, customServer: true })
await nextApp.prepare()
await provisionInitialUsers()
if (!cfg.firstUserAutoCreate && loadUsers().length === 0) {
  console.warn('no users configured and firstUserAutoCreate is off — nobody can log in. Set initialUsers in the plugin config, or run: node <plugin>/lib/remote-passwd.mjs add <username>')
}
const requestHandler = nextApp.getRequestHandler()
const handler = serve(requestHandler)

const server = isHttps
  ? https.createServer({ cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) }, handler)
  : http.createServer(handler)

server.on('upgrade', (req, socket, head) => {
  const wsPath = (req.url || '/').split('?')[0]
  if (!hostMatches(req)) {
    logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: 404, u: null })
    socket.destroy()
    return
  }
  if (wsPath === '/__remote/desktop/host') {
    const supplied = new URL(req.url || '/', 'http://localhost').searchParams.get('token')
    if (!sameSecret(supplied, cfg.desktopHostToken)) {
      logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: 401, note: 'desktop host rejected' })
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    desktopHost?.close(1012, 'host replaced')
    const peer = acceptWebSocket(req, socket, head, {
      open(host) {
        desktopHost = host
        lastDesktopTune = ''
        lastDesktopVideoMode = ''
        desktopInfo = { ...desktopInfo, online: true, updatedAt: Date.now() }
        broadcastDesktopJson({ type: 'status', desktop: desktopStatus() })
        reconcileDesktopQuality()
        reconcileDesktopVideoMode()
      },
      message(payload, binary, host) {
        if (binary) {
          if (payload.length >= H264_PACKET_HEADER_BYTES && payload.subarray(0, 4).equals(H264_PACKET_MAGIC)) {
            const accessUnit = normalizeH264AccessUnit(payload.subarray(H264_PACKET_HEADER_BYTES))
            if (accessUnit) {
              desktopRtcHub?.setLatestVideo(accessUnit, payload.readUInt32BE(4))
            }
            return
          }
          const now = Date.now()
          latestDesktopFrame = payload
          latestDesktopFrameGeneration += 1
          // Protocol v2 viewers acknowledge a frame only after browser decode
          // and paint. Keep exactly one frame in flight; all intermediate host
          // captures collapse into latestDesktopFrame so latency cannot grow.
          for (const viewer of desktopViewers) {
            offerDesktopFrame(viewer, payload, latestDesktopFrameGeneration, now)
          }
          desktopRtcHub?.setLatestFrame(payload, latestDesktopFrameGeneration)
          return
        }
        try {
          const msg = JSON.parse(payload)
          if (msg.type === 'info' || msg.type === 'stats') {
            desktopInfo = {
              ...desktopInfo,
              ...Object.fromEntries(Object.entries(msg).filter(([key]) => ['width', 'height', 'fps', 'bitrateKbps', 'codec', 'encodeMs', 'inputCount', 'inputFailures'].includes(key))),
              online: true,
              updatedAt: Date.now(),
            }
            broadcastDesktopJson({ type: 'status', desktop: desktopStatus() })
          }
        } catch { host.sendJson({ type: 'error', code: 'invalid-json' }) }
      },
      close(host) {
        if (desktopHost !== host) return
        desktopHost = null
        lastDesktopVideoMode = ''
        desktopInfo = { ...desktopInfo, online: false, updatedAt: Date.now() }
        broadcastDesktopJson({ type: 'status', desktop: desktopStatus() })
      },
    })
    logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: peer ? 101 : 400, note: 'desktop host' })
    return
  }

  const wsToken = credentialsFromCookie(req)
  const wsAuthed = wsToken ? verifyToken(wsToken) : null
  if (!wsAuthed) {
    logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: 401, u: null })
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (wsPath === '/__remote/desktop/rtc') {
    if (!desktopRtcHub?.available) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const peer = acceptWebSocket(req, socket, head, {
      open(signal) {
        signal.keepalive = setInterval(() => { try { signal.socket.write(PING_FRAME) } catch {} }, 20_000)
        signal.keepalive.unref?.()
        signal.sendJson({ type: 'rtc-config', iceServers: browserRtcIceServers(cfg.rtcIceServers) })
      },
      message(payload, binary, signal) {
        if (binary || payload.length > 128 * 1024) {
          signal.close(1009, 'signaling message too large')
          return
        }
        try {
          const message = JSON.parse(payload)
          if (!['offer', 'candidate'].includes(message.type)) return
          if (!desktopRtcHub.signal(signal, wsAuthed.u, message)) {
            signal.sendJson({ type: 'rtc-error', error: 'invalid signaling state' })
          }
        } catch (error) {
          signal.sendJson({ type: 'rtc-error', error: error.message || 'invalid signaling message' })
        }
      },
      close(signal) {
        if (signal.keepalive) { try { clearInterval(signal.keepalive) } catch {} }
        desktopRtcHub.closeBySignal(signal)
        reconcileDesktopVideoMode()
      },
    })
    logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: peer ? 101 : 400, u: wsAuthed.u })
    return
  }
  if (wsPath === '/__remote/desktop/view') {
    const peer = acceptWebSocket(req, socket, head, {
      open(viewer) {
        viewer.ackCapable = false
        viewer.qualityMode = 'auto'
        viewer.frameSeq = 0
        viewer.inFlight = []
        viewer.ackLatencyMs = 0
        viewer.decodeMs = 0
        viewer.sentFrames = 0
        viewer.ackedFrames = 0
        viewer.totalAckedFrames = 0
        viewer.renderFps = 0
        viewer.droppedFrames = 0
        viewer.frameTimeouts = 0
        desktopViewers.add(viewer)
        viewer.sendJson({ type: 'status', desktop: desktopStatus() })
        desktopHost?.sendJson({ type: 'viewers', count: desktopViewerCount() })
        reconcileDesktopVideoMode()
        const ka = setInterval(() => { try { viewer.socket.write(PING_FRAME) } catch {} }, 30_000)
        ka.unref?.()
        viewer.keepalive = ka
      },
      message(payload, binary, viewer) {
        if (binary) return
        if (payload.length > 16 * 1024) { viewer.close(1009, 'control message too large'); return }
        try {
          const msg = JSON.parse(payload)
          if (msg.type === 'viewer-ready') {
            viewer.ackCapable = Number(msg.protocol) >= 2
            viewer.inFlight = []
            sendViewerQos(viewer)
            offerDesktopFrame(viewer, latestDesktopFrame, latestDesktopFrameGeneration)
            return
          }
          if (msg.type === 'frame-ack') {
            const ackSeq = Number(msg.seq)
            const flightIndex = viewer.inFlight.findIndex((item) => item.seq === ackSeq)
            if (!viewer.ackCapable || flightIndex < 0) return
            const flight = viewer.inFlight[flightIndex]
            viewer.ackLatencyMs = ewma(viewer.ackLatencyMs, Math.max(0, Date.now() - flight.sentAt))
            viewer.decodeMs = ewma(viewer.decodeMs, Math.max(0, Math.min(2000, Number(msg.decodeMs) || 0)))
            viewer.inFlight.splice(0, flightIndex + 1)
            viewer.ackedFrames += 1
            viewer.totalAckedFrames += 1
            if (viewer.totalAckedFrames % 10 === 0) sendViewerQos(viewer)
            if (latestDesktopFrameGeneration > flight.generation && viewer.inFlight.length < MAX_IN_FLIGHT_FRAMES) {
              offerDesktopFrame(viewer, latestDesktopFrame, latestDesktopFrameGeneration)
            }
            return
          }
          if (msg.type === 'quality') {
            viewer.qualityMode = ['auto', 'low', 'balanced', 'sharp'].includes(msg.mode) ? msg.mode : 'auto'
            autoHealthyTicks = 0
            reconcileDesktopQuality()
            sendViewerQos(viewer)
            return
          }
          if (!['pointer', 'key', 'clipboard', 'request-frame', 'input-reset'].includes(msg.type)) return
          desktopHost?.sendJson({ ...msg, viewer: wsAuthed.u })
        } catch { viewer.sendJson({ type: 'error', code: 'invalid-json' }) }
      },
      close(viewer) {
        if (viewer.keepalive) { try { clearInterval(viewer.keepalive) } catch {} }
        desktopViewers.delete(viewer)
        resetDesktopInput(wsAuthed.u)
        desktopHost?.sendJson({ type: 'viewers', count: desktopViewerCount() })
        reconcileDesktopQuality()
        reconcileDesktopVideoMode()
      },
    })
    logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: peer ? 101 : 400, u: wsAuthed.u })
    return
  }
  logRequest({ t: Date.now(), ip: clientIp(req), m: 'WS', p: wsPath, s: 101, u: wsAuthed.u })
  proxyWs(req, socket, head)
})

// RustDesk-style feedback loop for the browser/JPEG transport. Congestion
// causes an immediate one-step reduction; recovery requires several healthy
// intervals so quality does not oscillate around a latency boundary.
const desktopQosTimer = setInterval(() => {
  const autoViewers = [...desktopViewers].filter((viewer) => viewer.ackCapable && viewer.qualityMode === 'auto')
  const autoRtcViewers = desktopRtcHub?.autoSessions?.() || []
  if (autoViewers.length === 0 && autoRtcViewers.length === 0) return
  let congested = false
  let healthy = true
  const frameBudgetMs = 1000 / AUTO_LEVELS[autoLevel].fps
  if ((desktopInfo.encodeMs || 0) > frameBudgetMs * 0.8) congested = true
  if ((desktopInfo.encodeMs || 0) > frameBudgetMs * 0.6) healthy = false
  for (const viewer of autoViewers) {
    viewer.renderFps = viewer.ackedFrames
    viewer.ackedFrames = 0
    if (viewer.frameTimeouts > 0 || viewer.ackLatencyMs > 220 || viewer.decodeMs > 55) congested = true
    if (!viewer.ackLatencyMs || viewer.ackLatencyMs >= 120 || viewer.decodeMs >= 35 || viewer.frameTimeouts > 0) healthy = false
    viewer.frameTimeouts = 0
  }
  for (const viewer of autoRtcViewers) {
    viewer.renderFps = viewer.ackedFrames
    viewer.ackedFrames = 0
    if (viewer.frameTimeouts > 0 || viewer.ackLatencyMs > 220 || viewer.decodeMs > 55) congested = true
    if (!viewer.ackLatencyMs || viewer.ackLatencyMs >= 120 || viewer.decodeMs >= 35 || viewer.frameTimeouts > 0) healthy = false
    viewer.frameTimeouts = 0
  }
  if (congested && autoLevel > 0) {
    autoLevel -= 1
    autoHealthyTicks = 0
    lastDesktopTune = ''
    reconcileDesktopQuality()
  } else if (healthy && autoLevel < AUTO_LEVELS.length - 1) {
    autoHealthyTicks += 1
    if (autoHealthyTicks >= 5) {
      autoLevel += 1
      autoHealthyTicks = 0
      lastDesktopTune = ''
      reconcileDesktopQuality()
    }
  } else if (!healthy) {
    autoHealthyTicks = 0
  }
  for (const viewer of autoViewers) sendViewerQos(viewer)
  for (const viewer of autoRtcViewers) desktopRtcHub.sendQos(viewer, AUTO_LEVELS[autoLevel])
}, 1000)
desktopQosTimer.unref?.()

server.listen(cfg.bindPort, cfg.bindHost, () => {
  const scheme = isHttps ? 'https' : 'http'
  console.log('gateway ready ' + scheme + '://' + cfg.bindHost + ':' + cfg.bindPort + ' (upstream ' + upstream.authority + ')')
})

function shutdown() {
  clearInterval(desktopQosTimer)
  desktopRtcHub?.closeAll?.()
  if (logStream) { try { logStream.end() } catch { /* already closed */ } }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Orphan guard: when the parent (dsh) dies without running its cleanup (hard
// kill, crash), its PID changes (Linux) — exit instead of squatting on the
// port. The plugin's disposer covers the graceful path; this covers the rest.
const parentPid = Number(process.env.DSH_PLUGIN_REMOTE_PARENT_PID ?? process.env.DSH_H5_PARENT_PID ?? 0)
if (parentPid > 0) {
  const guard = setInterval(() => {
    if (process.ppid !== parentPid) {
      clearInterval(guard)
      console.error('parent process gone; exiting')
      process.exit(1)
    }
  }, 5000)
  guard.unref()
}

/**
 * dsh-plugin-remote — host half.
 *
 * Spawns and supervises the remote gateway: a Next.js application
 * (gateway/server.mjs) that is the PUBLIC entry point for the DeepSeek
 * Harness Web GUI. The gateway owns login authentication (scrypt credentials
 * + HttpOnly session cookie) and reverse-proxies every authenticated request
 * — HTTP and WebSocket — to the loopback `ctx.webServer` instance of DSH.
 *
 * Why a separate listener instead of reusing ctx.webServer:
 *   - DSH's own server deliberately binds 127.0.0.1 and refuses --host
 *     0.0.0.0; the /api trust fence has no middleware seam a plugin could
 *     claim (route collisions throw, a single fallback seat is owned by the
 *     SPA dist server).
 *   - So the gateway is its own node:http(s) server on 0.0.0.0 (or a
 *     configured host). It authenticates first, then forwards to DSH's
 *     loopback authority with Host rewritten to that authority and Origin /
 *     sec-fetch-site removed, which satisfies the /api browser-trust fence
 *     without any --trusted-host flag.
 *
 * The plugin needs zero runtime dependencies (Node builtins only); the
 * Next.js "weight" lives entirely inside gateway/.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'

/** Stable Cordis plugin id (matches cordis.patch.yml's insert row). */
const name = 'dsh-plugin-remote'

/** Gateway application directory relative to this package. */
const GATEWAY_DIR = fileURLToPath(new URL('../gateway', import.meta.url))

/** Defaults; every field is overridable through the row's `config` in a patch layer. */
const DEFAULTS = {
  enabled: true,
  host: '0.0.0.0',
  port: 4080,
  upstreamHost: '127.0.0.1',
  upstreamPort: null, // null => ctx.webServer.port (the real bound port)
  siteName: 'DSH Remote',
  siteHost: null, // optional host-gate: gateway 404s requests with a mismatched Host
  cookieName: 'dsh_plugin_remote_session',
  sessionTtlSec: 7 * 24 * 60 * 60,
  firstUserAutoCreate: true,
  // [{ username, password }] provisioned at gateway boot: creates missing
  // accounts and updates changed passwords (revoking old sessions). Plaintext
  // lives only in this config layer; users.json stores scrypt hashes.
  initialUsers: [],
  dev: false, // run next dev (skip build); for development only
  build: true, // allow the one-time `next build`
  dataDir: null, // null => $DSH_HOME/plugin-data/dsh-plugin-remote
  tlsCert: null, // optional PEM cert path => HTTPS listener with Secure cookies
  tlsKey: null,
  desktop: true,
  desktopHelperPath: null,
  // WebRTC ICE servers. Add a TURN server for clients behind symmetric NAT
  // or networks that block direct UDP; the desktop transport keeps the
  // WebSocket fallback when ICE cannot establish a path.
  rtcIceServers: ['stun:stun.l.google.com:19302'],
}

let child = null
let desktopHelper = null
let desktopGeneration = 0
let disposing = false
let restartAttempts = 0
let bannerShown = false // full guidance banner prints once per process run

/** Logger: always stdout (Cordis logger may be level-filtered or file-only). */
function makeLogger() {
  return {
    info: (...a) => console.log('[dsh-plugin-remote]', ...a),
    warn: (...a) => console.warn('[dsh-plugin-remote]', ...a),
    error: (...a) => console.error('[dsh-plugin-remote]', ...a),
  }
}

function resolveDataDir(ctx, configured) {
  if (configured) return configured
  // Default root mirrors DSH's own convention: $DSH_HOME or ~/.dsh. Never the
  // process cwd — a stray cwd would silently relocate the account store.
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'plugin-data', 'dsh-plugin-remote')
  // One-time migration of the account store from the pre-rename location
  // (dsh-plugin-h5). Keeps users.json + the session secret intact.
  const legacy = join(home, 'plugin-data', 'dsh-plugin-h5')
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir)
    } catch {
      return legacy // fall back to the legacy location if the move fails
    }
  }
  return dir
}

/** Run a command and resolve when it exits; rejects on nonzero exit. */
function run(cmd, args, cwd, log) {
  return new Promise((resolve, reject) => {
    log.info(`run: ${cmd} ${args.join(' ')}`)
    const p = spawn(cmd, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => process.stdout.write(`[gateway-boot] ${d}`))
    p.stderr.on('data', (d) => process.stderr.write(`[gateway-boot] ${d}`))
    p.on('error', reject)
    p.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code} (signal ${signal})`))
    })
  })
}

/** Make sure gateway dependencies exist; install once when missing. */
async function ensureDeps(log) {
  const required = ['next', 'node-datachannel']
  const missing = required.filter((name) => !existsSync(join(GATEWAY_DIR, 'node_modules', name)))
  if (missing.length > 0) {
    log.info(`gateway dependencies missing (${missing.join(', ')}) -> npm install`)
    try {
      await run('npm', ['install', '--no-audit', '--no-fund'], GATEWAY_DIR, log)
    } catch (error) {
      if (!existsSync(join(GATEWAY_DIR, 'node_modules', 'next'))) throw error
      log.warn(`optional WebRTC dependency unavailable; starting with WebSocket desktop fallback: ${error.message}`)
    }
  }
}

/** Make sure the production .next build exists and is newer than sources. */
function buildIsFresh() {
  const buildId = join(GATEWAY_DIR, '.next', 'BUILD_ID')
  if (!existsSync(buildId)) return false
  const buildTime = statSync(buildId).mtimeMs
  const watch = [join(GATEWAY_DIR, 'server.mjs'), join(GATEWAY_DIR, 'next.config.mjs')]
  const srcDir = join(GATEWAY_DIR, 'src')
  const stack = existsSync(srcDir) ? [srcDir] : []
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) stack.push(p)
      else if (st.mtimeMs > buildTime) watch.push(p)
    }
  }
  return !watch.some((p) => existsSync(p) && statSync(p).mtimeMs > buildTime)
}

async function ensureBuild(c, log) {
  if (c.dev || c.build === false) return
  if (buildIsFresh()) return
  log.info('gateway build missing or stale -> next build')
  await run('npm', ['run', 'build'], GATEWAY_DIR, log)
}

/** Poll the gateway's health endpoint until it answers. */
async function waitReady(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (disposing || child === null) throw new Error('gateway cancelled')
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/__health`, (r) => resolve(r))
        req.on('error', reject)
        req.setTimeout(1500, () => { req.destroy(new Error('timeout')) })
      })
      res.resume()
      if (res.statusCode === 200) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`gateway did not become ready within ${timeoutMs}ms`)
}

/** Spawn (or re-spawn) the gateway process. */
async function startGateway(ctx, c, log) {
  if (disposing) return
  const generation = ++desktopGeneration
  const ws = ctx.get?.('webServer')
  if (!ws || typeof ws.port !== 'number') {
    log.warn('webServer service unavailable; remote gateway not started')
    return
  }
  const upstreamPort = c.upstreamPort ?? ws.port

  await ensureDeps(log)
  await ensureBuild(c, log)
  if (disposing) return

  const desktopHostToken = randomBytes(32).toString('hex')
  const env = {
    ...process.env,
    NODE_ENV: c.dev ? 'development' : 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DSH_PLUGIN_REMOTE_BIND_HOST: c.host,
    DSH_PLUGIN_REMOTE_BIND_PORT: String(c.port),
    DSH_PLUGIN_REMOTE_UPSTREAM_HOST: c.upstreamHost,
    DSH_PLUGIN_REMOTE_UPSTREAM_PORT: String(upstreamPort),
    DSH_PLUGIN_REMOTE_SITE_NAME: c.siteName,
    DSH_PLUGIN_REMOTE_SITE_HOST: c.siteHost ?? '',
    DSH_PLUGIN_REMOTE_COOKIE_NAME: c.cookieName,
    DSH_PLUGIN_REMOTE_SESSION_TTL_SEC: String(c.sessionTtlSec),
    DSH_PLUGIN_REMOTE_FIRST_USER_AUTO_CREATE: String(c.firstUserAutoCreate),
    DSH_PLUGIN_REMOTE_INITIAL_USERS: JSON.stringify(c.initialUsers ?? []),
    DSH_PLUGIN_REMOTE_DATA_DIR: resolveDataDir(ctx, c.dataDir),
    DSH_PLUGIN_REMOTE_TLS_CERT: c.tlsCert ?? '',
    DSH_PLUGIN_REMOTE_TLS_KEY: c.tlsKey ?? '',
    DSH_PLUGIN_REMOTE_DEV: String(c.dev),
    DSH_PLUGIN_REMOTE_PARENT_PID: String(process.pid),
    DSH_PLUGIN_REMOTE_DESKTOP_HOST_TOKEN: desktopHostToken,
    DSH_PLUGIN_REMOTE_RTC_ICE_SERVERS: JSON.stringify(c.rtcIceServers ?? ['stun:stun.l.google.com:19302']),
  }
  mkdirSync(env.DSH_PLUGIN_REMOTE_DATA_DIR, { recursive: true })

  const gatewayProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: GATEWAY_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = gatewayProcess
  gatewayProcess.stdout.on('data', (d) => log.info(String(d).trimEnd()))
  gatewayProcess.stderr.on('data', (d) => log.warn(String(d).trimEnd()))
  gatewayProcess.on('error', (err) => {
    log.error(`gateway process error: ${err.message}`)
  })
  gatewayProcess.on('exit', (code, signal) => {
    if (child !== gatewayProcess) return
    child = null
    desktopGeneration += 1
    if (desktopHelper?._remoteGeneration === generation) {
      const helper = desktopHelper
      desktopHelper = null
      try { helper.kill('SIGTERM') } catch {}
    }
    if (disposing) {
      log.info('gateway stopped')
      return
    }
    // Windows reports a killed process as 4294967295 (unsigned -1).
    const shownCode = code === 4294967295 ? -1 : code
    log.warn(`gateway exited (code=${shownCode}, signal=${signal})`)
    const delay = Math.min(1000 * 2 ** restartAttempts, 30_000)
    restartAttempts += 1
    log.info(`gateway restart in ${delay}ms (attempt ${restartAttempts})`)
    setTimeout(() => {
      startGateway(ctx, c, log).catch((err) => log.error(`gateway restart failed: ${err.message}`))
    }, delay)
  })

  try {
    await waitReady(c.port)
    restartAttempts = 0
    // Print the full guidance banner only on the first successful start; on a
    // restart the gateway child itself logs "gateway ready …" — keep the log quiet.
    if (!bannerShown) {
      printReadyBanner(c, env, log)
      bannerShown = true
    }
    startDesktopHelper(c, env, desktopHostToken, log, generation)
  } catch (err) {
    log.error(`gateway failed to start: ${err.message}`)
    try { gatewayProcess.kill('SIGTERM') } catch {}
  }
}

function startDesktopHelper(c, env, token, log, generation) {
  if (!c.desktop || process.platform !== 'win32' || generation !== desktopGeneration) return
  if (desktopHelper) {
    if (desktopHelper._remoteGeneration === generation) return
    const stale = desktopHelper
    desktopHelper = null
    try { stale.kill('SIGTERM') } catch {}
  }
  const helperDir = join(dirname(GATEWAY_DIR), 'native', 'windows-x64')
  const legacyHelper = join(helperDir, 'dsh-remote-host.exe')
  const h264Helper = join(helperDir, 'dsh-remote-host-h264.exe')
  const helper = c.desktopHelperPath || (existsSync(h264Helper) ? h264Helper : legacyHelper)
  if (!existsSync(helper)) {
    log.warn(`desktop helper is not bundled yet: ${helper}`)
    return
  }
  const scheme = env.DSH_PLUGIN_REMOTE_TLS_CERT ? 'wss' : 'ws'
  const url = `${scheme}://127.0.0.1:${c.port}/__remote/desktop/host?token=${token}`
  const helperProcess = spawn(helper, ['--gateway', url], {
    cwd: dirname(helper),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  helperProcess._remoteGeneration = generation
  desktopHelper = helperProcess
  helperProcess.stdout.on('data', (d) => log.info(`[desktop] ${String(d).trimEnd()}`))
  helperProcess.stderr.on('data', (d) => log.warn(`[desktop] ${String(d).trimEnd()}`))
  helperProcess.on('error', (err) => log.error(`desktop helper error: ${err.message}`))
  helperProcess.on('exit', (code) => {
    if (desktopHelper === helperProcess) desktopHelper = null
    if (!disposing && child && generation === desktopGeneration) {
      log.warn(`desktop helper exited (code=${code}); restarting in 2s`)
      setTimeout(() => startDesktopHelper(c, env, token, log, generation), 2000).unref?.()
    }
  })
}

/** Post-install guidance so a user who just installed the plugin knows where
 * everything lives and how to manage accounts. Printed once per process run. */
function printReadyBanner(c, env, log) {
  const pluginRoot = dirname(GATEWAY_DIR)
  const scheme = env.DSH_PLUGIN_REMOTE_TLS_CERT ? 'https' : 'http'
  const base = scheme + '://' + (c.siteHost || '<server-ip>:' + c.port)
  const passwd = join(pluginRoot, 'lib', 'remote-passwd.mjs')
  log.info('')
  log.info('================================================================')
  log.info(' dsh-plugin-remote gateway is ready')
  log.info('')
  log.info('   URL (浏览器访问)      ' + base)
  log.info('   Login page (登录页)  ' + base + '/login')
  log.info('   Upstream (上游)      http://' + env.DSH_PLUGIN_REMOTE_UPSTREAM_HOST + ':' + env.DSH_PLUGIN_REMOTE_UPSTREAM_PORT)
  log.info('   Plugin dir (插件目录) ' + pluginRoot)
  log.info('   Account store (账号) ' + join(env.DSH_PLUGIN_REMOTE_DATA_DIR, 'users.json'))
  log.info('')
  log.info('   Manage accounts (管理账号):  node ' + passwd + ' add|set-password|list|del <username>')
  log.info('   First-visit (首次访问):      ' + (c.firstUserAutoCreate
    ? 'ON — the first visit creates the only account (首次访问创建账号)'
    : 'OFF — use remote-passwd.mjs add or initialUsers (用命令/配置创建账号)'))
  log.info('================================================================')
  log.info('')
}

/** Cordis plugin apply: start the gateway once the web server is listening. */
function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...(config ?? {}) }
  if (!c.enabled) return
  const log = makeLogger(ctx)

  // The loader service is not reliably resolvable at apply time across boot
  // orders, so poll for the webServer's bound port instead: the service
  // appears, and its .port becomes a number, only after it listens.
  const deadline = Date.now() + 120_000
  const tryStart = () => {
    if (disposing) return
    const ws = ctx.get?.('webServer')
    if (ws && typeof ws.port === 'number' && ws.port > 0) {
      log.info(`web server listening on port ${ws.port} -> starting gateway`)
      startGateway(ctx, c, log).catch((err) => {
        log.error(`remote gateway boot failed: ${err.message}`)
      })
      return
    }
    if (Date.now() > deadline) {
      log.warn('web server never became available; remote gateway not started')
      return
    }
    setTimeout(tryStart, 500)
  }
  tryStart()

  ctx.effect(() => async () => {
    disposing = true
    desktopGeneration += 1
    if (child) {
      const p = child
      child = null
      try { p.kill('SIGTERM') } catch {}
      setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 3000).unref?.()
    }
    if (desktopHelper) {
      const p = desktopHelper
      desktopHelper = null
      try { p.kill('SIGTERM') } catch {}
    }
  }, `${name}.gateway`)
}

export { DEFAULTS, GATEWAY_DIR, apply, name }

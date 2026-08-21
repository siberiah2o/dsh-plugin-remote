// dsh-plugin-remote — README screenshot capture.
// Drives a headless Edge via CDP through the real gateway origin:
//   login page → DSH GUI → session → 远程访问 tab (desktop) → settings section.
// Run:  node docs/capture.mjs   (env SHOT_USER / SHOT_PASS for credentials)
// Outputs into docs/: screenshot-login.png, screenshot-main.png,
// screenshot-desktop.png, screenshot-settings.png.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const GATEWAY = process.env.SHOT_GATEWAY || 'http://127.0.0.1:4080'
const USERNAME = process.env.SHOT_USER || 'shots-user@example.com'
const PASSWORD = process.env.SHOT_PASS || 'Shots-Pw-2026!'
const SESSION_TITLE = process.env.SHOT_SESSION || '远程窗口闪烁问题还是没有得'
const CDP_PORT = 8800 + Math.floor(Math.random() * 500)
const WIDTH = 1600
const HEIGHT = 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=' + WIDTH + ',' + HEIGHT, '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' })

async function getWsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('CDP endpoint never came up')
}
const ws = new WebSocket(await getWsUrl())
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const evaljs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r && r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value : r.exceptionDetails.text))
  return r ? r.result?.value : undefined
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(here, name)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('saved', name)
}
// Full pointer event chain — DSH buttons listen to pointer/mouse events,
// so a bare el.click() or CDP mouse dispatch is not enough.
const FIRE = '(function (el) { if (!el) return false; var opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: 10, clientY: 10 }; el.dispatchEvent(new PointerEvent("pointerdown", opts)); el.dispatchEvent(new MouseEvent("mousedown", opts)); el.dispatchEvent(new PointerEvent("pointerup", opts)); el.dispatchEvent(new MouseEvent("mouseup", opts)); el.dispatchEvent(new MouseEvent("click", opts)); return true })'
const clickTab = (text) => evaljs('(function () { var els = document.querySelectorAll("[role=tab]"); for (var i = 0; i < els.length; i++) { if ((els[i].textContent || "").trim() === ' + JSON.stringify(text) + ') { return ' + FIRE + '(els[i]) } } return false })()')
const clickByAria = (label) => evaljs('(function () { var els = document.querySelectorAll("button"); for (var i = 0; i < els.length; i++) { if ((els[i].getAttribute("aria-label") || "") === ' + JSON.stringify(label) + ') { return ' + FIRE + '(els[i]) } } return false })()')
const clickByText = (text) => evaljs('(function () { var all = document.querySelectorAll("*"); for (var i = 0; i < all.length; i++) { var el = all[i]; if (el.children.length === 0 && (el.textContent || "").trim() === ' + JSON.stringify(text) + ') { var c = el; for (var j = 0; j < 6 && c; j++) { if (c.getAttribute && (c.getAttribute("role") === "treeitem" || c.getAttribute("role") === "button")) { return ' + FIRE + '(c) } c = c.parentElement } return ' + FIRE + '(el) } } return false })()')

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

  // 1. login page (unauthenticated)
  await send('Page.navigate', { url: GATEWAY + '/login' })
  await sleep(5000)
  await shot('screenshot-login.png')

  // 2. log in (HttpOnly session cookie stays on the gateway origin)
  const login = await evaljs('(async () => { const r = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: ' + JSON.stringify(USERNAME) + ', password: ' + JSON.stringify(PASSWORD) + ' }) }); return r.status })()')
  console.log('login:', login)

  // 3. browse the GUI through the gateway — same origin as the desktop ws
  await send('Page.navigate', { url: GATEWAY + '/' })
  await sleep(15000)
  console.log('open session:', await clickByText(SESSION_TITLE))
  await sleep(6000)
  console.log('tabs:', await evaljs('Array.prototype.slice.call(document.querySelectorAll("[role=tab]")).map(function(t){return t.textContent.trim()})'))
  await shot('screenshot-main.png')

  // 4. remote access tab — wait for the first desktop frame
  console.log('remote tab:', await clickTab('远程访问'))
  for (let i = 0; i < 25; i++) {
    const st = await evaljs('(function () { var c = document.querySelector(".rp-desktop-stage canvas"); return JSON.stringify({ w: c ? c.width : 0, badge: (document.querySelector(".rp-desktop-badge") || {}).textContent || "" }) })()')
    console.log('  t+' + (i * 2) + 's', st)
    const p = JSON.parse(st)
    if (p.w > 0 && p.badge.indexOf('等待') === -1) break
    await sleep(2000)
  }
  await sleep(2000)
  await shot('screenshot-desktop.png')

  // 5. settings → 远程访问 section
  console.log('settings:', await clickByAria('设置'))
  await sleep(2000)
  console.log('remote section:', await clickByText('远程访问'))
  await sleep(2000)
  await shot('screenshot-settings.png')
  console.log('done')
} catch (e) {
  console.error('capture failed:', e.message)
  process.exitCode = 1
} finally {
  try { ws.close() } catch {}
  child.kill()
  await sleep(800)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
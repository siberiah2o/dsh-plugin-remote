#!/usr/bin/env node
/**
 * dsh-plugin-remote — account management CLI.
 *
 * Create / update / list / delete gateway accounts by editing the credential
 * store directly (scrypt-hashed, same format the gateway reads). Works with
 * the gateway running or stopped; changes apply immediately (users.json is
 * read per request). Updating a password bumps the session epoch, revoking
 * every previously issued session token.
 *
 * Usage:
 *   node lib/remote-passwd.mjs add <username> [--password <pw>]
 *   node lib/remote-passwd.mjs set-password <username> [--password <pw>]
 *   node lib/remote-passwd.mjs list
 *   node lib/remote-passwd.mjs del <username>
 *
 * Data dir: $DSH_PLUGIN_REMOTE_DATA_DIR (legacy alias $DSH_H5_DATA_DIR),
 * else $DSH_HOME/plugin-data/dsh-plugin-remote (same resolution as the plugin;
 * a pre-rename store under plugin-data/dsh-plugin-h5 is migrated once).
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

const DATA_DIR = (process.env.DSH_PLUGIN_REMOTE_DATA_DIR || process.env.DSH_H5_DATA_DIR)
  || (() => {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(home, 'plugin-data', 'dsh-plugin-remote')
    const legacy = join(home, 'plugin-data', 'dsh-plugin-h5')
    if (!existsSync(dir) && existsSync(legacy)) {
      try { renameSync(legacy, dir) } catch { /* fall back to the legacy location */ return legacy }
    }
    return dir
  })()
const USERS_PATH = join(DATA_DIR, 'users.json')

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
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = USERS_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(users, null, 2))
  renameSync(tmp, USERS_PATH)
}

async function hashPassword(password, salt) {
  const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return key.toString('hex')
}

function isValidUsername(u) {
  if (u.length < 3 || u.length > 254) return false
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(u)) return true
  return /^[a-z0-9._-]{3,32}$/.test(u)
}

/** Read a password without echoing (falls back to a plain prompt if raw mode fails). */
function hiddenPrompt(text) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    let raw = false
    try {
      stdin.setRawMode(true)
      raw = true
    } catch {
      /* not a TTY — fall through to visible prompt */
    }
    stdin.setEncoding('utf8')
    process.stdout.write(text)

    const cleanup = () => {
      stdin.off('data', onData)
      stdin.removeListener('error', onError)
      if (raw) {
        try { stdin.setRawMode(false) } catch { /* already closed */ }
      }
      stdin.pause()
    }
    const finish = (value) => {
      cleanup()
      process.stdout.write('\n')
      resolve(value)
    }
    const abort = (err) => {
      cleanup()
      process.stdout.write('\n')
      reject(err)
    }
    const onError = (err) => abort(err)

    // Raw-mode data events carry no `key` object — parse bytes directly:
    // \r/\n = Enter, \x7f/\b = Backspace, \x03 = Ctrl+C.
    let pw = ''
    let done = false
    const onData = (chunk) => {
      const s = String(chunk)
      for (const ch of s) {
        if (done) return
        if (ch === '\r' || ch === '\n') { done = true; finish(pw); return }
        if (ch === '\u007f' || ch === '\b') { pw = pw.slice(0, -1); continue }
        if (ch === '\x03') { done = true; abort(new Error('aborted')); return }
        pw += ch
      }
    }

    if (!raw) {
      stdin.on('data', onData)
      stdin.on('error', onError)
      // Piped/redirected input that ends before Enter: resolve with what we
      // have instead of hanging (callers validate length/matching).
      stdin.on('end', () => {
        if (!done) {
          done = true
          finish(pw)
        }
      })
      stdin.resume() // make sure piped/redirected input starts flowing
      return
    }
    stdin.on('data', onData)
    stdin.on('error', onError)
    stdin.resume() // critical: start the raw stream flowing immediately
  })
}

async function readPassword(flagValue, confirm = false) {
  if (flagValue) {
    if (flagValue.length < 8) throw new Error('password must be at least 8 characters')
    return flagValue
  }
  const pw = await hiddenPrompt('Password: ')
  if (pw.length < 8) throw new Error('password must be at least 8 characters')
  if (confirm) {
    const again = await hiddenPrompt('Confirm password: ')
    if (again !== pw) throw new Error('passwords do not match')
  }
  return pw
}

function parseArgs() {
  const args = process.argv.slice(2)
  let password
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--password') {
      password = args[i + 1]
      i++
    } else {
      rest.push(args[i])
    }
  }
  return { command: rest[0], username: (rest[1] || '').trim().toLowerCase(), password }
}

async function main() {
  const { command, username, password } = parseArgs()

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    console.log([
      'dsh-plugin-remote account manager',
      '',
      'Usage:',
      '  node lib/remote-passwd.mjs add <username> [--password <pw>]',
      '  node lib/remote-passwd.mjs set-password <username> [--password <pw>]',
      '  node lib/remote-passwd.mjs list',
      '  node lib/remote-passwd.mjs del <username>',
      '',
      'Data dir: ' + DATA_DIR,
    ].join('\n'))
    return
  }

  if (command === 'list') {
    const users = loadUsers()
    if (users.length === 0) {
      console.log('(no users)')
      return
    }
    for (const u of users) {
      console.log(u.username + '  created=' + new Date(u.created || 0).toISOString() + (u.disabled ? '  [disabled]' : ''))
    }
    return
  }

  if (!username || !isValidUsername(username)) {
    throw new Error('invalid username (3-32 chars a-z0-9._- or a valid email)')
  }

  if (command === 'add' || command === 'set-password') {
    const pw = await readPassword(password, command === 'add')
    const users = loadUsers()
    const existing = users.find((u) => u.username === username)
    if (command === 'add' && existing) throw new Error('user already exists (use set-password to update)')
    const salt = existing ? existing.salt : randomBytes(16).toString('hex')
    const hash = await hashPassword(pw, salt)
    if (existing) {
      existing.hash = hash
      // Changing credentials revokes all previously issued sessions.
      existing.sessionEpoch = (typeof existing.sessionEpoch === 'number' ? existing.sessionEpoch : 0) + 1
      console.log('updated password for ' + username + ' (existing sessions revoked)')
    } else {
      users.push({ username, salt, hash, created: Date.now() })
      console.log('created user ' + username)
    }
    saveUsers(users)
    return
  }

  if (command === 'del') {
    const users = loadUsers()
    const at = users.findIndex((u) => u.username === username)
    if (at === -1) throw new Error('user not found: ' + username)
    users.splice(at, 1)
    saveUsers(users)
    console.log('deleted user ' + username)
    return
  }

  throw new Error('unknown command: ' + command)
}

main().catch((err) => {
  console.error('error: ' + err.message)
  process.exit(1)
})

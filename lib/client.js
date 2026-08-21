// dsh-plugin-remote — client half. Two surfaces, both fully localized
// through the DSH locale service (zh/en):
//   1. a conversation view TAB (对话 / 轨迹 ring → 远程访问), and
//   2. a settings section (设置 → 远程访问 / Settings → Remote Access).
// Talks to the gateway's own /admin/* API (same-origin through the gateway;
// loopback fallback when the GUI is viewed directly at the DSH origin).
// Loaded by DSH's client-modules system because package.json declares
// dsh.client + exports["./client"].
window.__ModuleLoader__.load({
  id: "dsh-plugin-remote",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var { useState, useEffect, useCallback, useRef } = react
    var h = react.createElement

    // ── styles (DSW design tokens, matches the settings shell) ───────────────
    var css = [
      '.rp-root{display:flex;flex-direction:column;gap:12px}',
      '.rp-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px}',
      '.rp-title{margin:0 0 4px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.rp-desc{margin:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.rp-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.rp-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}',
      '.rp-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.rp-textarea{resize:vertical;min-height:84px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.rp-actions{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}',
      '.rp-actions-nowrap{flex-wrap:nowrap}',
      '.rp-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;font-family:inherit;cursor:pointer}',
      '.rp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rp-btn:disabled{opacity:.5;cursor:default}',
      '.rp-btn-ghost{background:transparent}',
      '.rp-btn-icon{display:inline-flex;align-items:center;justify-content:center;padding:6px;line-height:1}',
      '.rp-msg-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.rp-msg-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.rp-account{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 0}',
      '.rp-account:first-of-type{border-top:none}',
      '.rp-account-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:nowrap}',
      '.rp-account-name{font-size:13px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rp-account-form{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      '.rp-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.rp-table-wrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.rp-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.rp-table th,.rp-table td{text-align:left;padding:6px 10px;white-space:nowrap;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rp-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;background:var(--dsw-alias-bg-layer-1)}',
      '.rp-table tr:last-child td{border-bottom:none}',
      '.rp-path{max-width:280px;overflow:hidden;text-overflow:ellipsis}',
      '.rp-status-err{color:var(--dsw-alias-state-error-primary)}',
      '.rp-auth-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--dsw-alias-state-warn-tertiary);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:12px;padding:10px 14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.rp-auth-banner .rp-msg-err{margin:0}',
      '.rp-log-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}',
      '.rp-log-title{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.rp-log-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.rp-log-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.rp-log-label{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.rp-pager{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px;flex-wrap:wrap}',
      '.rp-pager-info{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.rp-pager-size{width:auto;padding:4px 8px;font-size:12px;height:auto;flex:none}',
      '.rp-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rp-pager .rp-btn:disabled{opacity:.4}',
      '.rp-toolbar-msg{margin-left:4px}',
      '.rp-desktop{padding:0;overflow:hidden}',
      '.rp-desktop-bare{display:flex;flex-direction:column;height:100%;border:0;border-radius:0;background:transparent}',
      '.rp-desktop-bare .rp-desktop-stage{flex:1;max-height:none}',
      '.rp-desktop-bare .rp-desktop-stage img{max-height:100%}',
      '.rp-desktop-bare .rp-desktop-stage video{max-height:100%}',
      '.rp-desktop-bare .rp-desktop-stage canvas{max-height:100%}',
      '.rp-desktop-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rp-desktop-stage{position:relative;display:flex;align-items:center;justify-content:center;min-height:260px;max-height:70vh;background:#111;outline:none;overflow:hidden;cursor:none}',
      // Keep both render surfaces in the same box. Switching codecs must not
      // change the flex layout or briefly collapse the stage.
      '.rp-desktop-stage img,.rp-desktop-stage video,.rp-desktop-stage canvas{position:absolute;inset:0;display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;pointer-events:none;user-select:none;-webkit-user-drag:none}',
      // JPEG is the bottom layer and stays fully opaque. The H.264 layer sits
      // on top and only fades in while the video element is actually
      // presenting frames. Both surfaces stay mounted for the whole session,
      // so a codec/transport handover can never collapse the stage or flash
      // it black; the 120ms fade hides the layer swap.
      '.rp-desktop-stage img,.rp-desktop-stage canvas{z-index:1}',
      '.rp-desktop-stage video{z-index:2;opacity:0;transition:opacity .12s linear}',
      '.rp-desktop-cursor{position:absolute;z-index:3;width:20px;height:26px;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8));transform:translate(-2px,-2px)}',
      '.rp-desktop-cursor path{fill:#fff;stroke:#111;stroke-width:1.2;stroke-linejoin:round}',
      '.rp-desktop-empty{padding:64px 20px;color:#aaa;text-align:center}',
      '.rp-desktop-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.rp-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}',
      '.rp-dot-on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.15)}',
      '.rp-quality{width:auto;min-width:116px}',
      '.rp-view{box-sizing:border-box;height:100%;overflow-y:auto;padding:16px 20px}',
      '.rp-view-desktop{overflow:hidden;padding:0}',
      // The host keeps its global composer mounted outside conversation.view.
      // Hide that sibling only while this remote view is the active/mounted
      // view; switching back to chat or trajectory restores it automatically.
      '[data-conversation-scroll]:has(.rp-view-desktop)>[data-composer-seat]{display:none}',
    ].join(String.fromCharCode(10))
    var cssTagId = 'dsh-plugin-remote/remote-access'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTagId + '"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-remote'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // i18n: dictionaries registered with the DSH locale service (zh/en).
    // The active locale follows the GUI language; t() resolves at render time.
    var NS = 'plugin.remoteAccess'
    var NL = String.fromCharCode(10)
    var dicts = {
      zh: {
        'nav': '远程访问',
        'whitelist.title': '远程访问白名单',
        'whitelist.desc': '留空即允许所有来源；支持 IP/CIDR（如 203.0.113.7、10.0.0.0/8）。',
        'whitelist.save': '保存白名单',
        'whitelist.saving': '保存中…',
        'whitelist.revert': '撤销修改',
        'whitelist.saved': '白名单已保存并生效',
        'whitelist.fail': '保存失败',
        'accounts.title': '账号与密码（新账号由 remote-passwd.mjs 创建）',
        'accounts.loading': '加载中…',
        'accounts.loadFail': '无法加载账号列表',
        'account.change': '修改密码',
        'account.collapse': '收起',
        'account.newPassword': '新密码（至少 8 位）',
        'account.confirmPassword': '再次输入新密码',
        'account.submit': '确认修改',
        'account.submitting': '修改中…',
        'account.tooShort': '密码至少 8 位',
        'account.mismatch': '两次输入的密码不一致',
        'account.changed': '密码已修改，该账号旧会话已全部失效',
        'account.fail': '修改失败',
        'logs.title': '来源请求记录',
        'logs.refresh': '刷新',
        'logs.download': '下载日志',
        'logs.prune': '清理旧分片:',
        'logs.prune1d': '删除 1 天前',
        'logs.prune3d': '删除 3 天前',
        'logs.prune7d': '删除 1 周前',
        'logs.confirmPrune': '删除 {label} 之前的日志分片？此操作不可恢复。',
        'logs.pruned': '已删除 {n} 个旧分片',
        'logs.pruneFail': '删除失败',
        'logs.loadFail': '无法加载访问记录',
        'logs.downloadFail': '下载失败',
        'logs.empty': '暂无记录',

        'logs.total': '共 {n} 条',
        'logs.perPage': '{n} 条/页',
        'logs.prev': '上一页',
        'logs.next': '下一页',
        'logs.page': '第 {cur} / {pages} 页',
        'logs.colTime': '时间',
        'logs.colIp': '来源 IP',
        'logs.colMethod': '方法',
        'logs.colPath': '路径',
        'logs.colStatus': '状态',
        'logs.colUser': '账号',
        'logs.colNote': '备注',
        'logs.blocked': '拦截',
        'auth.title': '未登录远程网关：请先在新标签页登录，再返回刷新。',
        'auth.login': '去网关登录',
        'desktop.title': 'Windows 远程桌面',
        'desktop.online': '已连接',
        'desktop.offline': '等待 Windows Helper',
        'desktop.focus': '点击画面后可使用键盘和鼠标',
        'desktop.auto': '自动（推荐）',
        'desktop.balanced': '平衡',
        'desktop.low': '流畅优先',
        'desktop.sharp': '文字清晰',
        'common.unreachable': '无法连接网关管理接口',
        'common.failed': '操作失败',
        'err.unauthorized': '未登录或会话已失效',
        'err.invalidBody': '请求格式错误',
        'err.invalidEntry': '包含无效条目，请使用 IP 或 CIDR（如 203.0.113.7、10.0.0.0/8）',
        'err.invalidUsername': '用户名无效',
        'err.passwordTooShort': '密码至少 8 位',
        'err.noSuchAccount': '账号不存在',
        'err.invalidKeepDays': '保留天数需为 1-365 的整数',
        'err.invalidShard': '分片格式无效',
        'err.notFound': '接口不存在',
        'err.rateLimited': '操作过于频繁，请稍后再试',
        'err.invalidCredentials': '用户名或密码错误',
      },
      en: {
        'nav': 'Remote Access',
        'whitelist.title': 'Remote access whitelist',
        'whitelist.desc': 'Empty = allow all; supports IP/CIDR (e.g. 203.0.113.7, 10.0.0.0/8).',
        'whitelist.save': 'Save whitelist',
        'whitelist.saving': 'Saving…',
        'whitelist.revert': 'Discard',
        'whitelist.saved': 'Whitelist saved and active',
        'whitelist.fail': 'Save failed',
        'accounts.title': 'Accounts (new accounts are created via remote-passwd.mjs)',
        'accounts.loading': 'Loading…',
        'accounts.loadFail': 'Failed to load accounts',
        'account.change': 'Change password',
        'account.collapse': 'Collapse',
        'account.newPassword': 'New password (min 8 chars)',
        'account.confirmPassword': 'Repeat new password',
        'account.submit': 'Change',
        'account.submitting': 'Changing…',
        'account.tooShort': 'Password must be at least 8 characters',
        'account.mismatch': 'Passwords do not match',
        'account.changed': 'Password changed; all old sessions of this account were revoked',
        'account.fail': 'Change failed',
        'logs.title': 'Request log',
        'logs.refresh': 'Refresh',
        'logs.download': 'Download',
        'logs.prune': 'Prune shards:',
        'logs.prune1d': 'Delete >1 day',
        'logs.prune3d': 'Delete >3 days',
        'logs.prune7d': 'Delete >1 week',
        'logs.confirmPrune': 'Delete log shards older than {label}? This cannot be undone.',
        'logs.pruned': 'Removed {n} old shard(s)',
        'logs.pruneFail': 'Prune failed',
        'logs.loadFail': 'Failed to load the request log',
        'logs.downloadFail': 'Download failed',
        'logs.empty': 'No records yet',

        'logs.total': '{n} total',
        'logs.perPage': '{n}/page',
        'logs.prev': 'Prev',
        'logs.next': 'Next',
        'logs.page': 'Page {cur} / {pages}',
        'logs.colTime': 'Time',
        'logs.colIp': 'Source IP',
        'logs.colMethod': 'Method',
        'logs.colPath': 'Path',
        'logs.colStatus': 'Status',
        'logs.colUser': 'User',
        'logs.colNote': 'Note',
        'logs.blocked': 'blocked',
        'auth.title': 'Not logged in to the gateway: log in in a new tab, then refresh.',
        'auth.login': 'Go to gateway login',
        'desktop.title': 'Windows desktop',
        'desktop.online': 'Connected',
        'desktop.offline': 'Waiting for the Windows helper',
        'desktop.focus': 'Click the desktop to enable keyboard and pointer control',
        'desktop.auto': 'Auto (recommended)',
        'desktop.balanced': 'Balanced',
        'desktop.low': 'Prioritize speed',
        'desktop.sharp': 'Sharp text',
        'common.unreachable': 'Cannot reach the gateway API',
        'common.failed': 'Operation failed',
        'err.unauthorized': 'Not logged in, or the session expired',
        'err.invalidBody': 'Invalid request body',
        'err.invalidEntry': 'Contains an invalid entry — use an IP or CIDR (e.g. 203.0.113.7, 10.0.0.0/8)',
        'err.invalidUsername': 'Invalid username',
        'err.passwordTooShort': 'Password must be at least 8 characters',
        'err.noSuchAccount': 'No such account',
        'err.invalidKeepDays': 'keepDays must be an integer between 1 and 365',
        'err.invalidShard': 'Invalid shard',
        'err.notFound': 'Endpoint not found',
        'err.rateLimited': 'Too many attempts, try again later',
        'err.invalidCredentials': 'Invalid username or password',
      },
    }
    var t = function (key, params) { return key }
    // Localize an API error: prefer the machine-readable code, else raw message.
    function errText(res) {
      if (!res || !res.body) return t('common.unreachable')
      if (res.body.code) {
        var key = 'err.' + res.body.code
        var localized = t(key)
        if (localized !== key) return localized
      }
      return res.body.error || t('common.failed')
    }

    // gateway admin API: same-origin, loopback fallback
    var apiBase = ''
    function gatewayFetch(path, opts) {
      var bases = apiBase !== '' ? [apiBase] : ['', 'http://127.0.0.1:4080']
      function attempt(i) {
        if (i >= bases.length) return Promise.resolve(null)
        var base = bases[i]
        var init = { credentials: 'include', method: (opts && opts.method) || 'GET' }
        if (opts && opts.body !== undefined) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(opts.body)
        }
        return fetch(base + path, init)
          .then(function (r) {
            return r.json()
              .then(function (d) {
                if (d && typeof d === 'object' && 'ok' in d) {
                  apiBase = base
                  return { status: r.status, body: d }
                }
                return attempt(i + 1) // served the SPA shell, not the gateway
              })
              .catch(function () { return attempt(i + 1) })
          })
          .catch(function () { return attempt(i + 1) })
      }
      return attempt(0)
    }
    // Raw fetch (blob) for downloads - same base resolution as gatewayFetch.
    function gatewayDownload(path) {
      var bases = apiBase !== '' ? [apiBase] : ['', 'http://127.0.0.1:4080']
      function attempt(i) {
        if (i >= bases.length) return Promise.resolve(null)
        var base = bases[i]
        return fetch(base + path, { credentials: 'include' })
          .then(function (r) {
            if (!r.ok) { apiBase = base; return { status: r.status } }
            apiBase = base
            return r.blob().then(function (blob) { return { status: r.status, blob: blob } })
          })
          .catch(function () { return attempt(i + 1) })
      }
      return attempt(0)
    }

    // ---- whitelist card ----
    function WhitelistCard({ onUnauthorized }) {
      var [entries, setEntries] = useState([])
      var [text, setText] = useState('')
      var [busy, setBusy] = useState(false)
      var [msg, setMsg] = useState(null)
      useEffect(function () {
        var cancelled = false
        gatewayFetch('/admin/whitelist').then(function (res) {
          if (cancelled || !res) return
          if (res.status === 401) { onUnauthorized(); return }
          if (!res.body.ok) return
          setEntries(res.body.entries || [])
          setText((res.body.entries || []).join(NL))
        })
        return function () { cancelled = true }
      }, [])
      var save = function () {
        var list = text.split(NL).map(function (s) { return s.trim() }).filter(Boolean)
        setBusy(true)
        setMsg(null)
        gatewayFetch('/admin/whitelist', { method: 'PUT', body: { entries: list } }).then(function (res) {
          setBusy(false)
          if (!res) { setMsg({ kind: 'err', text: t('common.unreachable') }); return }
          if (res.status === 401) { onUnauthorized(); return }
          if (res.status === 200 && res.body.ok) {
            setEntries(res.body.entries || [])
            setText((res.body.entries || []).join(NL))
            setMsg({ kind: 'ok', text: t('whitelist.saved') })
          } else {
            setMsg({ kind: 'err', text: errText(res) })
          }
        })
      }
      var iconSvg = function (children) {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', overflow: 'visible' }, children)
      }
      var IconSave = function () { return iconSvg([h('path', { d: 'M20 6L9 17l-5-5' })]) }
      var IconRevert = function () { return iconSvg([h('polyline', { points: '1 4 1 10 7 10' }), h('path', { d: 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10' })]) }
      var reset = function () { setText(entries.join(NL)); setMsg(null) }
      return h('div', { className: 'rp-card' },
        h('h3', { className: 'rp-title' }, t('whitelist.title')),
        h('textarea', {
          className: 'rp-input rp-textarea',
          value: text,
          onChange: function (ev) { setText(ev.target.value) },
          placeholder: '203.0.113.7' + NL + '10.0.0.0/8',
          rows: 4,
          spellCheck: false,
        }),
        h('div', { className: 'rp-actions rp-actions-nowrap' },
          h('button', { className: 'rp-btn rp-btn-icon', onClick: save, disabled: busy, title: busy ? t('whitelist.saving') : t('whitelist.save'), 'aria-label': t('whitelist.save') }, IconSave()),
          h('button', { className: 'rp-btn rp-btn-ghost rp-btn-icon', onClick: reset, disabled: busy, title: t('whitelist.revert'), 'aria-label': t('whitelist.revert') }, IconRevert()),
          h('span', { className: 'rp-hint' }, t('whitelist.desc')),
          msg && h('span', { className: msg.kind === 'ok' ? 'rp-msg-ok' : 'rp-msg-err' }, msg.text)
        )
      )
    }

    // ---- accounts card ----
    function AccountRow({ user, onUnauthorized }) {
      var [open, setOpen] = useState(false)
      var [p1, setP1] = useState('')
      var [p2, setP2] = useState('')
      var [busy, setBusy] = useState(false)
      var [msg, setMsg] = useState(null)
      var submit = function () {
        setMsg(null)
        if (p1.length < 8) { setMsg({ kind: 'err', text: t('account.tooShort') }); return }
        if (p1 !== p2) { setMsg({ kind: 'err', text: t('account.mismatch') }); return }
        setBusy(true)
        gatewayFetch('/admin/password', { method: 'POST', body: { username: user.username, password: p1 } }).then(function (res) {
          setBusy(false)
          if (!res) { setMsg({ kind: 'err', text: t('common.unreachable') }); return }
          if (res.status === 401) { onUnauthorized(); return }
          if (res.status === 200 && res.body.ok) {
            setMsg({ kind: 'ok', text: t('account.changed') })
            setP1('')
            setP2('')
          } else {
            setMsg({ kind: 'err', text: errText(res) })
          }
        })
      }
      return h('div', { className: 'rp-account' },
        h('div', { className: 'rp-account-head' },
          h('span', { className: 'rp-account-name', title: user.username }, user.username),
          h('button', {
            className: 'rp-btn rp-btn-ghost',
            onClick: function () { setOpen(!open) },
          }, open ? t('account.collapse') : t('account.change'))
        ),
        open && h('div', { className: 'rp-account-form' },
          h('input', {
            className: 'rp-input',
            type: 'password',
            placeholder: t('account.newPassword'),
            value: p1,
            onChange: function (e) { setP1(e.target.value) },
          }),
          h('input', {
            className: 'rp-input',
            type: 'password',
            placeholder: t('account.confirmPassword'),
            value: p2,
            onChange: function (e) { setP2(e.target.value) },
          }),
          h('div', { className: 'rp-actions' },
            h('button', { className: 'rp-btn', onClick: submit, disabled: busy }, busy ? t('account.submitting') : t('account.submit')),
            msg && h('span', { className: msg.kind === 'ok' ? 'rp-msg-ok' : 'rp-msg-err' }, msg.text)
          )
        )
      )
    }
    function AccountsCard({ onUnauthorized }) {
      var [users, setUsers] = useState([])
      var [msg, setMsg] = useState(null)
      useEffect(function () {
        var cancelled = false
        gatewayFetch('/admin/accounts').then(function (res) {
          if (cancelled) return
          if (!res) { setMsg({ kind: 'err', text: t('accounts.loadFail') }); return }
          if (res.status === 401) { onUnauthorized(); return }
          if (res.body.ok) setUsers(res.body.users || [])
          else setMsg({ kind: 'err', text: errText(res) })
        })
        return function () { cancelled = true }
      }, [])
      return h('div', { className: 'rp-card' },
        h('h3', { className: 'rp-title' }, t('accounts.title')),
        users.length === 0 && !msg && h('p', { className: 'rp-desc' }, t('accounts.loading')),
        h('div', {}, users.map(function (u) {
          return h(AccountRow, { key: u.username, user: u, onUnauthorized: onUnauthorized })
        })),
        msg && h('p', { className: 'rp-msg-err' }, msg.text)
      )
    }

    // ---- request log card ----
    function LogsCard({ onUnauthorized }) {
      var [logs, setLogs] = useState([])
      var [shards, setShards] = useState([])
      var [err, setErr] = useState(null)
      var [msg, setMsg] = useState(null)
      var [page, setPage] = useState(0)
      var [pageSize, setPageSize] = useState(5)
      var load = useCallback(function () {
        gatewayFetch('/admin/logs?limit=1000').then(function (res) {
          if (!res) { setErr(t('logs.loadFail')); return }
          if (res.status === 401) { onUnauthorized(); return }
          if (res.body.ok) { setLogs(res.body.logs || []); setShards(res.body.shards || []); setErr(null) }
          else setErr(errText(res))
        })
      }, [])
      useEffect(function () {
        load()
        var timer = setInterval(load, 5000)
        return function () { clearInterval(timer) }
      }, [load])
      var download = function () {
        setErr(null)
        setMsg(null)
        gatewayDownload('/admin/logs/download').then(function (res) {
          if (!res || !res.blob) { setErr(t('logs.downloadFail')); return }
          var url = URL.createObjectURL(res.blob)
          var a = document.createElement('a')
          a.href = url
          a.download = 'gateway-logs-' + new Date().toISOString().slice(0, 10) + '.jsonl'
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(function () { URL.revokeObjectURL(url) }, 30000)
        })
      }
      var prune = function (keepDays, label) {
        if (!window.confirm(t('logs.confirmPrune', { label: label }))) return
        setErr(null)
        setMsg(null)
        gatewayFetch('/admin/logs/prune', { method: 'POST', body: { keepDays: keepDays } }).then(function (res) {
          if (!res) { setErr(t('logs.pruneFail')); return }
          if (res.status === 401) { onUnauthorized(); return }
          if (res.body.ok) {
            setMsg({ kind: 'ok', text: t('logs.pruned', { n: String((res.body.removed || []).length) }) })
            load()
          } else {
            setMsg({ kind: 'err', text: errText(res) })
          }
        })
      }
      var fmt = function (t) {
        var d = new Date(t)
        var p = function (n) { return String(n).padStart(2, '0') }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
          ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      }
      var pages = Math.max(1, Math.ceil(logs.length / pageSize))
      var cur = Math.min(page, pages - 1)
      var rows = logs.slice(cur * pageSize, (cur + 1) * pageSize)
      var changeSize = function (n) { setPageSize(n); setPage(0) }
      return h('div', { className: 'rp-card' },
        h('div', { className: 'rp-log-head' },
          h('div', { className: 'rp-log-title' },
            h('h3', { className: 'rp-title' }, t('logs.title'))
          ),
          h('div', { className: 'rp-actions', style: { marginTop: 0 } },
            h('button', { className: 'rp-btn rp-btn-ghost', onClick: load }, t('logs.refresh')),
            h('button', { className: 'rp-btn rp-btn-ghost', onClick: download }, t('logs.download'))
          )
        ),
        h('div', { className: 'rp-log-toolbar' },
          h('span', { className: 'rp-log-label' }, t('logs.prune')),
          h('button', { className: 'rp-btn rp-btn-ghost', onClick: function () { prune(1, t('logs.prune1d')) } }, t('logs.prune1d')),
          h('button', { className: 'rp-btn rp-btn-ghost', onClick: function () { prune(3, t('logs.prune3d')) } }, t('logs.prune3d')),
          h('button', { className: 'rp-btn rp-btn-ghost', onClick: function () { prune(7, t('logs.prune7d')) } }, t('logs.prune7d')),
          msg && h('span', { className: msg.kind === 'ok' ? 'rp-msg-ok' : 'rp-msg-err' }, msg.text)
        ),
        err && h('p', { className: 'rp-msg-err' }, err),
        rows.length === 0 && !err && h('p', { className: 'rp-desc' }, t('logs.empty')),
        rows.length > 0 && h('div', { className: 'rp-table-wrap' },
          h('table', { className: 'rp-table' },
            h('thead', {}, h('tr', {},
              h('th', {}, t('logs.colTime')),
              h('th', {}, t('logs.colIp')),
              h('th', {}, t('logs.colMethod')),
              h('th', {}, t('logs.colPath')),
              h('th', {}, t('logs.colStatus')),
              h('th', {}, t('logs.colUser')),
              h('th', {}, t('logs.colNote'))
            )),
            h('tbody', {}, rows.map(function (e, i) {
              return h('tr', { key: i },
                h('td', {}, fmt(e.t)),
                h('td', {}, e.ip),
                h('td', {}, e.m),
                h('td', { className: 'rp-path', title: e.p }, e.p),
                h('td', { className: e.s >= 400 ? 'rp-status-err' : '' }, String(e.s) + (e.denied ? ' ' + t('logs.blocked') : '')),
                h('td', {}, e.u || '—'),
                h('td', {}, e.note || '')
              )
            }))
          )
        ),
        logs.length > 0 && h('div', { className: 'rp-pager' },
          h('span', { className: 'rp-pager-info' }, t('logs.total', { n: String(logs.length) })),
          h('select', {
            className: 'rp-input rp-pager-size',
            value: String(pageSize),
            onChange: function (e) { changeSize(Number(e.target.value)) },
          },
            h('option', { value: '5' }, t('logs.perPage', { n: '5' })),
            h('option', { value: '20' }, t('logs.perPage', { n: '20' })),
            h('option', { value: '50' }, t('logs.perPage', { n: '50' })),
            h('option', { value: '100' }, t('logs.perPage', { n: '100' }))
          ),
          h('button', {
            className: 'rp-btn rp-btn-ghost',
            disabled: cur === 0,
            onClick: function () { setPage(cur - 1) },
          }, t('logs.prev')),
          h('span', { className: 'rp-pager-info' }, t('logs.page', { cur: String(cur + 1), pages: String(pages) })),
          h('button', {
            className: 'rp-btn rp-btn-ghost',
            disabled: cur >= pages - 1,
            onClick: function () { setPage(cur + 1) },
          }, t('logs.next'))
        )
      )
    }

    function LegacyDesktopCard({ onUnauthorized, bare }) {
      var [online, setOnline] = useState(false)
      var [hasFrame, setHasFrame] = useState(false)
      var [imageUrl, setImageUrl] = useState('')
      var [info, setInfo] = useState({})
      var [quality, setQuality] = useState('auto')
      var [qos, setQos] = useState({})
      var socketRef = useRef(null)
      var imageRef = useRef(null)
      var stageRef = useRef(null)
      var retryRef = useRef(null)
      var lastPointerAt = useRef(0)
      var pressedKeysRef = useRef({})
      var pressedButtonsRef = useRef({})
      var lastPointRef = useRef({ x: 0.5, y: 0.5 })
      var qualityRef = useRef(quality)
      var retryMsRef = useRef(1500)
      useEffect(function () { qualityRef.current = quality }, [quality])

      var send = useCallback(function (msg) {
        var ws = socketRef.current
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      }, [])

      var releasePressedKeys = useCallback(function () {
        var pressed = pressedKeysRef.current
        Object.keys(pressed).forEach(function (code) {
          send({ type: 'key', action: 'up', code: code, key: pressed[code] })
        })
        pressedKeysRef.current = {}
      }, [send])

      var releasePressedButtons = useCallback(function () {
        var pressed = pressedButtonsRef.current
        var point = lastPointRef.current
        Object.keys(pressed).forEach(function (button) {
          send({ type: 'pointer', action: 'up', x: point.x, y: point.y, button: Number(button), buttons: 0 })
        })
        pressedButtonsRef.current = {}
      }, [send])

      var releaseInputState = useCallback(function () {
        releasePressedKeys()
        releasePressedButtons()
      }, [releasePressedKeys, releasePressedButtons])

      useEffect(function () {
        var disposed = false
        var pendingFrame = null
        var pendingMeta = null
        var decodingFrame = false
        var currentUrl = ''
        function decodeLatestFrame() {
          if (disposed || decodingFrame || !pendingFrame) return
          var frame = pendingFrame
          pendingFrame = null
          decodingFrame = true
          var decodeStarted = performance.now()
          var url = URL.createObjectURL(new Blob([frame.data], { type: 'image/jpeg' }))
          var image = new Image()
          var finish = function (ok) {
            if (frame.meta && frame.meta.seq !== undefined && ok && !disposed) {
              // ACK only after the browser accepted the JPEG and the URL was
              // installed. A failed decode must apply backpressure instead of
              // telling the gateway that a black frame was painted.
              send({ type: 'frame-ack', seq: frame.meta.seq, decodeMs: Math.round(performance.now() - decodeStarted) })
            }
            decodingFrame = false
            decodeLatestFrame()
          }
          image.onload = function () {
            if (disposed) { URL.revokeObjectURL(url); finish(false); return }
            var previous = currentUrl
            currentUrl = url
            setImageUrl(url)
            setHasFrame(true)
            setOnline(true)
            // React commits imageUrl on the next render. Retire the previous
            // URL after that commit so the visible <img> never points at a
            // revoked object while the new frame is being installed.
            if (previous) setTimeout(function () { URL.revokeObjectURL(previous) }, 1000)
            finish(true)
          }
          image.onerror = function () {
            URL.revokeObjectURL(url)
            finish(false)
          }
          image.src = url
        }
        function queueFrame(data, meta) {
          // Keep only the newest frame while the previous JPEG is decoding.
          pendingFrame = { data: data, meta: meta }
          decodeLatestFrame()
        }
        function connect() {
          if (disposed) return
          var base = apiBase || window.location.origin
          var u = new URL(base, window.location.href)
          u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
          u.pathname = '/__remote/desktop/view'
          u.search = ''
          var ws = new WebSocket(u.toString())
          ws.binaryType = 'arraybuffer'
          socketRef.current = ws
          ws.onopen = function () {
            retryMsRef.current = 1500
            send({ type: 'viewer-ready', protocol: 2 })
            send({ type: 'quality', mode: qualityRef.current })
            send({ type: 'request-frame' })
          }
          ws.onmessage = function (event) {
            if (typeof event.data === 'string') {
              try {
                var msg = JSON.parse(event.data)
                if (msg.type === 'status') {
                  setOnline(Boolean(msg.desktop && msg.desktop.online))
                  setInfo(msg.desktop || {})
                } else if (msg.type === 'frame-meta') {
                  pendingMeta = msg
                } else if (msg.type === 'qos') {
                  setQos(msg)
                }
              } catch {}
              return
            }
            queueFrame(event.data, pendingMeta)
            pendingMeta = null
          }
          ws.onclose = function (event) {
            if (socketRef.current === ws) socketRef.current = null
            setOnline(false)
            if (event.code === 1008 || event.code === 4401) onUnauthorized()
            if (!disposed) {
              retryRef.current = setTimeout(connect, retryMsRef.current)
              retryMsRef.current = Math.min(30_000, Math.round(retryMsRef.current * 2))
            }
          }
        }
        // Resolve the gateway origin first. This keeps the desktop available
        // when the DSH UI itself is opened directly on its loopback port.
        gatewayFetch('/admin/desktop/status').then(function (res) {
          if (disposed) return
          if (res && res.status === 401) onUnauthorized()
          connect()
        })
        return function () {
          disposed = true
          if (retryRef.current) clearTimeout(retryRef.current)
          if (socketRef.current) socketRef.current.close()
          pendingFrame = null
          if (currentUrl) URL.revokeObjectURL(currentUrl)
        }
      }, [])

      useEffect(function () {
        function releaseWhenHidden() {
          if (document.hidden) releaseInputState()
        }
        window.addEventListener('blur', releaseInputState)
        document.addEventListener('visibilitychange', releaseWhenHidden)
        return function () {
          releaseInputState()
          window.removeEventListener('blur', releaseInputState)
          document.removeEventListener('visibilitychange', releaseWhenHidden)
        }
      }, [releaseInputState])

      useEffect(function () {
        function releaseButton(event) {
          var button = event.button
          if (pressedButtonsRef.current[button] === undefined) return
          var point = lastPointRef.current
          send({ type: 'pointer', action: 'up', x: point.x, y: point.y, button: button, buttons: 0 })
          delete pressedButtonsRef.current[button]
        }
        window.addEventListener('mouseup', releaseButton)
        return function () {
          window.removeEventListener('mouseup', releaseButton)
        }
      }, [send, releaseInputState])

      useEffect(function () {
        var stage = stageRef.current
        if (!stage) return
        function handleWheel(event) {
          send({ type: 'pointer', action: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY })
          event.preventDefault()
        }
        stage.addEventListener('wheel', handleWheel, { passive: false })
        return function () { stage.removeEventListener('wheel', handleWheel) }
      }, [send])

      var point = function (event) {
        var image = imageRef.current
        var video = videoRef.current
        var stage = stageRef.current
        var target = videoActive && video && video.videoWidth ? video : image && image.naturalWidth ? image : stage
        if (!target) return null
        var r = target.getBoundingClientRect()
        if (!r.width || !r.height) return null
        var sourceWidth = videoActive && video && video.videoWidth ? video.videoWidth : image && image.naturalWidth ? image.naturalWidth : Number(info.width) || 1280
        var sourceHeight = videoActive && video && video.videoHeight ? video.videoHeight : image && image.naturalHeight ? image.naturalHeight : Number(info.height) || 720
        // Map against the actual contain rectangle. If the first frame has not
        // arrived yet, use the advertised desktop dimensions so mouse input is
        // still delivered instead of being silently dropped on a black stage.
        var scale = Math.min(r.width / sourceWidth, r.height / sourceHeight)
        var width = sourceWidth * scale
        var height = sourceHeight * scale
        var left = r.left + (r.width - width) / 2
        var top = r.top + (r.height - height) / 2
        return {
          x: Math.max(0, Math.min(1, (event.clientX - left) / width)),
          y: Math.max(0, Math.min(1, (event.clientY - top) / height)),
        }
      }
      var pointer = function (action, event) {
        if (action === 'move') {
          var now = performance.now()
          if (now - lastPointerAt.current < 33) return
          lastPointerAt.current = now
        }
        var p = point(event)
        if (!p) return
        lastPointRef.current = p
        if (action === 'down') pressedButtonsRef.current[event.button] = true
        if (action === 'up') delete pressedButtonsRef.current[event.button]
        send({ type: 'pointer', action: action, x: p.x, y: p.y, button: event.button, buttons: event.buttons })
      }
      var selectQuality = function (mode) {
        setQuality(mode)
        send({ type: 'quality', mode: mode })
      }
      return h('div', { className: (bare ? 'rp-desktop rp-desktop-bare' : 'rp-card rp-desktop') },
        h('div', { className: 'rp-desktop-head' },
          h('div', {},
            h('h3', { className: 'rp-title' }, t('desktop.title')),
            h('span', { className: 'rp-desktop-badge' },
              h('span', { className: 'rp-dot' + (online ? ' rp-dot-on' : '') }),
              online ? t('desktop.online') + (info.width ? ' · ' + info.width + '×' + info.height + ' · ' + (qos.renderFps || info.fps || 0) + ' fps' + (qos.latencyMs ? ' · ' + qos.latencyMs + ' ms' : '') : '') : t('desktop.offline')
            )
          ),
          h('select', {
            className: 'rp-input rp-quality', value: quality,
            onChange: function (e) { selectQuality(e.target.value) },
          },
            h('option', { value: 'auto' }, t('desktop.auto')),
            h('option', { value: 'low' }, t('desktop.low')),
            h('option', { value: 'balanced' }, t('desktop.balanced')),
            h('option', { value: 'sharp' }, t('desktop.sharp'))
          )
        ),
        h('div', {
          ref: stageRef, className: 'rp-desktop-stage', tabIndex: 0, title: t('desktop.focus'),
          onMouseMove: function (e) { pointer('move', e) },
          onMouseDown: function (e) { e.currentTarget.focus(); pointer('down', e); e.preventDefault() },
          onMouseUp: function (e) { pointer('up', e); e.preventDefault() },
          onBlur: releaseInputState,
          onContextMenu: function (e) { e.preventDefault() },
          onKeyDown: function (e) { pressedKeysRef.current[e.code] = e.key; send({ type: 'key', action: 'down', code: e.code, key: e.key, repeat: e.repeat }); e.preventDefault() },
          onKeyUp: function (e) { delete pressedKeysRef.current[e.code]; send({ type: 'key', action: 'up', code: e.code, key: e.key }); e.preventDefault() },
        },
          imageUrl
            ? h('img', { ref: imageRef, src: imageUrl, alt: t('desktop.title'), draggable: false })
            : null,
          !hasFrame && h('div', { className: 'rp-desktop-empty' }, t('desktop.offline'))
        )
      )
    }

    function DesktopCard({ onUnauthorized, bare }) {
      var [online, setOnline] = useState(false)
      var [hasFrame, setHasFrame] = useState(false)
      var [info, setInfo] = useState({})
      var [quality, setQuality] = useState('auto')
      var [qos, setQos] = useState({})
      var [cursor, setCursor] = useState({ x: 0, y: 0, visible: false })
      var [videoActive, setVideoActive] = useState(false)
      var socketRef = useRef(null)
      var signalRef = useRef(null)
      var rtcPcRef = useRef(null)
      var rtcControlRef = useRef(null)
      var rtcPointerRef = useRef(null)
      var rtcFramesRef = useRef(null)
      var videoRef = useRef(null)
      var canvasRef = useRef(null)
      var stageRef = useRef(null)
      var videoStateRef = useRef(false)
      var videoWatchdogRef = useRef(null)
      var videoStallRef = useRef(null)
      var transportRef = useRef('connecting')
      var retryRef = useRef(null)
      var rtcFallbackRef = useRef(null)
      var rtcDropRef = useRef(null)
      var lastPointerAt = useRef(0)
      var pressedKeysRef = useRef({})
      var pressedButtonsRef = useRef({})
      var lastPointRef = useRef({ x: 0.5, y: 0.5 })
      var qualityRef = useRef(quality)
      var retryMsRef = useRef(1500)
      useEffect(function () { qualityRef.current = quality }, [quality])

      var sendRtc = useCallback(function (msg, channelName) {
        var channel = channelName === 'pointer' ? rtcPointerRef.current : rtcControlRef.current
        if (!channel || channel.readyState !== 'open') return false
        // Mouse motion and wheel events are disposable. If SCTP has queued
        // too much, drop this update so it cannot delay a later click/key.
        if (channelName === 'pointer' && Number(channel.bufferedAmount || 0) > 64 * 1024) return false
        try {
          channel.send(JSON.stringify(msg))
          return true
        } catch {
          return false
        }
      }, [])

      var send = useCallback(function (msg) {
        var pointerChannel = msg && msg.type === 'pointer' && (msg.action === 'move' || msg.action === 'wheel')
        if (sendRtc(msg, pointerChannel ? 'pointer' : 'control')) return true
        var ws = socketRef.current
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify(msg)); return true } catch {}
        }
        return false
      }, [sendRtc])

      var releasePressedKeys = useCallback(function () {
        var pressed = pressedKeysRef.current
        Object.keys(pressed).forEach(function (code) {
          send({ type: 'key', action: 'up', code: code, key: pressed[code] })
        })
        pressedKeysRef.current = {}
      }, [send])

      var releasePressedButtons = useCallback(function () {
        var pressed = pressedButtonsRef.current
        var point = lastPointRef.current
        Object.keys(pressed).forEach(function (button) {
          send({ type: 'pointer', action: 'up', x: point.x, y: point.y, button: Number(button), buttons: 0 })
        })
        pressedButtonsRef.current = {}
      }, [send])

      var releaseInputState = useCallback(function () {
        releasePressedKeys()
        releasePressedButtons()
        send({ type: 'input-reset' })
      }, [releasePressedKeys, releasePressedButtons, send])

      useEffect(function () {
        var disposed = false
        var pendingFrame = null
        var pendingMeta = null
        var decodingFrame = false
        var activePc = null
        var remoteReady = false
        var remoteCandidates = []
        var lastVideoFrameAt = 0

        function gatewayUrl(path, scheme) {
          var base = apiBase || window.location.origin
          var u = new URL(base, window.location.href)
          u.protocol = scheme || (u.protocol === 'https:' ? 'wss:' : 'ws:')
          u.pathname = path
          u.search = ''
          return u.toString()
        }

        function sendOnTransport(msg, transport) {
          if (transport === 'rtc') return sendRtc(msg, 'control')
          var ws = socketRef.current
          if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify(msg)); return true } catch {}
          }
          return false
        }

        function clearLegacyRetry() {
          if (retryRef.current) {
            clearTimeout(retryRef.current)
            retryRef.current = null
          }
        }

        function scheduleLegacy(delay) {
          if (disposed || transportRef.current === 'rtc' || socketRef.current || retryRef.current) return
          retryRef.current = setTimeout(function () {
            retryRef.current = null
            connectLegacy()
          }, Math.max(0, delay || 0))
        }

        function closeLegacy() {
          var ws = socketRef.current
          socketRef.current = null
          if (ws) {
            try { ws.close(1000, 'webrtc active') } catch {}
          }
        }

        function clearRtcFallback() {
          if (rtcFallbackRef.current) {
            clearTimeout(rtcFallbackRef.current)
            rtcFallbackRef.current = null
          }
          if (rtcDropRef.current) {
            clearTimeout(rtcDropRef.current)
            rtcDropRef.current = null
          }
        }

        function clearVideoWatchdog() {
          if (videoWatchdogRef.current) {
            clearInterval(videoWatchdogRef.current)
            videoWatchdogRef.current = null
          }
        }

        function clearVideoStallTimer() {
          if (videoStallRef.current) {
            clearTimeout(videoStallRef.current)
            videoStallRef.current = null
          }
        }

        function failRtc(pc) {
          if (pc && rtcPcRef.current && rtcPcRef.current !== pc) return
          clearRtcFallback()
          var signal = signalRef.current
          var peer = rtcPcRef.current
          signalRef.current = null
          rtcPcRef.current = null
          rtcControlRef.current = null
          rtcPointerRef.current = null
          rtcFramesRef.current = null
          videoStateRef.current = false
          clearVideoWatchdog()
          clearVideoStallTimer()
          // Keep the video element's last presented frame (and its stream)
          // attached: the next fresh JPEG takes over the layer, and a later
          // track reuses the element without a black flash.
          if (signal) { try { signal.close() } catch {} }
          if (peer) { try { peer.close() } catch {} }
          if (transportRef.current === 'rtc' || transportRef.current === 'connecting') {
            transportRef.current = 'legacy'
            setOnline(false)
          }
          scheduleLegacy(0)
        }

        function waitForIce(pc) {
          if (pc.iceGatheringState === 'complete') return Promise.resolve()
          return new Promise(function (resolve) {
            var done = false
            var timer = setTimeout(finish, 2500)
            function finish() {
              if (done) return
              done = true
              clearTimeout(timer)
              pc.removeEventListener?.('icegatheringstatechange', check)
              resolve()
            }
            function check() {
              if (pc.iceGatheringState === 'complete') finish()
            }
            pc.addEventListener?.('icegatheringstatechange', check)
          })
        }

        function addRemoteCandidate(candidate, mid) {
          if (!candidate || !activePc) return
          var item = { candidate: String(candidate), sdpMid: mid === undefined || mid === null ? null : String(mid) }
          if (!remoteReady) {
            remoteCandidates.push(item)
            return
          }
          activePc.addIceCandidate(item).catch(function () {})
        }

        function applyRemoteCandidates() {
          if (!activePc || !remoteReady) return
          var items = remoteCandidates
          remoteCandidates = []
          items.forEach(function (item) {
            activePc.addIceCandidate(item).catch(function () {})
          })
        }

        function decodeLatestFrame() {
          if (disposed || decodingFrame || !pendingFrame) return
          var frame = pendingFrame
          pendingFrame = null
          decodingFrame = true
          var decodeStarted = performance.now()
          var blob = new Blob([frame.data], { type: 'image/jpeg' })
          var finish = function (ok) {
            if (frame.meta && frame.meta.seq !== undefined && ok && !disposed) {
              sendOnTransport({
                type: 'frame-ack',
                seq: frame.meta.seq,
                decodeMs: Math.round(performance.now() - decodeStarted),
              }, frame.meta.transport || 'legacy')
            }
            decodingFrame = false
            decodeLatestFrame()
          }
          // Paint into the one long-lived canvas: atomic drawImage replaces
          // the visible frame without a blob URL, an <img> src swap, or a
          // layout change — no per-frame blob: churn and no flicker.
          function paint(source) {
            if (disposed) { finish(false); return }
            var canvas = canvasRef.current
            if (canvas) {
              canvas.width = source.width
              canvas.height = source.height
              var ctx = canvas.getContext('2d')
              if (ctx) ctx.drawImage(source, 0, 0)
            }
            if (typeof source.close === 'function') source.close()
            setHasFrame(true)
            setOnline(true)
            // The JPEG layer takes over only when the video layer has
            // declared a stall AND this fresh frame proves the fallback path
            // is live. Until a fresh JPEG actually decodes, the video
            // element keeps its last presented frame, so the stage never
            // flashes a stale picture or black during the fallback roundtrip.
            if (!videoStateRef.current) setVideoActive(false)
            finish(true)
          }
          if (typeof createImageBitmap === 'function') {
            createImageBitmap(blob).then(paint, function () { finish(false) })
          } else {
            // Legacy fallback for engines without createImageBitmap: decode
            // through an Image but still paint into the canvas.
            var url = URL.createObjectURL(blob)
            var image = new Image()
            image.onload = function () {
              URL.revokeObjectURL(url)
              paint(image)
            }
            image.onerror = function () {
              URL.revokeObjectURL(url)
              finish(false)
            }
            image.src = url
          }
        }

        function queueFrame(data, meta) {
          pendingFrame = { data: data, meta: meta }
          decodeLatestFrame()
        }

        function queueRtcFrame(data) {
          var bytes
          if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
          else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          else return
          if (bytes.byteLength <= 4) return
          var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          var seq = view.getUint32(0)
          queueFrame(bytes.slice(4).buffer, { seq: seq, transport: 'rtc' })
        }

        function handleRtcFrame(data) {
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            data.arrayBuffer().then(queueRtcFrame).catch(function () {})
            return
          }
          queueRtcFrame(data)
        }

        function connectLegacy() {
          if (disposed || socketRef.current || transportRef.current === 'rtc') return
          var ws
          try { ws = new WebSocket(gatewayUrl('/__remote/desktop/view')) } catch { scheduleLegacy(retryMsRef.current); return }
          ws.binaryType = 'arraybuffer'
          socketRef.current = ws
          ws.onopen = function () {
            // The parallel RTC session may have won the race while this
            // socket was connecting: never demote an active RTC transport.
            if (disposed || transportRef.current === 'rtc') {
              try { ws.close(1000, 'webrtc active') } catch {}
              return
            }
            transportRef.current = 'legacy'
            retryMsRef.current = 1500
            sendOnTransport({ type: 'viewer-ready', protocol: 2 }, 'legacy')
            sendOnTransport({ type: 'quality', mode: qualityRef.current }, 'legacy')
            sendOnTransport({ type: 'request-frame' }, 'legacy')
          }
          ws.onmessage = function (event) {
            if (typeof event.data === 'string') {
              try {
                var msg = JSON.parse(event.data)
                if (msg.type === 'status') {
                  setOnline(Boolean(msg.desktop && msg.desktop.online))
                  setInfo(msg.desktop || {})
                } else if (msg.type === 'frame-meta') {
                  pendingMeta = { ...msg, transport: 'legacy' }
                } else if (msg.type === 'qos') {
                  setQos(msg)
                }
              } catch {}
              return
            }
            queueFrame(event.data, pendingMeta)
            pendingMeta = null
          }
          ws.onclose = function (event) {
            if (socketRef.current === ws) socketRef.current = null
            if (transportRef.current !== 'rtc') setOnline(false)
            if (event.code === 1008 || event.code === 4401) onUnauthorized()
            if (!disposed && transportRef.current !== 'rtc') {
              scheduleLegacy(retryMsRef.current)
              retryMsRef.current = Math.min(30_000, Math.round(retryMsRef.current * 2))
            }
          }
        }

        async function startRtcPeer(iceServers, signal) {
          if (disposed || activePc || typeof window.RTCPeerConnection !== 'function') return
          var RTC = window.RTCPeerConnection
          var pc
          try {
            pc = new RTC({ iceServers: Array.isArray(iceServers) ? iceServers : [] })
            activePc = pc
            rtcPcRef.current = pc
            remoteReady = false
            remoteCandidates = []
            var localDescriptionSent = false
            var localCandidates = []
            function sendLocalCandidate(candidate) {
              if (!candidate || signal.readyState !== 1) return
              try {
                signal.send(JSON.stringify({
                  type: 'candidate',
                  candidate: candidate.candidate,
                  sdpMid: candidate.sdpMid,
                }))
              } catch {}
            }
            pc.onicecandidate = function (event) {
              if (!event.candidate) return
              // ICE gathering is completed before the offer is sent, so the
              // SDP already contains all candidates. Queue trickle messages
              // until the gateway has created the offer-side session; sending
              // them before the offer would be rejected as an invalid state.
              if (!localDescriptionSent) localCandidates.push(event.candidate)
              else sendLocalCandidate(event.candidate)
            }
            pc.onconnectionstatechange = function () {
              var state = pc.connectionState || pc.iceConnectionState
              if (state === 'connected' || state === 'completed') {
                transportRef.current = 'rtc'
                clearRtcFallback()
                clearLegacyRetry()
                closeLegacy()
                setOnline(Boolean(info.online) || true)
                return
              }
              if (state === 'disconnected') {
                if (!rtcDropRef.current) {
                  rtcDropRef.current = setTimeout(function () {
                    rtcDropRef.current = null
                    if (pc.connectionState === 'disconnected') failRtc(pc)
                  }, 3000)
                }
              } else if (state === 'failed' || state === 'closed') {
                failRtc(pc)
              }
            }
            pc.oniceconnectionstatechange = function () {
              if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') failRtc(pc)
            }

            pc.ontrack = function (event) {
              if (!event.track || event.track.kind !== 'video') return
              var element = videoRef.current
              if (!element) return
              var stream = event.streams && event.streams[0]
              if (!stream && typeof MediaStream === 'function') stream = new MediaStream([event.track])
              if (!stream) return
              element.srcObject = stream
              // requestVideoFrameCallback reports only actually presented
              // frames. Chromium fires waiting/stalled on a media element for
              // trivial WebRTC jitter, so reacting to those events toggles
              // the JPEG fallback constantly — the classic flicker loop.
              // With rVFC available those events are ignored entirely and
              // the watchdog below is the only stall detector.
              var rvfc = typeof element.requestVideoFrameCallback === 'function'
              var markVideoReady = function () {
                if (disposed || activePc !== pc) return
                if (performance.now() - lastVideoFrameAt > 2500) return
                clearVideoStallTimer()
                setVideoActive(true)
                setHasFrame(true)
                setOnline(true)
                if (!videoStateRef.current) {
                  videoStateRef.current = true
                  sendOnTransport({ type: 'video-ready' }, 'rtc')
                }
                if (videoWatchdogRef.current === null) {
                  videoWatchdogRef.current = setInterval(function () {
                    if (!videoStateRef.current || performance.now() - lastVideoFrameAt < 2500) return
                    markVideoStalled()
                  }, 1000)
                }
              }
              var markVideoStalled = function () {
                if (disposed || activePc !== pc || !videoStateRef.current) return
                if (rvfc) {
                  // The watchdog only reaches here after 2.5s without a
                  // presented frame: declare the stall immediately and ask
                  // the gateway for JPEG. The layer swap itself happens in
                  // decodeLatestFrame once a fresh JPEG has decoded.
                  clearVideoWatchdog()
                  videoStateRef.current = false
                  sendOnTransport({ type: 'video-stalled' }, 'rtc')
                  return
                }
                if (videoStallRef.current) return
                videoStallRef.current = setTimeout(function () {
                  videoStallRef.current = null
                  if (disposed || activePc !== pc || !videoStateRef.current) return
                  if (performance.now() - lastVideoFrameAt < 2500) return
                  clearVideoWatchdog()
                  videoStateRef.current = false
                  sendOnTransport({ type: 'video-stalled' }, 'rtc')
                }, 1200)
              }
              if (rvfc) {
                var onVideoFrame = function () {
                  lastVideoFrameAt = performance.now()
                  // A presented frame is authoritative proof the H.264 layer
                  // is live again: switch back from JPEG only on this signal.
                  if (!videoStateRef.current) markVideoReady()
                  if (!disposed && activePc === pc && typeof element.requestVideoFrameCallback === 'function') {
                    element.requestVideoFrameCallback(onVideoFrame)
                  }
                }
                element.requestVideoFrameCallback(onVideoFrame)
              } else {
                element.ontimeupdate = function () { lastVideoFrameAt = performance.now() }
                element.onwaiting = markVideoStalled
                element.onstalled = markVideoStalled
              }
              element.onplaying = function () {
                if (videoStateRef.current) return
                lastVideoFrameAt = performance.now()
                markVideoReady()
              }
              event.track.onended = markVideoStalled
              element.play?.().catch?.(() => {})
            }

            var control = pc.createDataChannel('control')
            var pointerChannel = pc.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 })
            var frames = pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 })
            if (typeof pc.addTransceiver === 'function') {
              // The gateway adds a send-only H.264 track only when this
              // recvonly m-line is present. JPEG DataChannel remains the
              // immediate fallback until the video element starts playing.
              pc.addTransceiver('video', { direction: 'recvonly' })
            }
            rtcControlRef.current = control
            rtcPointerRef.current = pointerChannel
            rtcFramesRef.current = frames
            control.onopen = function () {
              transportRef.current = 'rtc'
              clearRtcFallback()
              clearLegacyRetry()
              closeLegacy()
              setOnline(true)
              sendOnTransport({ type: 'viewer-ready', protocol: 3 }, 'rtc')
              sendOnTransport({ type: 'quality', mode: qualityRef.current }, 'rtc')
              sendOnTransport({ type: 'request-frame' }, 'rtc')
            }
            control.onmessage = function (event) {
              try {
                var msg = JSON.parse(String(event.data || ''))
                if (msg.type === 'qos') setQos(msg)
                if (msg.type === 'status') {
                  setOnline(Boolean(msg.desktop && msg.desktop.online))
                  setInfo(msg.desktop || {})
                }
              } catch {}
            }
            control.onclose = function () { if (!disposed) failRtc(pc) }
            pointerChannel.onclose = function () { if (!disposed && transportRef.current === 'rtc') failRtc(pc) }
            frames.onmessage = function (event) { handleRtcFrame(event.data) }
            frames.onclose = function () { if (!disposed && transportRef.current === 'rtc') failRtc(pc) }

            var offer = await pc.createOffer()
            if (disposed || activePc !== pc) return
            await pc.setLocalDescription(offer)
            await waitForIce(pc)
            if (disposed || activePc !== pc || signal.readyState !== 1) return
            signal.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }))
            localDescriptionSent = true
            localCandidates.forEach(sendLocalCandidate)
            localCandidates = []
          } catch {
            failRtc(pc)
          }
        }

        function connectRtc() {
          if (disposed || typeof window.RTCPeerConnection !== 'function') {
            connectLegacy()
            return
          }
          var signal
          try { signal = new WebSocket(gatewayUrl('/__remote/desktop/rtc')) } catch { connectLegacy(); return }
          signalRef.current = signal
          signal.onmessage = function (event) {
            if (typeof event.data !== 'string') return
            var msg
            try { msg = JSON.parse(event.data) } catch { return }
            if (msg.type === 'rtc-config') {
              startRtcPeer(msg.iceServers || [], signal)
              return
            }
            if (msg.type === 'rtc-description' && msg.description && activePc) {
              activePc.setRemoteDescription(msg.description).then(function () {
                remoteReady = true
                applyRemoteCandidates()
              }).catch(function () { failRtc(activePc) })
              return
            }
            if (msg.type === 'rtc-candidate') {
              addRemoteCandidate(msg.candidate, msg.mid !== undefined ? msg.mid : msg.sdpMid)
              return
            }
            if (msg.type === 'rtc-error') failRtc(activePc)
          }
          signal.onerror = function () {
            if (!activePc || transportRef.current !== 'rtc') failRtc(activePc)
          }
          signal.onclose = function (event) {
            if (signalRef.current === signal) signalRef.current = null
            if (!disposed && transportRef.current !== 'rtc') {
              if (event.code === 1008 || event.code === 4401) onUnauthorized()
              failRtc(activePc)
            }
          }
          // Open the authenticated JPEG socket in parallel: its first frame
          // lands in about one round trip, so the window shows the desktop
          // immediately while ICE and the H.264 track are still negotiating.
          // The RTC session closes this socket as soon as it connects.
          connectLegacy()
          rtcFallbackRef.current = setTimeout(function () {
            rtcFallbackRef.current = null
            if (!activePc || transportRef.current !== 'rtc') scheduleLegacy(0)
          }, 4500)
        }

        gatewayFetch('/admin/desktop/status').then(function (res) {
          if (disposed) return
          if (res && res.status === 401) onUnauthorized()
          connectRtc()
        })

        return function () {
          disposed = true
          clearLegacyRetry()
          clearRtcFallback()
          sendOnTransport({ type: 'input-reset' }, 'rtc')
          sendOnTransport({ type: 'input-reset' }, 'legacy')
          if (socketRef.current) { try { socketRef.current.close() } catch {} }
          if (signalRef.current) { try { signalRef.current.close() } catch {} }
          if (rtcPcRef.current) { try { rtcPcRef.current.close() } catch {} }
          socketRef.current = null
          signalRef.current = null
          rtcPcRef.current = null
          rtcControlRef.current = null
          rtcPointerRef.current = null
          rtcFramesRef.current = null
          videoStateRef.current = false
          clearVideoWatchdog()
          clearVideoStallTimer()
          setVideoActive(false)
          if (videoRef.current) videoRef.current.srcObject = null
          pendingFrame = null
        }
      }, [onUnauthorized, sendRtc])

      useEffect(function () {
        function releaseWhenHidden() {
          if (document.hidden) releaseInputState()
        }
        window.addEventListener('blur', releaseInputState)
        document.addEventListener('visibilitychange', releaseWhenHidden)
        return function () {
          releaseInputState()
          window.removeEventListener('blur', releaseInputState)
          document.removeEventListener('visibilitychange', releaseWhenHidden)
        }
      }, [releaseInputState])

      useEffect(function () {
        function releaseButton(event) {
          var button = event.button
          if (pressedButtonsRef.current[button] === undefined) return
          var point = lastPointRef.current
          send({ type: 'pointer', action: 'up', x: point.x, y: point.y, button: button, buttons: 0 })
          delete pressedButtonsRef.current[button]
        }
        window.addEventListener('mouseup', releaseButton)
        return function () { window.removeEventListener('mouseup', releaseButton) }
      }, [send])

      useEffect(function () {
        var stage = stageRef.current
        if (!stage) return
        function handleWheel(event) {
          send({ type: 'pointer', action: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY })
          event.preventDefault()
        }
        stage.addEventListener('wheel', handleWheel, { passive: false })
        return function () { stage.removeEventListener('wheel', handleWheel) }
      }, [send])

      var point = function (event) {
        var canvas = canvasRef.current
        var stage = stageRef.current
        var target = canvas && canvas.width ? canvas : stage
        if (!target || !stage) return null
        var r = target.getBoundingClientRect()
        var sr = stage.getBoundingClientRect()
        if (!r.width || !r.height || !sr.width || !sr.height) return null
        var sourceWidth = canvas && canvas.width ? canvas.width : Number(info.width) || 1280
        var sourceHeight = canvas && canvas.height ? canvas.height : Number(info.height) || 720
        var scale = Math.min(r.width / sourceWidth, r.height / sourceHeight)
        var width = sourceWidth * scale
        var height = sourceHeight * scale
        var left = r.left + (r.width - width) / 2
        var top = r.top + (r.height - height) / 2
        var x = Math.max(0, Math.min(1, (event.clientX - left) / width))
        var y = Math.max(0, Math.min(1, (event.clientY - top) / height))
        return {
          x: x,
          y: y,
          cursorX: Math.max(0, Math.min(sr.width - 1, left + x * width - sr.left)),
          cursorY: Math.max(0, Math.min(sr.height - 1, top + y * height - sr.top)),
        }
      }

      var pointer = function (action, event) {
        var p = point(event)
        if (!p) return
        setCursor({ x: p.cursorX, y: p.cursorY, visible: true })
        if (action === 'move') {
          var now = performance.now()
          if (now - lastPointerAt.current < 33) return
          lastPointerAt.current = now
        }
        lastPointRef.current = { x: p.x, y: p.y }
        if (action === 'down') pressedButtonsRef.current[event.button] = true
        if (action === 'up') delete pressedButtonsRef.current[event.button]
        send({ type: 'pointer', action: action, x: p.x, y: p.y, button: event.button, buttons: event.buttons })
      }

      var selectQuality = function (mode) {
        setQuality(mode)
        send({ type: 'quality', mode: mode })
      }

      return h('div', { className: (bare ? 'rp-desktop rp-desktop-bare' : 'rp-card rp-desktop') },
        h('div', { className: 'rp-desktop-head' },
          h('div', {},
            h('h3', { className: 'rp-title' }, t('desktop.title')),
            h('span', { className: 'rp-desktop-badge' },
              h('span', { className: 'rp-dot' + (online ? ' rp-dot-on' : '') }),
              online ? t('desktop.online') + (info.width ? ' · ' + info.width + '×' + info.height + ' · ' + (qos.renderFps || info.fps || 0) + ' fps' + (qos.latencyMs ? ' · ' + qos.latencyMs + ' ms' : '') : '') : t('desktop.offline')
            )
          ),
          h('select', {
            className: 'rp-input rp-quality', value: quality,
            onChange: function (e) { selectQuality(e.target.value) },
          },
            h('option', { value: 'auto' }, t('desktop.auto')),
            h('option', { value: 'low' }, t('desktop.low')),
            h('option', { value: 'balanced' }, t('desktop.balanced')),
            h('option', { value: 'sharp' }, t('desktop.sharp'))
          )
        ),
        h('div', {
          ref: stageRef, className: 'rp-desktop-stage', tabIndex: 0, title: t('desktop.focus'),
          onMouseEnter: function () { setCursor(function (v) { return { x: v.x, y: v.y, visible: true } }) },
          onMouseLeave: function () { setCursor(function (v) { return { x: v.x, y: v.y, visible: false } }) },
          onMouseMove: function (e) { pointer('move', e) },
          onMouseDown: function (e) { e.currentTarget.focus(); pointer('down', e); e.preventDefault() },
          onMouseUp: function (e) { pointer('up', e); e.preventDefault() },
          onBlur: releaseInputState,
          onContextMenu: function (e) { e.preventDefault() },
          onKeyDown: function (e) { if (!e.isComposing) { pressedKeysRef.current[e.code] = e.key; send({ type: 'key', action: 'down', code: e.code, key: e.key, repeat: e.repeat }); e.preventDefault() } },
          onKeyUp: function (e) { delete pressedKeysRef.current[e.code]; send({ type: 'key', action: 'up', code: e.code, key: e.key }); e.preventDefault() },
        },
          h('video', {
            ref: videoRef,
            autoPlay: true,
            playsInline: true,
            muted: true,
            'aria-label': t('desktop.title'),
            style: { opacity: videoActive ? 1 : 0 },
          }),
          h('canvas', {
            ref: canvasRef,
            'aria-label': t('desktop.title'),
          }),
          !hasFrame && h('div', { className: 'rp-desktop-empty' }, t('desktop.offline')),
          cursor.visible && h('svg', {
            className: 'rp-desktop-cursor',
            style: { left: cursor.x + 'px', top: cursor.y + 'px' },
            width: 20, height: 26, viewBox: '0 0 20 26', 'aria-hidden': 'true',
          }, h('path', { d: 'M2 2v21l5.4-5.5L12.7 25l3-1.8-5.2-8.2H19z' }))
        )
      )
    }

    function AuthBanner() {
      return h('div', { className: 'rp-auth-banner' },
        h('span', {}, t('auth.title')),
        h('button', {
          className: 'rp-btn',
          onClick: function () { window.open(apiBase + '/login', '_blank') },
        }, t('auth.login'))
      )
    }

    // Settings contains gateway administration only. The live desktop is a
    // separate conversation view beside 对话/轨迹 and is never rendered here.
    function RemoteAccessSettings() {
      var [authRequired, setAuthRequired] = useState(false)
      var onUnauthorized = useCallback(function () { setAuthRequired(true) }, [])
      return h('div', { className: 'rp-root' },
        authRequired && h(AuthBanner, null),
        h(WhitelistCard, { onUnauthorized: onUnauthorized }),
        h(AccountsCard, { onUnauthorized: onUnauthorized }),
        h(LogsCard, { onUnauthorized: onUnauthorized })
      )
    }

    // ---- conversation view tab (对话/轨迹 ring) ----
    // Scrollable body for the tab: the conversation view area owns layout,
    // so the tab content provides its own scroll + padding.
    function RemoteAccessView() {
      var [authRequired, setAuthRequired] = useState(false)
      var onUnauthorized = useCallback(function () { setAuthRequired(true) }, [])
      return h('div', { className: 'rp-view rp-view-desktop' },
        h('div', { className: 'rp-root', style: { height: '100%' } },
          authRequired && h(AuthBanner, null),
          h(DesktopCard, { onUnauthorized: onUnauthorized, bare: true })
        )
      )
    }

    // ---- registration: a conversation view tab + one row in the settings modal nav ----
    var inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, dicts)
      }, 'dsh-plugin-remote: locale dictionaries')
      t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'remote-access',
          order: 20,
          locale: NS,
          label: function () { return t('nav') },
        }, RemoteAccessView)
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'remote-access',
          order: 30,
          label: function () { return t('nav') },
          locale: NS,
        }, RemoteAccessSettings)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

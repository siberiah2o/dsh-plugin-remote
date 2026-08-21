# dsh-plugin-remote

Remote access gateway for the DeepSeek Harness (DSH) Web GUI — login auth + HTTP/WebSocket reverse proxy to the loopback DSH server.

[中文](README.zh.md) · MIT

## Install

```sh
dsh plugin --profile web add dsh-plugin-remote && dsh web
```

> Note: this is a DSH (DeepSeek Harness) plugin — install it into a profile through `dsh plugin` (or the profile's dependencies) so the gateway activates; a plain `npm i` alone does not wire it in.

## Features

- **Login-gated remote access**: scrypt credentials + HttpOnly session cookie; HTTP/WebSocket reverse proxy with Host/Origin rewriting — no `--trusted-host` needed
- **White-themed login page** (shadcn/ui, mobile-friendly) with the DeepSeek Harness brand
- **Gateway admin API** (`/admin/*`, session-required), managed in the
  Settings → 远程访问 section:
  - Remote-access whitelist (IP / CIDR; loopback always allowed; hot-reloaded)
  - Account password changes (old sessions revoked immediately)
  - Request log: every request persisted to per-day JSONL shards, download + 1/3/7-day retention rules
- **Localized zh/en**, follows the GUI language
- **Zero-install Windows desktop projection**: the plugin starts its bundled
  x64 native helper automatically; no .NET, FFmpeg, driver, or separate agent
  installation is required
- **Interactive remote desktop** as a dedicated 远程访问 tab in the
  conversation view ring (next to 对话/轨迹), projecting the Windows desktop
  full-width with pointer input, keyboard input, and
  weak-network/balanced/sharp quality profiles. The primary WAN transport is
  WebRTC with independent lossy frame/pointer channels and a reliable control
  channel; the original WebSocket viewer remains an automatic fallback
- The gateway keeps its custom HTTP/WebSocket plumbing on Node built-ins; the
  optional native `node-datachannel` package provides the WebRTC fast path and
  the Next.js login app lives inside `gateway/`

## Usage

- Open `http://<server-ip>:4080` — the first visit creates the only account
- Manage accounts: `node lib/remote-passwd.mjs add|set-password|list|del <username>`
- Data lives under `$DSH_HOME/plugin-data/dsh-plugin-remote/` (`users.json`, `whitelist.json`, `logs/`)

## Windows desktop

On Windows 10/11 x64, the plugin launches `native/windows-x64/dsh-remote-host.exe`
after the gateway becomes ready. It connects back with a random process-local
authentication token that is never written to disk. Only logged-in gateway
users can open the viewer/control channel.

The current Windows helper source has two video paths. After `native:build`,
the primary path captures BGRA frames, encodes H.264 through Media Foundation,
and sends one access unit into a real WebRTC H.264/RTP track. The browser and
libdatachannel then use the media transport's pacing, congestion feedback,
NACKs, and keyframe requests instead of putting every full frame into a TCP
queue. During startup or when H.264 cannot be decoded, the gateway keeps the
JPEG DataChannel path alive and switches to it automatically; the authenticated
WebSocket viewer is the final compatibility fallback. The package prefers the
`dsh-remote-host-h264.exe` binary when present and keeps the old exe as a legacy
fallback; `npm run native:build` refreshes both copies.

Pointer motion and wheel events use a disposable low-latency channel, while
keyboard, button transitions, ACKs, and input-reset messages remain ordered and
reliable. This prevents stale video from blocking new input on a weak link.

For clients behind symmetric NAT or UDP-restricted networks, configure a TURN
server in the plugin row. The values use the browser `RTCConfiguration` shape:

```js
{
  rtcIceServers: [
    'stun:stun.example.net:3478',
    { urls: 'turns:turn.example.net:5349', username: 'user', credential: 'secret' },
  ],
}
```

STUN is useful for direct paths; TURN is the reliable relay fallback. Keep the
WebSocket fallback enabled when deploying in environments where UDP policy is
unknown.

Windows secure desktops (UAC prompts, sign-in, and locked sessions) cannot be
captured or controlled. Set `config.desktop: false` to disable projection.

### Development verification

```powershell
npm run native:build
npm run gateway:build
npm run test:desktop
```

## License

MIT

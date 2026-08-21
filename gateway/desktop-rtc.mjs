// WebRTC transport for the remote desktop.
//
// The browser creates three data channels:
//   frames  - unordered, no retransmission; stale images are disposable.
//   control - reliable, ordered; keyboard/buttons and frame ACKs use this.
//   pointer - unordered, no retransmission; only the latest mouse motion wins.
//
// JPEG DataChannel remains a compatibility path, but H.264-capable sessions
// also negotiate a real WebRTC video track. The native helper can therefore
// send an encoded access unit once and let RTP/RTCP handle packetization,
// congestion control, retransmission and keyframe requests on the WAN leg.

const FRAME_HEADER_BYTES = 4
const FRAME_BUFFER_LIMIT = 256 * 1024
const FRAME_TIMEOUT_MS = 1500
const VIDEO_CLOCK_RATE = 90_000
const VIDEO_MAX_BUFFERED_BYTES = 512 * 1024
const NODE_DESCRIPTION_TYPES = {
  offer: 'Offer',
  answer: 'Answer',
}

function ewma(previous, sample, weight = 0.25) {
  return previous > 0 ? previous * (1 - weight) + sample * weight : sample
}

function asText(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  return String(value ?? '')
}

// Media Foundation encoders and hardware encoders commonly emit either
// Annex-B (start-code separated) or AVC/AVCC (four-byte length prefixed) NAL
// units. libdatachannel's H264 packetizer can consume Annex-B, so normalize at
// the gateway boundary and keep the host protocol independent of the chosen
// Windows encoder.
export function normalizeH264AccessUnit(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  if (input.length === 0) return null
  for (let i = 0; i + 3 < input.length; i += 1) {
    if (input[i] === 0 && input[i + 1] === 0 &&
      (input[i + 2] === 1 || (input[i + 2] === 0 && input[i + 3] === 1))) {
      return input
    }
  }
  const out = []
  let offset = 0
  while (offset + 4 <= input.length) {
    const size = input.readUInt32BE(offset)
    offset += 4
    if (size <= 0 || offset + size > input.length) return null
    out.push(Buffer.from([0, 0, 0, 1]), input.subarray(offset, offset + size))
    offset += size
  }
  return offset === input.length && out.length > 0 ? Buffer.concat(out) : null
}

export class DesktopRtcHub {
  constructor({ rtc, iceServers = [], onInput, onQuality, onState, onVideoState, onFrameTooLarge }) {
    this.rtc = rtc
    this.iceServers = Array.isArray(iceServers) ? iceServers : []
    this.onInput = onInput || (() => {})
    this.onQuality = onQuality || (() => {})
    this.onState = onState || (() => {})
    this.onVideoState = onVideoState || (() => {})
    this.onFrameTooLarge = onFrameTooLarge || (() => {})
    this.sessions = new Set()
    this.nextId = 1
  }

  get available() {
    return Boolean(this.rtc?.PeerConnection)
  }

  get size() {
    return this.sessions.size
  }

  viewerCount() {
    return this.sessions.size
  }

  qualityModes() {
    return [...this.sessions].map((session) => session.qualityMode || 'auto')
  }

  autoSessions() {
    return [...this.sessions].filter((session) => session.qualityMode === 'auto' && !session.videoReady && session.control?.isOpen?.())
  }

  create(signal, user, { video = false, videoMid = 'video' } = {}) {
    if (!this.available) return null
    const id = String(this.nextId++)
    const pc = new this.rtc.PeerConnection(`dsh-remote-${id}`, {
      iceServers: this.iceServers,
      enableIceTcp: true,
      // node-datachannel currently advertises 256 KiB as the SCTP message
      // limit. Keep the native peer at that limit so the browser never
      // accepts a frame that the gateway cannot send.
      maxMessageSize: 256 * 1024,
      // A media m-line is intentionally only added when the offer contains
      // one. Older browsers and the JPEG-only fallback can still negotiate
      // the three data channels without an unused media section.
      forceMediaTransport: video,
    })
    let videoTrack = null
    let videoRtpConfig = null
    if (video && this.rtc.Video && this.rtc.RtpPacketizationConfig && this.rtc.H264RtpPacketizer) {
      try {
        const ssrc = (0x44534800 + Number(id)) >>> 0
        const description = new this.rtc.Video(videoMid || 'video', 'SendOnly')
        description.addH264Codec(102)
        description.addSSRC(ssrc, 'dsh-remote-video', `stream-${id}`, 'video')
        videoTrack = pc.addTrack(description)
        videoRtpConfig = new this.rtc.RtpPacketizationConfig(ssrc, 'dsh-remote-video', 102, VIDEO_CLOCK_RATE)
        const packetizer = new this.rtc.H264RtpPacketizer('StartSequence', videoRtpConfig, 1200)
        if (this.rtc.RtcpSrReporter) packetizer.addToChain(new this.rtc.RtcpSrReporter(videoRtpConfig))
        if (this.rtc.RtcpNackResponder) packetizer.addToChain(new this.rtc.RtcpNackResponder())
        videoTrack.setMediaHandler(packetizer)
      } catch (error) {
        // DataChannels are still useful when this particular native binding
        // was built without media support. The session simply omits video.
        console.warn('desktop WebRTC H264 track unavailable: ' + error.message)
        videoTrack = null
        videoRtpConfig = null
      }
    }
    const session = {
      id,
      user,
      signal,
      pc,
      channels: new Map(),
      control: null,
      pointer: null,
      frames: null,
      video: Boolean(videoTrack),
      videoTrack,
      videoRtpConfig,
      videoReady: false,
      pendingVideo: null,
      lastVideoTimestamp: 0,
      sentVideoFrames: 0,
      droppedVideoFrames: 0,
      qualityMode: 'auto',
      lastGeneration: 0,
      lastSentAt: 0,
      inFlight: false,
      ackLatencyMs: 0,
      decodeMs: 0,
      ackedFrames: 0,
      totalAckedFrames: 0,
      droppedFrames: 0,
      frameTimeouts: 0,
      sentFrames: 0,
      closed: false,
    }
    this.sessions.add(session)

    videoTrack?.onOpen?.(() => {
      // A viewer may join in the middle of a GOP. Ask the native encoder for
      // an IDR before its first RTP access unit so it never waits for the
      // next periodic keyframe to become decodable.
      this.onInput({ type: 'keyframe', viewer: session.user })
      this.onVideoState(session, 'track-open')
      this.flushLatestVideo(session)
    })
    videoTrack?.onClosed?.(() => this.onVideoState(session, 'track-closed'))
    videoTrack?.onError?.(() => this.onVideoState(session, 'track-error'))

    pc.onLocalDescription((sdp, type) => {
      signal.sendJson({
        type: 'rtc-description',
        description: { type: String(type || '').toLowerCase(), sdp },
      })
    })
    pc.onLocalCandidate((candidate, mid) => {
      signal.sendJson({ type: 'rtc-candidate', candidate, mid })
    })
    pc.onStateChange((state) => {
      if (state === 'connected') this.onState(session, 'connected')
      // A temporary ICE disconnect can recover without renegotiation. Let
      // the browser-side grace timer decide when to abandon the session;
      // closing here would reset input during a transient mobile handover.
      if (state === 'disconnected') this.onState(session, 'disconnected')
      if (state === 'failed' || state === 'closed') this.close(session, false)
    })
    pc.onDataChannel((channel) => this.attachChannel(session, channel))
    this.onState(session, 'connecting')
    return session
  }

  signal(signal, user, message) {
    if (!this.available || !message || typeof message !== 'object') return false
    let session = [...this.sessions].find((item) => item.signal === signal)
    if (message.type === 'offer') {
      if (session) this.close(session, true)
      const remoteSdp = String(message.sdp || '')
      const videoSection = remoteSdp.match(/(?:^|\r?\n)(m=video\s[\s\S]*?)(?=(?:\r?\n)m=|$)/)
      const videoMid = videoSection?.[1]?.match(/(?:^|\r?\n)a=mid:([^\r\n]+)/)?.[1] || 'video'
      const wantsVideo = Boolean(videoSection)
      session = this.create(signal, user, { video: wantsVideo, videoMid })
      if (!session) return false
      session.pc.setRemoteDescription(String(message.sdp || ''), NODE_DESCRIPTION_TYPES.offer)
      return true
    }
    if (!session) return false
    if (message.type === 'candidate' && message.candidate) {
      const candidate = typeof message.candidate === 'string' ? message.candidate : message.candidate.candidate
      const mid = message.mid !== undefined
        ? message.mid
        : message.sdpMid !== undefined
          ? message.sdpMid
          : message.candidate.sdpMid || ''
      if (candidate) session.pc.addRemoteCandidate(candidate, String(mid ?? ''))
      return true
    }
    return false
  }

  closeBySignal(signal) {
    for (const session of [...this.sessions]) {
      if (session.signal === signal) this.close(session, true)
    }
  }

  attachChannel(session, channel) {
    const label = channel.getLabel?.() || ''
    if (!['control', 'pointer', 'frames'].includes(label)) {
      try { channel.close() } catch {}
      return
    }
    const old = session.channels.get(label)
    if (old && old !== channel) {
      try { old.close() } catch {}
    }
    session.channels.set(label, channel)
    session[label] = channel
    channel.onOpen?.(() => {
      if (label === 'frames') {
        channel.setBufferedAmountLowThreshold?.(64 * 1024)
        channel.onBufferedAmountLow?.(() => this.flushLatest(session))
        this.flushLatest(session)
      }
      this.onState(session, 'channel-open')
    })
    channel.onClosed?.(() => {
      if (session.channels.get(label) === channel) session.channels.delete(label)
      if (session[label] === channel) session[label] = null
      if (label === 'control') this.onInput({ type: 'input-reset', reason: 'disconnect', viewer: session.user })
      this.onState(session, 'channel-closed')
    })
    channel.onError?.(() => {})
    channel.onMessage?.((message) => this.handleChannelMessage(session, label, message))
  }

  handleChannelMessage(session, label, value) {
    if (label === 'frames') return
    let message
    try { message = JSON.parse(asText(value)) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.type === 'quality') {
      session.qualityMode = ['auto', 'low', 'balanced', 'sharp'].includes(message.mode) ? message.mode : 'auto'
      this.onQuality(session, session.qualityMode)
      return
    }
    if (message.type === 'frame-ack') {
      const seq = Number(message.seq)
      if (session.inFlight && seq === session.lastGeneration) {
        session.ackLatencyMs = ewma(session.ackLatencyMs, Math.max(0, Date.now() - session.lastSentAt))
        session.decodeMs = ewma(session.decodeMs, Math.max(0, Math.min(2000, Number(message.decodeMs) || 0)))
        session.inFlight = false
        session.ackedFrames += 1
        session.totalAckedFrames += 1
        this.flushLatest(session)
      }
      return
    }
    if (message.type === 'viewer-ready') return
    if (message.type === 'video-ready' || message.type === 'video-stalled') {
      const ready = message.type === 'video-ready'
      if (session.videoReady !== ready) {
        session.videoReady = ready
        if (!ready) this.onInput({ type: 'keyframe', viewer: session.user })
        this.onVideoState(session, ready ? 'ready' : 'stalled')
      }
      return
    }
    if (['pointer', 'key', 'clipboard', 'request-frame', 'input-reset'].includes(message.type)) {
      this.onInput({ ...message, viewer: session.user })
    }
  }

  broadcastFrame(payload, generation, now = Date.now()) {
    for (const session of this.sessions) this.offerFrame(session, payload, generation, now)
  }

  offerFrame(session, payload, generation, now = Date.now()) {
    if (session.videoReady) return false
    const channel = session.frames
    if (!payload || !channel?.isOpen?.()) return false
    if (session.inFlight && now - session.lastSentAt < FRAME_TIMEOUT_MS) {
      session.droppedFrames += 1
      return false
    }
    if (session.inFlight) {
      session.inFlight = false
      session.frameTimeouts += 1
    }
    if (session.lastGeneration === generation) return false
    const max = Number(channel.maxMessageSize?.() || 0)
    const size = FRAME_HEADER_BYTES + payload.length
    if (max > 0 && size > max) {
      session.droppedFrames += 1
      this.onFrameTooLarge(session, payload.length, max)
      return false
    }
    if (Number(channel.bufferedAmount?.() || 0) > FRAME_BUFFER_LIMIT) {
      session.droppedFrames += 1
      return false
    }
    const packet = Buffer.allocUnsafe(size)
    packet.writeUInt32BE(generation >>> 0, 0)
    payload.copy(packet, FRAME_HEADER_BYTES)
    if (!channel.sendMessageBinary(packet)) {
      session.droppedFrames += 1
      return false
    }
    session.lastGeneration = generation
    session.lastSentAt = now
    session.inFlight = true
    session.sentFrames += 1
    return true
  }

  flushLatest(session) {
    if (!this.latestFrame || session.inFlight) return
    this.offerFrame(session, this.latestFrame.payload, this.latestFrame.generation)
  }

  setLatestFrame(payload, generation) {
    this.latestFrame = { payload, generation }
    this.broadcastFrame(payload, generation)
  }

  sendVideo(session, payload, timestamp) {
    const track = session.videoTrack
    if (!session.video || !track?.isOpen?.() || !payload) {
      if (session.video) session.pendingVideo = { payload, timestamp }
      return false
    }
    if (Number(track.bufferedAmount?.() || 0) > VIDEO_MAX_BUFFERED_BYTES) {
      session.droppedVideoFrames += 1
      return false
    }
    try {
      session.videoRtpConfig.timestamp = timestamp >>> 0
      if (!track.sendMessageBinary(payload)) {
        session.droppedVideoFrames += 1
        return false
      }
      session.lastVideoTimestamp = timestamp >>> 0
      session.sentVideoFrames += 1
      return true
    } catch {
      session.droppedVideoFrames += 1
      return false
    }
  }

  flushLatestVideo(session) {
    if (!session.pendingVideo) return
    const pending = session.pendingVideo
    session.pendingVideo = null
    this.sendVideo(session, pending.payload, pending.timestamp)
  }

  setLatestVideo(payload, timestamp = Math.round(Date.now() * 90)) {
    const normalized = normalizeH264AccessUnit(payload)
    if (!normalized) return false
    this.latestVideo = { payload: normalized, timestamp: timestamp >>> 0 }
    for (const session of this.sessions) {
      if (!session.video) continue
      session.pendingVideo = this.latestVideo
      this.flushLatestVideo(session)
    }
    return true
  }

  sendQos(session, effective) {
    if (!session.control?.isOpen?.()) return
    session.control.sendMessage(JSON.stringify({
      type: 'qos',
      mode: session.qualityMode || 'auto',
      effective,
      latencyMs: Math.round(session.ackLatencyMs || 0),
      decodeMs: Math.round(session.decodeMs || 0),
      renderFps: Math.round(session.renderFps || 0),
      droppedFrames: session.droppedFrames || 0,
      transport: session.videoReady ? 'webrtc-h264' : 'webrtc',
      videoFrames: session.sentVideoFrames || 0,
      droppedVideoFrames: session.droppedVideoFrames || 0,
    }))
  }

  sendStatus(session, desktop) {
    if (!session?.control?.isOpen?.()) return
    session.control.sendMessage(JSON.stringify({ type: 'status', desktop }))
  }

  sendStatusAll(desktop) {
    for (const session of this.sessions) this.sendStatus(session, desktop)
  }

  close(session, notify = true) {
    if (!session || session.closed) return
    session.closed = true
    try { this.onInput({ type: 'input-reset', reason: 'disconnect', viewer: session.user }) } catch {}
    this.sessions.delete(session)
    if (notify) {
      try { session.pc.close() } catch {}
    }
    try { session.videoTrack?.close?.() } catch {}
    this.onState(session, 'closed')
  }

  closeAll() {
    for (const session of [...this.sessions]) this.close(session, true)
    try { this.rtc?.cleanup?.() } catch {}
  }
}

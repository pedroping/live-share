// BroadcastSession: everything a broadcaster does after it has a stream.
// Shared by the web broadcast page and the desktop app.
//
//   - opens a room on the server and keeps it (reconnects and reclaims the
//     same code if the connection drops or the server restarts)
//   - creates one WebRTC connection per viewer and keeps them alive even
//     while the server is unreachable (the video is peer-to-peer)
//   - swaps tracks on every viewer when the source or audio changes
//   - records a rolling buffer and uploads clips when a viewer asks
//
// Needs (loaded before this file): ServerWake, RollingClipRecorder.
//
//   const session = new BroadcastSession({ serverUrl, getStream, ...callbacks });
//   if (await session.start()) { ... live ... }
//   session.updateStream(newStream);   // after switching source/audio
//   session.stop();                    // ends the room for everyone
(function exposeBroadcastSession(globalScope) {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const AUDIO_BITRATE = 192_000; // stereo music quality
  const CLIP_VIDEO_BITRATE = 6_000_000;
  const CLIP_UPLOAD_TIMEOUT_MS = 240_000;
  const RECONNECT_DELAY_MS = 1500;
  // After "viewer-left", wait this long: if their video link is still up it
  // was just a network blip on their side and they will rejoin.
  const VIEWER_LEFT_GRACE_MS = 10_000;

  class BroadcastSession {
    /**
     * @param {object} options
     * @param {string} options.serverUrl          e.g. "https://…onrender.com" or "" for this site
     * @param {() => MediaStream} options.getStream   current video + audio to send
     * @param {() => {bitrate:number, frameRate:number}} [options.getVideoLimits]
     * @param {(room:{code:string, link:string}) => void} [options.onRoom]
     * @param {(count:number) => void} [options.onViewerCount]
     * @param {(reconnecting:boolean) => void} [options.onReconnecting]
     * @param {(status:object) => void} [options.onServerStatus]  ServerWake progress
     */
    constructor(options) {
      this.serverUrl = options.serverUrl || '';
      this.getStream = options.getStream;
      this.getVideoLimits = options.getVideoLimits || (() => ({ bitrate: 8_000_000, frameRate: 30 }));
      this.onRoom = options.onRoom || (() => {});
      this.onViewerCount = options.onViewerCount || (() => {});
      this.onReconnecting = options.onReconnecting || (() => {});
      this.onServerStatus = options.onServerStatus || (() => {});

      this.active = false;
      this.ws = null;
      this.code = null;
      this.token = null;          // proves we own the room when reconnecting
      this.peers = new Map();     // viewerId -> RTCPeerConnection
      this.clipRecorder = null;
      this.stopKeepAlive = null;
      // Viewers receive this one stream; tracks are swapped inside it, so
      // their <video> keeps playing across source changes.
      this.outboundStream = new MediaStream();
    }

    // ------------------------------------------------------------ lifecycle

    /** Wakes the server if needed, then opens the room. Resolves false if the server is unreachable. */
    async start() {
      const awake = await ServerWake.wakeServer(this.serverUrl, { onStatus: this.onServerStatus });
      if (!awake) return false;
      this.active = true;
      this.setOutboundTracks(this.getStream());
      this.stopKeepAlive = ServerWake.keepAlive(this.serverUrl); // never idle out mid-stream
      this.connect();
      return true;
    }

    /** Ends the room for every viewer and releases everything. */
    stop() {
      if (!this.active) return;
      this.active = false;
      this.stopKeepAlive?.();
      this.send({ type: 'end-room' });
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      for (const pc of this.peers.values()) pc.close();
      this.peers.clear();
      this.clipRecorder?.stop();
      this.clipRecorder = null;
    }

    /** Tells viewers right away that the stream is over (e.g. on page close). */
    sendEndRoom() {
      if (this.active) this.send({ type: 'end-room' });
    }

    /** Sends a new video/audio combination to every viewer and to the clip recorder. */
    async updateStream(stream) {
      this.setOutboundTracks(stream);
      await Promise.all([...this.peers.values()].map((pc) => this.swapTracks(pc, stream)));
      await this.clipRecorder?.setStream(stream);
    }

    /** Re-applies bitrate/frame-rate caps (e.g. after a quality change). */
    async applyLimits() {
      for (const pc of this.peers.values()) await this.applySenderLimits(pc);
    }

    get viewerCount() {
      return this.peers.size;
    }

    // ------------------------------------------------------------ signaling

    send(message) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify(message));
      return true;
    }

    connect() {
      const base = this.serverUrl || location.origin;
      const ws = new WebSocket(base.replace(/^http/, 'ws'));
      this.ws = ws;

      // On a reconnect this asks for the same code back.
      ws.onopen = () => this.send({ type: 'create-room', code: this.code, token: this.token });

      ws.onmessage = (event) => this.handleMessage(JSON.parse(event.data));

      ws.onclose = (event) => {
        console.warn(`signaling closed code=${event.code} reason=${event.reason || '-'} active=${this.active}`);
        if (!this.active || this.ws !== ws) return;
        this.onReconnecting(true);
        setTimeout(() => this.reconnect(ws), RECONNECT_DELAY_MS);
      };
    }

    async reconnect(closedSocket) {
      while (this.active && !(await ServerWake.wakeServer(this.serverUrl, { onStatus: this.onServerStatus }))) {
        // keep trying until the server answers or we are stopped
      }
      if (this.active && this.ws === closedSocket) this.connect();
    }

    async handleMessage(msg) {
      switch (msg.type) {
        case 'room-created': {
          this.code = msg.code;
          this.token = msg.token;
          this.onReconnecting(false);
          const base = this.serverUrl || location.origin;
          this.onRoom({ code: msg.code, link: `${base}/watch.html?code=${msg.code}` });
          break;
        }
        case 'viewer-joined':
          this.ensureClipRecorder();
          await this.addViewer(msg.viewerId);
          break;
        case 'answer': {
          const pc = this.peers.get(msg.from);
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          break;
        }
        case 'ice-candidate': {
          const pc = this.peers.get(msg.from);
          if (pc && msg.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { /* stale candidate */ }
          }
          break;
        }
        case 'viewer-left':
          this.viewerLeft(msg.viewerId);
          break;
        case 'clip-request':
          this.uploadClip(msg);
          break;
        default:
          break;
      }
    }

    // ------------------------------------------------------------ viewers

    async addViewer(viewerId) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pc.viewerId = viewerId;
      this.peers.set(viewerId, pc);

      for (const track of this.getStream().getTracks()) {
        pc.addTrack(track, this.outboundStream).kindHint = track.kind;
      }
      preferHardwareVideoCodec(pc);
      await this.applySenderLimits(pc);

      pc.addEventListener('connectionstatechange', () => {
        if (['failed', 'closed'].includes(pc.connectionState)) this.removeViewer(viewerId, pc);
      });
      pc.onicecandidate = (event) => {
        if (event.candidate) this.send({ type: 'ice-candidate', target: viewerId, candidate: event.candidate });
      };

      await this.sendOffer(pc);
      this.onViewerCount(this.peers.size);
    }

    viewerLeft(viewerId) {
      const pc = this.peers.get(viewerId);
      setTimeout(() => {
        // A closed tab drops the WebRTC link within seconds; a blip doesn't.
        if (pc && this.peers.get(viewerId) === pc && pc.connectionState !== 'connected') {
          this.removeViewer(viewerId, pc);
        }
      }, VIEWER_LEFT_GRACE_MS);
    }

    removeViewer(viewerId, pc) {
      pc.close();
      if (this.peers.get(viewerId) === pc) this.peers.delete(viewerId);
      if (this.peers.size === 0 && this.clipRecorder) {
        // Nobody can ask for clips: stop recording.
        this.clipRecorder.stop();
        this.clipRecorder = null;
      }
      this.onViewerCount(this.peers.size);
    }

    async sendOffer(pc) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ type: 'offer', target: pc.viewerId, sdp: offer });
    }

    setOutboundTracks(stream) {
      this.outboundStream.getTracks().forEach((t) => this.outboundStream.removeTrack(t));
      stream.getTracks().forEach((t) => this.outboundStream.addTrack(t));
    }

    // replaceTrack needs no renegotiation; only a brand-new kind of track
    // (audio appearing for the first time) needs a new offer.
    async swapTracks(pc, stream) {
      let needsOffer = false;
      for (const kind of ['video', 'audio']) {
        const track = stream.getTracks().find((t) => t.kind === kind) || null;
        const sender = pc.getSenders().find((s) => s.kindHint === kind);
        if (sender) {
          await sender.replaceTrack(track);
        } else if (track) {
          pc.addTrack(track, this.outboundStream).kindHint = kind;
          needsOffer = true;
        }
      }
      if (needsOffer) {
        await this.sendOffer(pc);
        await this.applySenderLimits(pc);
      }
    }

    async applySenderLimits(pc) {
      const video = this.getVideoLimits();
      for (const sender of pc.getSenders()) {
        const maxBitrate = sender.kindHint === 'video' ? video.bitrate : sender.kindHint === 'audio' ? AUDIO_BITRATE : 0;
        if (!maxBitrate) continue;
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = maxBitrate;
        if (sender.kindHint === 'video') parameters.encodings[0].maxFramerate = video.frameRate;
        await sender.setParameters(parameters).catch((error) => {
          console.warn('O navegador não aplicou o limite de bitrate:', error);
        });
      }
    }

    // ------------------------------------------------------------ clips

    // Recording only runs while someone is watching.
    ensureClipRecorder() {
      if (this.clipRecorder) return;
      this.clipRecorder = new RollingClipRecorder(this.getStream(), { videoBitsPerSecond: CLIP_VIDEO_BITRATE });
      this.clipRecorder.start();
    }

    async uploadClip({ requestId, duration }) {
      if (!this.clipRecorder) {
        this.send({ type: 'clip-upload-failed', requestId });
        return;
      }
      try {
        const selection = await this.clipRecorder.select(duration);
        if (selection.segments.length === 0) throw new Error('Nenhum segmento disponível.');

        const form = new FormData();
        selection.segments.forEach((segment, i) => form.append('videos', segment.blob, `segmento-${i}.webm`));
        form.append('startOffsetMs', String(selection.startOffsetMs));
        form.append('segmentDurationsMs', JSON.stringify(selection.segments.map((s) => s.durationMs)));

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CLIP_UPLOAD_TIMEOUT_MS);
        try {
          const response = await fetch(`${this.serverUrl}/api/clips`, {
            method: 'POST',
            headers: { 'X-Clip-Request': requestId },
            body: form,
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Falha ao processar clipe (HTTP ${response.status}).`);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        console.error('Erro ao preparar clipe solicitado:', error);
        this.send({ type: 'clip-upload-failed', requestId });
      }
    }
  }

  // Prefer H.264, usually encoded by the GPU, over the default VP8 (CPU only).
  // Resolution, bitrate and frame rate are unchanged.
  function preferHardwareVideoCodec(pc) {
    const transceiver = pc.getTransceivers().find((t) => t.sender?.track?.kind === 'video');
    const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
    if (!transceiver?.setCodecPreferences || !codecs?.length) return;
    const isH264 = (c) => c.mimeType.toLowerCase() === 'video/h264';
    if (!codecs.some(isH264)) return;
    try {
      transceiver.setCodecPreferences([...codecs.filter(isH264), ...codecs.filter((c) => !isH264(c))]);
    } catch (error) {
      console.warn('Não foi possível definir preferência de codec:', error);
    }
  }

  globalScope.BroadcastSession = BroadcastSession;
})(window);

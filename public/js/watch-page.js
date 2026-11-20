// Watch page: join a room by code, receive the broadcaster's video over
// WebRTC, and ask for clips. Opening /watch.html?code=ABCD joins at once.
//
// The server is only needed to set up the connection and for clips. If it
// drops (restart, network blip, free server waking up), the video keeps
// playing and this page quietly rejoins under the same viewer id.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const RESUME_RETRY_MS = 3000;
const GIVE_UP_RESUMING_MS = 90_000;
const CLIP_TIMEOUT_MS = 240_000;

const $ = (id) => document.getElementById(id);
const joinBox = $('joinBox');
const codeInput = $('codeInput');
const joinBtn = $('joinBtn');
const errorMsg = $('errorMsg');
const serverStatus = $('serverStatus');
const remoteVideo = $('remoteVideo');
const clipBar = $('clipBar');
const clip30Btn = $('clip30Btn');
const clip60Btn = $('clip60Btn');
const clipStatus = $('clipStatus');

let ws = null;            // signaling socket
let pc = null;            // the WebRTC connection to the broadcaster
let watching = false;     // true once we joined a room
let viewerId = null;      // our id in the room, reused when resuming
let resumeStartedAt = 0;  // when we started trying to rejoin
let pendingClipRequestId = null;
let pendingClipTimeout = null;

function sendSignal(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    errorMsg.textContent = 'A conexão com o servidor foi interrompida.';
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

function broadcastEnded() {
  alert('A transmissão foi encerrada.');
  location.href = '/watch.html';
}

// ---------------------------------------------------------------- joining

async function join() {
  if (joinBtn.disabled) return;
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;
  errorMsg.textContent = '';
  joinBtn.disabled = true;
  joinBtn.textContent = 'Conectando...';

  // The free server may be asleep; wake it first.
  const awake = await ServerWake.wakeServer('', {
    onStatus: (status) => { serverStatus.textContent = ServerWake.describe(status); },
  });
  if (!awake) {
    serverStatus.textContent = '';
    errorMsg.textContent = ServerWake.describe({ state: 'offline' });
    resetJoinButton();
    return;
  }
  openSocket(code, false);
}

function resetJoinButton() {
  joinBtn.disabled = false;
  joinBtn.textContent = 'Entrar';
}

// resume=true rejoins after a dropped connection without a new negotiation.
function openSocket(code, resume) {
  const socket = new WebSocket(location.origin.replace(/^http/, 'ws'));
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return socket.close();
    socket.send(JSON.stringify(resume
      ? { type: 'join-room', code, resume: true, viewerId }
      : { type: 'join-room', code }));
  };

  socket.onmessage = (event) => handleMessage(JSON.parse(event.data), { socket, code, resume });

  socket.onerror = () => {
    if (ws === socket && !watching) errorMsg.textContent = 'Não foi possível conectar ao servidor.';
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (!watching) {
      resetJoinButton();
      return;
    }
    // Keep watching; rejoin in the background.
    if (pendingClipTimeout) {
      clipStatus.textContent = 'A conexão com o servidor caiu durante o clipe. Tente de novo.';
      finishClipRequest();
    }
    if (!resumeStartedAt) resumeStartedAt = Date.now();
    setTimeout(async () => {
      await ServerWake.wakeServer('', { maxWaitMs: GIVE_UP_RESUMING_MS });
      openSocket(code, true);
    }, 1500);
  };
}

async function handleMessage(msg, { socket, code, resume }) {
  switch (msg.type) {
    case 'error':
      if (resume && msg.code === 'not-found') {
        // The broadcaster hasn't reclaimed the room yet (e.g. the server
        // restarted). Keep trying while our video is still connected.
        socket.onclose = null;
        socket.close();
        if (Date.now() - resumeStartedAt > GIVE_UP_RESUMING_MS && pc?.connectionState !== 'connected') {
          broadcastEnded();
          return;
        }
        setTimeout(() => openSocket(code, true), RESUME_RETRY_MS);
        return;
      }
      errorMsg.textContent = msg.message;
      socket.close();
      break;

    case 'joined':
      viewerId = msg.viewerId;
      resumeStartedAt = 0;
      serverStatus.textContent = '';
      if (msg.resumed) return; // already watching
      watching = true;
      ServerWake.keepAlive('');
      joinBox.style.display = 'none';
      remoteVideo.style.display = 'block';
      createPeerConnection();
      break;

    // WebRTC setup from the broadcaster.
    case 'offer': {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer });
      break;
    }
    case 'ice-candidate':
      if (msg.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { /* stale candidate */ }
      }
      break;

    case 'broadcast-ended':
      broadcastEnded();
      break;

    // Clips.
    case 'clip-accepted':
      pendingClipRequestId = msg.requestId;
      clipStatus.textContent = 'Preparando e processando clipe...';
      break;
    case 'clip-result':
      if (pendingClipRequestId && msg.requestId !== pendingClipRequestId) return;
      clipStatus.innerHTML = `Clipe salvo! <a href="${msg.url}" target="_blank" rel="noopener">Assistir</a> · <a href="/clips.html">Ver galeria</a>`;
      finishClipRequest();
      break;
    case 'clip-error':
      if (pendingClipRequestId && msg.requestId && msg.requestId !== pendingClipRequestId) return;
      clipStatus.textContent = 'Erro: ' + msg.message;
      finishClipRequest();
      break;
    default:
      break;
  }
}

function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.ontrack = (event) => {
    // A source switch can add a track to the same stream; don't reset playback.
    const stream = event.streams[0] || new MediaStream([event.track]);
    if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
    remoteVideo.onloadedmetadata = () => { clipBar.style.display = 'block'; };
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal({ type: 'ice-candidate', candidate: event.candidate });
  };
}

// ---------------------------------------------------------------- clips

function makeClip(seconds) {
  if (pendingClipTimeout) return;
  clip30Btn.disabled = true;
  clip60Btn.disabled = true;
  clipStatus.textContent = 'Solicitando clipe...';

  if (!sendSignal({ type: 'clip-request', duration: seconds })) {
    finishClipRequest();
    return;
  }
  pendingClipTimeout = setTimeout(() => {
    clipStatus.textContent = 'O processamento demorou mais de 4 minutos e foi cancelado.';
    finishClipRequest();
  }, CLIP_TIMEOUT_MS);
}

function finishClipRequest() {
  clearTimeout(pendingClipTimeout);
  pendingClipTimeout = null;
  pendingClipRequestId = null;
  clip30Btn.disabled = false;
  clip60Btn.disabled = false;
}

// ---------------------------------------------------------------- startup

joinBtn.addEventListener('click', join);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
clip30Btn.addEventListener('click', () => makeClip(30));
clip60Btn.addEventListener('click', () => makeClip(60));

// Share links look like /watch.html?code=ABCD
const codeFromLink = new URLSearchParams(location.search).get('code');
if (codeFromLink) {
  codeInput.value = codeFromLink.toUpperCase();
  join();
}

// WebSocket signaling: rooms, and relaying WebRTC setup messages between one
// broadcaster and its viewers. The video itself never passes through here;
// it goes peer-to-peer once the two browsers have exchanged offer/answer/ICE.
//
// Messages (all JSON, field `type`):
//
//   broadcaster -> server   create-room {code?, token?}   end-room
//                           offer {target, sdp}           ice-candidate {target, candidate}
//                           clip-upload-failed {requestId}
//   server -> broadcaster   room-created {code, token, resumed}
//                           viewer-joined {viewerId}      viewer-left {viewerId}
//                           answer {from, sdp}            ice-candidate {from, candidate}
//                           clip-request {requestId, duration}
//
//   viewer -> server        join-room {code, resume?, viewerId?}
//                           answer {sdp}   ice-candidate {candidate}   clip-request {duration}
//   server -> viewer        joined {code, viewerId, resumed}   error {code, message}
//                           offer {sdp}    ice-candidate {candidate}   broadcast-ended
//                           clip-accepted / clip-result {url} / clip-error {message}
//
// Surviving connection drops: a broadcaster that loses its connection (or
// whose server restarted) reconnects with create-room {code, token} and gets
// the same room back, so the link already shared keeps working. A viewer that
// loses its connection rejoins with join-room {resume, viewerId} and keeps its
// existing video connection.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ROOM_GRACE_MS, HEARTBEAT_MS, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS } = require('./config');
const { send } = require('./send');
const { createClipRequest, getClipRequest, failClipRequest, failClipRequestsForRoom } = require('./clip-requests');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I look-alikes
const VALID_CODE = /^[A-Z2-9]{4}$/;

// code -> { broadcaster: ws|null, viewers: Map<viewerId, ws>, token, orphanTimer }
const rooms = new Map();

function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function endRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.orphanTimer);
  for (const viewer of room.viewers.values()) send(viewer, { type: 'broadcast-ended' });
  failClipRequestsForRoom(code, 'A transmissão foi encerrada.');
  rooms.delete(code);
  console.log(`room ${code} closed`);
}

// ---------------------------------------------------------------- broadcaster

function createRoom(ws, { code: wantedCode, token }) {
  const wanted = String(wantedCode || '').toUpperCase();
  const existing = rooms.get(wanted);
  let code;
  let resumed = false;

  if (existing && token && existing.token === token) {
    // Same broadcaster reconnecting: take the room back.
    clearTimeout(existing.orphanTimer);
    existing.orphanTimer = null;
    const previous = existing.broadcaster;
    existing.broadcaster = ws;
    if (previous && previous !== ws) previous.terminate();
    code = wanted;
    resumed = true;
  } else if (!existing && token && VALID_CODE.test(wanted)) {
    // The server restarted and forgot the room: recreate it with that code.
    code = wanted;
    rooms.set(code, { broadcaster: ws, viewers: new Map(), token });
    resumed = true;
  } else {
    code = newRoomCode();
    rooms.set(code, { broadcaster: ws, viewers: new Map(), token: crypto.randomBytes(16).toString('hex') });
  }

  ws.role = 'broadcaster';
  ws.code = code;
  send(ws, { type: 'room-created', code, token: rooms.get(code).token, resumed });
  console.log(`room ${code} ${resumed ? 'resumed' : 'created'}`);
}

function broadcasterDisconnected(ws, room) {
  // Not the end of the stream: give the app time to reconnect and reclaim it.
  // Clicking "Encerrar" sends end-room instead, which ends it right away.
  room.broadcaster = null;
  failClipRequestsForRoom(ws.code, 'A conexão do transmissor caiu. Tente clipar de novo.');
  room.orphanTimer = setTimeout(() => endRoom(ws.code), ROOM_GRACE_MS);
  console.log(`room ${ws.code} waiting for broadcaster`);
}

// ---------------------------------------------------------------- viewer

function joinRoom(ws, { code: rawCode, resume, viewerId: oldViewerId }) {
  const code = String(rawCode || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    send(ws, { type: 'error', code: 'not-found', message: 'Sala não encontrada. Confira o código.' });
    return;
  }

  const resuming = Boolean(resume) && typeof oldViewerId === 'string' && oldViewerId.length <= 64;
  const viewerId = resuming ? oldViewerId : crypto.randomUUID();
  const previousSocket = room.viewers.get(viewerId);

  ws.role = 'viewer';
  ws.code = code;
  ws.viewerId = viewerId;
  room.viewers.set(viewerId, ws);
  if (previousSocket && previousSocket !== ws) previousSocket.terminate();

  send(ws, { type: 'joined', code, viewerId, resumed: resuming });
  // A resuming viewer already has its video connection: no new negotiation.
  if (!resuming) send(room.broadcaster, { type: 'viewer-joined', viewerId });
}

function viewerDisconnected(ws, room) {
  // Ignore sockets that were already replaced by a resumed connection.
  if (room.viewers.get(ws.viewerId) !== ws) return;
  room.viewers.delete(ws.viewerId);
  send(room.broadcaster, { type: 'viewer-left', viewerId: ws.viewerId });
}

function requestClip(ws, room, { duration }) {
  if (!room.broadcaster) {
    send(ws, { type: 'clip-error', message: 'O transmissor está reconectando. Tente de novo em instantes.' });
    return;
  }
  const seconds = Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Number(duration) || 30));
  const requestId = createClipRequest({ viewer: ws, roomCode: ws.code, duration: seconds });
  send(ws, { type: 'clip-accepted', requestId });
  send(room.broadcaster, { type: 'clip-request', requestId, duration: seconds });
}

// ---------------------------------------------------------------- dispatch

function handleMessage(ws, msg) {
  const room = ws.code ? rooms.get(ws.code) : null;
  const isBroadcaster = ws.role === 'broadcaster' && room && room.broadcaster === ws;
  const isViewer = ws.role === 'viewer' && room;

  switch (msg.type) {
    case 'create-room':
      if (!ws.role) createRoom(ws, msg);
      break;
    case 'join-room':
      if (!ws.role) joinRoom(ws, msg);
      break;
    case 'end-room':
      if (isBroadcaster) endRoom(ws.code);
      break;

    // WebRTC setup, relayed as-is.
    case 'offer':
      if (isBroadcaster) send(room.viewers.get(msg.target), { type: 'offer', sdp: msg.sdp });
      break;
    case 'answer':
      if (isViewer) send(room.broadcaster, { type: 'answer', from: ws.viewerId, sdp: msg.sdp });
      break;
    case 'ice-candidate':
      if (isBroadcaster) send(room.viewers.get(msg.target), { type: 'ice-candidate', candidate: msg.candidate });
      else if (isViewer) send(room.broadcaster, { type: 'ice-candidate', from: ws.viewerId, candidate: msg.candidate });
      break;

    // Clips (the footage itself is uploaded over HTTP, see http.js).
    case 'clip-request':
      if (isViewer) requestClip(ws, room, msg);
      break;
    case 'clip-upload-failed': {
      const request = getClipRequest(msg.requestId);
      if (isBroadcaster && request && request.roomCode === ws.code) {
        failClipRequest(msg.requestId, 'O transmissor não conseguiu gerar o clipe.');
      }
      break;
    }
    default:
      break;
  }
}

function handleClose(ws) {
  const room = ws.code ? rooms.get(ws.code) : null;
  if (!room) return;
  if (ws.role === 'broadcaster' && room.broadcaster === ws) broadcasterDisconnected(ws, room);
  else if (ws.role === 'viewer') viewerDisconnected(ws, room);
}

// Attaches signaling to an HTTP server (same port as the website).
function attachSignaling(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.role = null; // 'broadcaster' | 'viewer', set by the first message
    ws.code = null;
    ws.viewerId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handleMessage(ws, msg);
    });
    ws.on('close', () => handleClose(ws));
  });

  // Ping everyone; drop connections that didn't answer the last ping.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

module.exports = { attachSignaling };

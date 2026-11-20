// Clip requests in flight. A viewer asks for a clip over WebSocket; the
// broadcaster later uploads the footage over HTTP with the request id; the
// result (or an error) is sent back to the viewer who asked.
const crypto = require('crypto');
const { CLIP_REQUEST_TIMEOUT_MS } = require('./config');
const { send } = require('./send');

const pending = new Map(); // requestId -> { viewer, roomCode, duration, timer }

function createClipRequest({ viewer, roomCode, duration }) {
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => failClipRequest(requestId, 'Tempo esgotado ao gerar o clipe.'), CLIP_REQUEST_TIMEOUT_MS);
  pending.set(requestId, { viewer, roomCode, duration, timer });
  return requestId;
}

function getClipRequest(requestId) {
  return pending.get(requestId);
}

function finish(requestId) {
  const request = pending.get(requestId);
  if (!request) return null;
  clearTimeout(request.timer);
  pending.delete(requestId);
  return request;
}

function completeClipRequest(requestId, url) {
  const request = finish(requestId);
  if (request) send(request.viewer, { type: 'clip-result', requestId, url });
}

function failClipRequest(requestId, message) {
  const request = finish(requestId);
  if (request) send(request.viewer, { type: 'clip-error', requestId, message });
}

function failClipRequestsForRoom(roomCode, message) {
  for (const [requestId, request] of pending) {
    if (request.roomCode === roomCode) failClipRequest(requestId, message);
  }
}

module.exports = { createClipRequest, getClipRequest, completeClipRequest, failClipRequest, failClipRequestsForRoom };

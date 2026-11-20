// The WebSocket protocol between broadcaster, server and viewers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect } = require('./helpers');

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.stop(); });

async function openRoom() {
  const broadcaster = await connect(server.wsUrl);
  broadcaster.send({ type: 'create-room' });
  const room = await broadcaster.next('room-created');
  return { broadcaster, room };
}

async function joinRoom(code) {
  const viewer = await connect(server.wsUrl);
  viewer.send({ type: 'join-room', code });
  const joined = await viewer.next('joined');
  return { viewer, joined };
}

test('health check answers', async () => {
  const res = await fetch(`${server.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('creating a room returns a 4-character code and a secret token', async () => {
  const { broadcaster, room } = await openRoom();
  assert.match(room.code, /^[A-Z2-9]{4}$/);
  assert.ok(room.token && room.token.length >= 16);
  assert.equal(room.resumed, false);
  await broadcaster.close();
});

test('joining with an unknown code fails', async () => {
  const viewer = await connect(server.wsUrl);
  viewer.send({ type: 'join-room', code: 'ZZZZ' });
  const error = await viewer.next('error');
  assert.equal(error.code, 'not-found');
  await viewer.close();
});

test('a viewer joins (code is case-insensitive) and offer/answer/ICE are relayed', async () => {
  const { broadcaster, room } = await openRoom();
  const { viewer, joined } = await joinRoom(room.code.toLowerCase());
  const { viewerId } = await broadcaster.next('viewer-joined');
  assert.equal(joined.viewerId, viewerId);

  broadcaster.send({ type: 'offer', target: viewerId, sdp: { type: 'offer', sdp: 'o' } });
  assert.equal((await viewer.next('offer')).sdp.sdp, 'o');

  viewer.send({ type: 'answer', sdp: { type: 'answer', sdp: 'a' } });
  const answer = await broadcaster.next('answer');
  assert.equal(answer.from, viewerId);
  assert.equal(answer.sdp.sdp, 'a');

  broadcaster.send({ type: 'ice-candidate', target: viewerId, candidate: { candidate: 'b' } });
  assert.equal((await viewer.next('ice-candidate')).candidate.candidate, 'b');
  viewer.send({ type: 'ice-candidate', candidate: { candidate: 'v' } });
  const ice = await broadcaster.next('ice-candidate');
  assert.equal(ice.from, viewerId);

  await viewer.close();
  assert.equal((await broadcaster.next('viewer-left')).viewerId, viewerId);
  await broadcaster.close();
});

test('end-room ends the broadcast for viewers right away', async () => {
  const { broadcaster, room } = await openRoom();
  const { viewer } = await joinRoom(room.code);
  broadcaster.send({ type: 'end-room' });
  await viewer.next('broadcast-ended', 2000);
  await viewer.close();
  await broadcaster.close();
});

test('a dropped broadcaster connection does not end the room, and the broadcaster can reclaim it', async () => {
  const { broadcaster, room } = await openRoom();
  const { viewer } = await joinRoom(room.code);
  await broadcaster.next('viewer-joined');

  await broadcaster.close(); // connection drops (no end-room)
  assert.ok(await viewer.none('broadcast-ended', 800), 'viewers must not be kicked on a drop');

  // A clip request while the broadcaster is away fails cleanly.
  viewer.send({ type: 'clip-request', duration: 30 });
  assert.match((await viewer.next('clip-error')).message, /reconectando/);

  const again = await connect(server.wsUrl);
  again.send({ type: 'create-room', code: room.code, token: room.token });
  const resumed = await again.next('room-created');
  assert.equal(resumed.code, room.code);
  assert.equal(resumed.resumed, true);

  // Relaying still reaches the existing viewer through the new connection.
  viewer.send({ type: 'answer', sdp: { type: 'answer', sdp: 'still-here' } });
  assert.equal((await again.next('answer')).sdp.sdp, 'still-here');

  again.send({ type: 'end-room' });
  await viewer.next('broadcast-ended');
  await viewer.close();
  await again.close();
});

test('the room code cannot be reclaimed with a wrong token', async () => {
  const { broadcaster, room } = await openRoom();
  const intruder = await connect(server.wsUrl);
  intruder.send({ type: 'create-room', code: room.code, token: 'wrong' });
  const other = await intruder.next('room-created');
  assert.notEqual(other.code, room.code);
  await intruder.close();
  await broadcaster.close();
});

test('after a server restart the broadcaster recreates the same code with its token', async () => {
  const fresh = await startServer();
  try {
    const b = await connect(fresh.wsUrl);
    b.send({ type: 'create-room', code: 'AB2C', token: 'token-from-before-restart' });
    const room = await b.next('room-created');
    assert.equal(room.code, 'AB2C');
    assert.equal(room.resumed, true);
    await b.close();
  } finally {
    await fresh.stop();
  }
});

test('a viewer whose connection dropped resumes without a new negotiation', async () => {
  const { broadcaster, room } = await openRoom();
  const { viewer, joined } = await joinRoom(room.code);
  await broadcaster.next('viewer-joined');

  const back = await connect(server.wsUrl);
  back.send({ type: 'join-room', code: room.code, resume: true, viewerId: joined.viewerId });
  const rejoined = await back.next('joined');
  assert.equal(rejoined.viewerId, joined.viewerId);
  assert.equal(rejoined.resumed, true);
  assert.ok(await broadcaster.none('viewer-joined', 500), 'no renegotiation for a resumed viewer');

  // The superseded old socket closing must not report the viewer as gone.
  await viewer.close();
  assert.ok(await broadcaster.none('viewer-left', 500));

  broadcaster.send({ type: 'offer', target: joined.viewerId, sdp: { type: 'offer', sdp: 'to-new-socket' } });
  assert.equal((await back.next('offer')).sdp.sdp, 'to-new-socket');

  broadcaster.send({ type: 'end-room' });
  await back.next('broadcast-ended');
  await back.close();
  await broadcaster.close();
});

test('clip requests are routed to the broadcaster, and failures reach the viewer', async () => {
  const { broadcaster, room } = await openRoom();
  const { viewer } = await joinRoom(room.code);
  await broadcaster.next('viewer-joined');

  viewer.send({ type: 'clip-request', duration: 999 });
  const accepted = await viewer.next('clip-accepted');
  const request = await broadcaster.next('clip-request');
  assert.equal(request.requestId, accepted.requestId);
  assert.equal(request.duration, 60, 'duration is capped at 60s');

  broadcaster.send({ type: 'clip-upload-failed', requestId: request.requestId });
  const error = await viewer.next('clip-error');
  assert.equal(error.requestId, request.requestId);

  broadcaster.send({ type: 'end-room' });
  await viewer.close();
  await broadcaster.close();
});

test('the clips API answers with CORS headers for the desktop app', async () => {
  const preflight = await fetch(`${server.base}/api/clips`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Clip-Request/);
  const list = await fetch(`${server.base}/api/clips?limit=3`);
  assert.deepEqual(await list.json(), { clips: [] });
});

test('uploading for an unknown clip request is rejected', async () => {
  const form = new FormData();
  form.append('videos', new Blob(['x']), 'a.webm');
  const res = await fetch(`${server.base}/api/clips`, { method: 'POST', headers: { 'X-Clip-Request': 'nope' }, body: form });
  assert.equal(res.status, 404);
});

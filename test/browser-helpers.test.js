// Unit tests for the small browser scripts that also run in Node.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { freePort } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const { selectClipSegments } = require(path.join(PUBLIC, 'clip-buffer.js'));
const ServerWake = require(path.join(PUBLIC, 'server-wake.js'));

test('selectClipSegments picks the newest segments covering the wanted length', () => {
  const segments = [1, 2, 3, 4].map((n) => ({ n, durationMs: 5000 }));
  const pick = selectClipSegments(segments, 12_000);
  assert.deepEqual(pick.segments.map((s) => s.n), [2, 3, 4]);
  assert.equal(pick.selectedDurationMs, 15_000);
  assert.equal(pick.startOffsetMs, 3000);
});

test('selectClipSegments returns everything when the buffer is shorter than asked', () => {
  const pick = selectClipSegments([{ durationMs: 4000 }], 30_000);
  assert.equal(pick.segments.length, 1);
  assert.equal(pick.startOffsetMs, 0);
});

test('wakeServer returns at once for a server that is up', async () => {
  const port = await freePort();
  const srv = http.createServer((_q, r) => r.end('ok')).listen(port);
  const states = [];
  try {
    assert.equal(await ServerWake.wakeServer(`http://localhost:${port}`, { onStatus: (s) => states.push(s.state) }), true);
    assert.deepEqual(states, ['checking', 'online']);
  } finally { srv.close(); }
});

test('wakeServer waits through a slow (Render-style) cold start', async () => {
  const port = await freePort();
  const readyAt = Date.now() + 5000;
  const srv = http.createServer((_q, r) => setTimeout(() => r.end('ok'), Math.max(0, readyAt - Date.now()))).listen(port);
  const states = [];
  try {
    assert.equal(await ServerWake.wakeServer(`http://localhost:${port}`, { onStatus: (s) => states.push(s.state) }), true);
    assert.ok(states.includes('waking'));
    assert.equal(states.at(-1), 'online');
  } finally { srv.close(); }
});

test('wakeServer gives up after maxWaitMs when nothing answers', async () => {
  const port = await freePort();
  const states = [];
  const ok = await ServerWake.wakeServer(`http://localhost:${port}`, { onStatus: (s) => states.push(s.state), maxWaitMs: 3000 });
  assert.equal(ok, false);
  assert.equal(states.at(-1), 'offline');
});

test('describe() gives Portuguese status text', () => {
  assert.match(ServerWake.describe({ state: 'waking', elapsed: 7 }), /acordando \(7s/);
  assert.equal(ServerWake.describe({ state: 'online' }), '');
});

// -----------------------------------------------------------------------------
// The WebSocket session against hostile or broken peers, on real loopback
// sockets: not a Roon Core, oversized frames, answers to nothing, silence.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { blackhole, refusePort, testClock } from './kit/index.mjs';
import { EXTENSION, TIMINGS } from '../src/constants.js';
import { RoonSession } from '../src/roon/session.js';
import { fakeCore, mooMessage } from './helpers/fakeCore.js';
import { until } from './helpers/app.js';

function session(port, options = {}) {
  const s = new RoonSession({ host: '127.0.0.1', port, extension: EXTENSION, ...options });
  const events = [];
  for (const name of ['info', 'registered', 'zones', 'outputs', 'closed']) {
    s.on(name, (...args) => events.push([name, ...args]));
  }
  s.events = events;
  s.start();
  return s;
}

const closedWith = (s) => until(() => s.error, 'the session end').then(() => s.error.code);

/** A WebSocket server answering every frame with `reply(frame, ws)`. */
async function rawServer(reply, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api', ...options });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (ws) => ws.on('message', (data) => reply(Buffer.from(data), ws)));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('handshake with a Core: info, register, both subscriptions, the Core ping answered', async (t) => {
  const core = await fakeCore();
  t.after(() => core.close());
  const s = session(core.port, { getToken: () => undefined });
  t.after(() => s.close());
  await until(() => s.events.some(([n]) => n === 'outputs'), 'subscriptions');
  assert.deepEqual(
    s.events.map(([name]) => name),
    ['info', 'registered', 'zones', 'outputs'],
  );
  assert.equal(s.registered.token, core.token);
  const answer = await core.ask('com.roonlabs.ping:1', 'ping');
  assert.equal(answer.name, 'Success');
  const status = await core.ask('com.roonlabs.status:1', 'get_status');
  assert.equal(status.name, 'Success');
  const unknown = await core.ask('com.example:1', 'x');
  assert.equal(unknown.name, 'InvalidRequest');
});

test('nothing listening, a silent socket, an HTTP server: never a session', async (t) => {
  const refused = await refusePort();
  assert.equal(await closedWith(session(refused.port)), 'unreachable');
  const http = createServer((req, res) => res.end('hello'));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.close());
  assert.equal(await closedWith(session(http.address().port)), 'protocol');
  const hole = await blackhole();
  t.after(() => hole.close());
  const clock = testClock();
  const silent = session(hole.port, { timers: clock.timers, monotonic: clock.monotonic });
  t.after(() => silent.close());
  // The WebSocket handshake has its own deadline (ws handshakeTimeout).
  assert.equal(
    await until(() => silent.error, 'handshake timeout', TIMINGS.CONNECT + 3000).then(
      () => silent.error.code,
    ),
    'unreachable',
  );
});

test('a frame that is not MOO, an answer to nothing asked: the session ends', async (t) => {
  const garbage = await rawServer((frame, ws) => ws.send(Buffer.from('HTTP/1.1 200 OK\n\n')));
  t.after(() => garbage.close());
  assert.equal(await closedWith(session(garbage.port)), 'protocol');
  const stranger = await rawServer((frame, ws) =>
    ws.send(mooMessage('COMPLETE', 'Success', 999, {})),
  );
  t.after(() => stranger.close());
  assert.equal(await closedWith(session(stranger.port)), 'protocol');
  const noCore = await rawServer((frame, ws) =>
    ws.send(mooMessage('COMPLETE', 'Success', 0, { core_id: 'bad id!' })),
  );
  t.after(() => noCore.close());
  assert.equal(await closedWith(session(noCore.port)), 'protocol');
});

test('a frame over 1 MiB is cut by ws before it is read whole', async (t) => {
  const big = await rawServer((frame, ws) => ws.send(Buffer.alloc(2 * 1024 * 1024, 0x41)));
  t.after(() => big.close());
  assert.equal(await closedWith(session(big.port)), 'protocol');
});

test('silence after the handshake: closed by the keepalive (no pong, no message for 20 s)', async (t) => {
  const core = await fakeCore();
  t.after(() => core.close());
  const clock = testClock();
  const s = session(core.port, { timers: clock.timers, monotonic: clock.monotonic });
  t.after(() => s.close());
  await until(() => s.events.some(([n]) => n === 'outputs'));
  // Pongs answered: alive.
  await clock.advance(TIMINGS.KEEPALIVE);
  await until(() => true);
  assert.equal(s.error, undefined);
  // The Core stops answering pongs (paused socket): ended after two periods.
  for (const client of core.clients) client.ws.pause();
  for (const client of core.clients) client.ws._socket.pause();
  await clock.advance(3 * TIMINGS.KEEPALIVE);
  assert.equal(s.error?.code, 'timeout');
});

test('a command without answer: rejected after its time, the session goes on; sent flag set', async (t) => {
  const core = await fakeCore();
  t.after(() => core.close());
  const clock = testClock();
  const s = session(core.port, { timers: clock.timers, monotonic: clock.monotonic });
  t.after(() => s.close());
  await until(() => s.events.some(([n]) => n === 'outputs'));
  core.silent.add('control');
  const pending = s
    .command('control', { zone_or_output_id: 'o1', control: 'pause' }, 1000)
    .catch((e) => e);
  await until(() => core.commands('control').length === 1);
  await clock.advance(1000);
  const err = await pending;
  assert.equal(err.code, 'timeout');
  assert.equal(err.sent, true);
  assert.equal(s.alive, true);
  // Closed with a request on the wire: rejected as sent.
  const lost = s
    .command('control', { zone_or_output_id: 'o1', control: 'pause' }, 5000)
    .catch((e) => e);
  await until(() => core.commands('control').length === 2);
  core.dropAll();
  assert.equal((await lost).sent, true);
  // Nothing goes once closed.
  await assert.rejects(s.command('control', {}), (err) => err.code === 'closed' && !err.sent);
});

test('the extension disabled in Roon (a later register answer): the session ends', async (t) => {
  const server = await rawServer((frame, ws) => {
    const text = frame.toString();
    const id = Number(/Request-Id: (\d+)/.exec(text)[1]);
    if (text.includes('registry:1/info'))
      ws.send(mooMessage('COMPLETE', 'Success', id, { core_id: 'c1' }));
    if (text.includes('registry:1/register')) {
      ws.send(mooMessage('CONTINUE', 'Registered', id, { core_id: 'c1', token: 't' }));
      setTimeout(() => ws.send(mooMessage('COMPLETE', 'Unregistered', id, {})), 50);
    }
    if (text.includes('subscribe_')) ws.send(mooMessage('CONTINUE', 'Subscribed', id, {}));
  });
  t.after(() => server.close());
  const s = session(server.port);
  assert.equal(await closedWith(s), 'not_registered');
  assert.ok(s.events.some(([n]) => n === 'registered'));
});

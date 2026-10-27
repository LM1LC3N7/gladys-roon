// -----------------------------------------------------------------------------
// The guards the review r1 found without a test (each one fails here when it
// is removed), and the fixes of r1: the backoff kept by `connected`, the
// homonyms silenced together, swapped names, the identity of the extension.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RoonApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryLogger, testClock } from './kit/index.mjs';
import { TIMINGS } from '../src/constants.js';
import { E } from '../src/i18n.js';
import { RoonSession } from '../src/roon/session.js';
import { createMemoryStore } from '../src/store.js';
import { EXTENSION } from '../src/constants.js';
import { created, setup, until } from './helpers/app.js';
import { JPEG, TRACK, fakeCore, makeOutput, mooMessage, volume } from './helpers/fakeCore.js';
import { buildAnswer } from './helpers/sood.js';

const LIVING = 'Living room';
const KITCHEN = 'Kitchen';
const config = (core, extra = {}) => ({
  host: '127.0.0.1',
  port: core.port,
  max_volume: 50,
  ...extra,
});
const set = (env, device, key, value) =>
  env.gladys.fake.setValue(device, env.feature(device, key), value);

// --- I1: the backoff ----------------------------------------------------------------

test('Core down: connected events and an unchanged form never connect sooner', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  await env.core.close();
  await until(() => !env.app.current && env.app.retryTimer !== undefined, 'backoff');
  await env.app.idle();
  const message = env.status().message.en;
  for (let i = 0; i < 5; i += 1) {
    await env.app.connected(() => env.gladys.getConfig());
    await env.app.idle();
  }
  await env.app.configUpdated({ ...env.gladys.fake.config, max_volume: 30 });
  assert.equal(env.app.retryTimer !== undefined, true, 'the backoff still runs');
  assert.equal(env.status().message.en, message, 'the status of the backoff is kept');
  assert.equal(env.app.retryDelay, 2 * TIMINGS.RETRY_MIN, 'not reset');
  assert.equal(env.app.current, undefined, 'no session opened');
});

// --- I3: one socket, generations ------------------------------------------------------

test('three forms saved back to back on two Cores: one socket at the end', async (t) => {
  const a = await fakeCore();
  const env = await setup();
  t.after(async () => {
    await env.close();
    await a.close();
  });
  await env.ready();
  const b = env.core;
  await Promise.all([
    env.app.configUpdated(config(a)),
    env.app.configUpdated(config(b)),
    env.app.configUpdated(config(a)),
  ]);
  await env.ready();
  await until(() => a.open + b.open === 1, 'one socket open', 2000);
  assert.equal(a.open, 1);
  assert.equal(env.app.config.port, a.port);
});

test('an old session never acts after a new one: no retry, no status, no state', async (t) => {
  const a = await fakeCore();
  const env = await setup({ devices: [created(LIVING)] });
  t.after(async () => {
    await env.close();
    await a.close();
  });
  await env.ready();
  const b = env.core;
  await env.app.configUpdated(config(a));
  await env.ready();
  // The old Core keeps talking: nothing reaches the app.
  b.pushZones();
  await env.clock.advance(5 * TIMINGS.RETRY_MAX);
  await env.app.idle();
  assert.equal(b.connections, 1, 'never a new try to the old Core');
  assert.equal(a.connections, 1);
  assert.equal(env.status().connected, true);
  assert.equal(env.app.retryTimer, undefined);
});

test('getConfig failing three times: tried at 5, 10 and 20 s; a form saved meanwhile wins', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('down');
  };
  await env.app.connected(failing);
  await env.app.idle();
  for (const [wait, expected] of [
    [TIMINGS.CONFIG_RETRY_MIN - 1, 1],
    [1, 2],
    [2 * TIMINGS.CONFIG_RETRY_MIN - 1, 2],
    [1, 3],
    [4 * TIMINGS.CONFIG_RETRY_MIN - 1, 3],
    [1, 4],
  ]) {
    await env.clock.advance(wait);
    await env.app.idle();
    assert.equal(calls, expected);
  }
  assert.match(env.status().message.en, /tried again in 40 s/);
  await env.app.configUpdated(config(env.core));
  await env.clock.advance(TIMINGS.CONFIG_RETRY_MAX);
  await env.app.idle();
  assert.equal(calls, 4, 'no more getConfig after the form');
  await env.ready();
  assert.equal(env.status().connected, true);
});

// --- I3: resolve ------------------------------------------------------------------------

test('resolve: nothing sent before the picture, nor on a closing socket', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device], core: { authorized: false } });
  t.after(() => env.close());
  await until(() => env.app.current?.core, 'info');
  const before = await set(env, device, 'pause', 1);
  assert.equal(before.error, E.notConnected, 'registered or not, no picture yet');
  env.core.authorize();
  await env.ready();
  const sent = env.core.requests.length;
  env.app.current.alive = false;
  assert.equal((await set(env, device, 'pause', 1)).error, E.notConnected);
  env.app.current.alive = true;
  env.app.current.session.ws.close();
  assert.equal((await set(env, device, 'pause', 1)).error, E.notConnected);
  assert.equal(env.core.requests.length, sent);
});

test('a command waiting for its state ends at once when the Core drops', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  await env.ready();
  env.core.never = true;
  const play = set(env, device, 'play', 1);
  await until(() => env.core.commands('control').length === 1);
  await until(() => env.app.waiters.size === 1);
  env.core.dropAll();
  const ack = await play; // no clock advanced: ended by the loss
  assert.equal(ack.error, E.notConfirmed);
});

test('the zone text and a seek without a track: nothing sent', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  await env.ready();
  assert.equal((await set(env, device, 'zone', 'x')).error, E.unknownFeature);
  assert.equal((await set(env, device, 'position', 10)).error, E.noTrack);
  assert.equal(env.core.commands('seek').length, 0);
});

test('the same status twice is sent once', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const count = env.gladys.fake.connectionStatuses.length;
  env.app.reportConnected();
  env.app.reportConnected();
  await env.app.idle();
  assert.equal(env.gladys.fake.connectionStatuses.length, count);
});

// --- I3: unmute -----------------------------------------------------------------------------

test('unmute above the cap with 64 requests waiting: the lowering still goes first', async (t) => {
  const device = created(LIVING);
  const env = await setup({
    devices: [device],
    core: { outputs: [makeOutput('o1', LIVING, { volume: volume(80, { is_muted: true }) })] },
  });
  t.after(() => env.close());
  await env.ready();
  env.core.silent.add('control');
  const fill = 64 - env.app.current.session.pending.size;
  const stuck = Array.from({ length: fill }, () => set(env, device, 'play', 1));
  await until(() => env.core.commands('control').length === fill);
  const unmute = await set(env, device, 'mute', 0);
  assert.equal(env.core.commands('change_volume').at(-1)?.value, 50, 'lowered to the cap');
  assert.equal(unmute.error, E.busy, 'the unmute itself waits like any command');
  assert.equal(env.core.commands('mute').length, 0);
  await env.clock.advance(TIMINGS.COMMAND);
  await Promise.all(stuck);
});

// --- I3: artwork ---------------------------------------------------------------------------

test('artwork: only our keys, a valid image key, at most 300 KB', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  const zone = env.core.zoneOf('o1');
  zone.state = 'playing';
  zone.now_playing = structuredClone(TRACK);
  await env.ready();
  const key = env.last(LIVING, 'artwork');
  const images = () => env.core.requests.filter((r) => r.name.endsWith('get_image')).length;
  assert.equal((await env.gladys.fake.musicGetArtwork(key)).success, true);
  // A JPEG over 300 KB: refused.
  env.core.image = Buffer.concat([JPEG, Buffer.alloc(301 * 1024)]);
  assert.equal((await env.gladys.fake.musicGetArtwork(key)).success, false);
  env.core.image = Buffer.concat([JPEG, Buffer.alloc(290 * 1024)]);
  assert.equal((await env.gladys.fake.musicGetArtwork(key)).success, true);
  const sent = images();
  // A URL recorded by someone else, or a bad image key: never asked to the Core.
  // Its tail after 11 characters is a valid image key: only the prefix refuses it.
  env.gladys.artworkUrls.set('art-111111111111', 'https://ab.ca1b2c3d4e5');
  env.gladys.artworkUrls.set('art-222222222222', 'roon-image:../bad key');
  for (const other of ['art-111111111111', 'art-222222222222']) {
    assert.equal((await env.gladys.fake.musicGetArtwork(other)).success, false);
  }
  assert.equal(images(), sent);
});

// --- I3: the session ------------------------------------------------------------------------

async function rawCore(onFrame) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api' });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (ws) =>
    ws.on('message', (data) => {
      const text = Buffer.from(data).toString();
      onFrame(text, Number(/Request-Id: (\d+)/.exec(text)[1]), ws);
    }),
  );
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function open(port) {
  const s = new RoonSession({ host: '127.0.0.1', port, extension: EXTENSION });
  s.events = [];
  for (const name of ['info', 'registered', 'closed']) s.on(name, () => s.events.push(name));
  s.start();
  return s;
}

test('a valid MOO answer of 1.5 MiB is cut by maxPayload before it is read', async (t) => {
  const server = await rawCore((text, id, ws) => {
    if (text.includes('registry:1/info')) {
      ws.send(
        mooMessage('COMPLETE', 'Success', id, { core_id: 'c1', pad: 'a'.repeat(1536 * 1024) }),
      );
    }
  });
  t.after(() => server.close());
  const s = open(server.port);
  t.after(() => s.close());
  await until(() => s.error, 'the end');
  assert.equal(s.error.code, 'protocol');
  assert.ok(!s.events.includes('info'), 'never read');
});

test('Registered for another core_id than the info: the session ends', async (t) => {
  const server = await rawCore((text, id, ws) => {
    if (text.includes('registry:1/info'))
      ws.send(mooMessage('COMPLETE', 'Success', id, { core_id: 'c1' }));
    if (text.includes('registry:1/register')) {
      ws.send(mooMessage('COMPLETE', 'Registered', id, { core_id: 'c2', token: 't' }));
    }
  });
  t.after(() => server.close());
  const s = open(server.port);
  t.after(() => s.close());
  await until(() => s.error, 'the end');
  assert.equal(s.error.code, 'protocol');
  assert.ok(!s.events.includes('registered'));
});

test('the name of the Core is cleaned before logs and statuses', async (t) => {
  const env = await setup({ core: { name: 'Evil\n\u001b[31mCore' } });
  t.after(() => env.close());
  await env.ready();
  const control = (text) => [...text].some((c) => c.charCodeAt(0) < 0x20);
  assert.ok(!control(env.status().message.en));
  assert.ok(!env.logger.lines.some(control));
});

// --- I2: homonyms -------------------------------------------------------------------------

test('two outputs of one name: pause, stop, mute and a lower volume go to both', async (t) => {
  const device = created(KITCHEN);
  const env = await setup({
    devices: [device],
    core: {
      outputs: [
        makeOutput('o1', KITCHEN, { volume: volume(40) }),
        makeOutput('o2', KITCHEN, { volume: volume(10) }),
      ],
    },
  });
  t.after(() => env.close());
  for (const id of ['o1', 'o2']) env.core.zoneOf(id).state = 'playing';
  await env.ready();
  assert.deepEqual(await set(env, device, 'pause', 1), { success: true });
  assert.deepEqual(
    env.core
      .commands('control')
      .map((b) => b.zone_or_output_id)
      .sort(),
    ['o1', 'o2'],
  );
  assert.deepEqual(await set(env, device, 'playback_state', 2), { success: true });
  assert.deepEqual(await set(env, device, 'mute', 1), { success: true });
  assert.deepEqual(
    env.core
      .commands('mute')
      .map((b) => b.output_id)
      .sort(),
    ['o1', 'o2'],
  );
  // 20 %: lowers o1 (40), would raise o2 (10): only o1.
  assert.deepEqual(await set(env, device, 'volume', 20), { success: true });
  assert.deepEqual(env.core.commands('change_volume'), [
    { output_id: 'o1', how: 'absolute', value: 20 },
  ]);
  for (const [key, value] of [
    ['play', 1],
    ['playback_state', 1],
    ['mute', 0],
    ['volume', 90],
    ['next', 1],
  ]) {
    assert.equal((await set(env, device, key, value)).error, E.twoOutputs, `${key}=${value}`);
  }
  // Never published as one, never shown "local".
  await env.flush();
  assert.equal(env.last(KITCHEN, 'playback_state'), undefined);
  assert.equal(env.gladys.fake.transports.at(-1)?.transport, 'unreachable');
});

// --- M1: swapped names ---------------------------------------------------------------------

test('names swapped in Roon: the volume never goes to the other room', async (t) => {
  const living = created(LIVING);
  const store = createMemoryStore();
  const env = await setup({ devices: [living, created(KITCHEN)], store });
  t.after(() => env.close());
  await env.ready();
  assert.equal(store.data.outputs[living.external_id.split(':').at(-1)], 'o1', 'id kept in /data');
  const o1 = env.core.output('o1');
  const o2 = env.core.output('o2');
  o1.display_name = KITCHEN;
  o2.display_name = LIVING;
  env.core.pushOutputs(['o1', 'o2']);
  env.core.pushZones();
  await until(() => env.app.current.roon.outputs.get('o1').name === KITCHEN);
  const statesBefore = env.gladys.fake.states.length;
  await env.flush();
  assert.equal(env.gladys.fake.states.length, statesBefore, 'nothing published while swapped');
  assert.equal((await set(env, living, 'volume', 45)).error, E.swapped);
  assert.equal(env.core.commands('change_volume').length, 0);
  // Pause and mute go to the room the device was made for (o1, now "Kitchen").
  assert.deepEqual(await set(env, living, 'mute', 1), { success: true });
  assert.deepEqual(env.core.commands('mute').at(-1).output_id, 'o1');
  assert.equal(
    (await env.gladys.fake.sceneAction('ungroup', { device: living.external_id })).error,
    E.swapped,
  );
  // A Discovery takes the new names.
  await env.gladys.fake.scanRequest();
  assert.deepEqual(await set(env, living, 'volume', 20), { success: true });
  assert.equal(env.core.commands('change_volume').at(-1).output_id, 'o2');
});

// --- Buttons -----------------------------------------------------------------------------

test('Find the Roon Core never overwrites a typed address', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  env.gladys.fake.scanResults['udp-active-broadcast'] = [
    { source_ip: '192.168.1.40', source_port: 9003, payload_base64: buildAnswer({ port: 9330 }) },
  ];
  const ack = await env.gladys.fake.action('find_core');
  assert.match(ack.data.message.en, /type the address of yours/);
  assert.equal(env.gladys.fake.config.host, '127.0.0.1');
  assert.equal(env.app.config.host, '127.0.0.1');
  assert.equal(env.core.connections, 1);
});

test('Forget the Roon authorization writes /data without the token, then registers anew', async (t) => {
  const store = createMemoryStore({ tokens: { 'core-1': 'tok-secret-123' } });
  const env = await setup({ store });
  t.after(() => env.close());
  await env.ready();
  env.core.authorized = false;
  const ack = await env.gladys.fake.action('forget_authorization');
  assert.equal(ack.success, true);
  assert.deepEqual(store.data.tokens, {});
  await until(() => env.core.registers.length === 2);
  assert.equal(env.core.registers.at(-1).token, undefined);
});

// --- I3: generation guards, with sessions driven by hand -------------------------------

class HandSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.alive = true;
    this.closed = Promise.resolve();
  }

  start() {}

  close() {
    this.alive = false;
    return this.closed;
  }
}

async function handApp(devices = []) {
  const gladys = createFakeGladys({ selector: 'roon', config: {}, devices });
  await gladys.connect();
  const clock = testClock();
  const sessions = [];
  const store = createMemoryStore();
  const logger = memoryLogger();
  const app = new RoonApp({
    gladys,
    logger,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    sessionFactory: (options) => {
      const session = new HandSession(options);
      sessions.push(session);
      return session;
    },
  });
  registerHandlers(gladys, app, memoryLogger());
  const picture = (session, outputs) => {
    session.emit('info', { coreId: 'c1', name: 'Core', version: '' });
    session.emit('registered', { coreId: 'c1', name: 'Core', version: '', token: 'tok-1' });
    session.emit('zones', 'Subscribed', {
      zones: outputs.map((o) => ({
        zone_id: o.zone_id,
        display_name: o.display_name,
        outputs: [o],
        state: 'playing',
      })),
    });
    session.emit('outputs', 'Subscribed', { outputs });
  };
  return { gladys, clock, app, sessions, store, picture, logger };
}

test('events of an old session after a new one: ignored, one by one', async () => {
  const { gladys, clock, app, sessions, store, picture } = await handApp([created(LIVING)]);
  await app.start({ host: '10.0.0.1' });
  await app.start({ host: '10.0.0.2' });
  const [old, now] = sessions;
  picture(now, [makeOutput('o1', LIVING)]);
  await clock.advance(TIMINGS.FLUSH);
  await app.idle();
  const statuses = gladys.fake.connectionStatuses.length;
  const states = gladys.fake.states.length;
  // The old one speaks: info (no waiting status), registered (no token saved),
  // zones / outputs (no picture), closed (no retry, no status).
  old.emit('info', { coreId: 'c9', name: 'Old', version: '' });
  old.emit('registered', { coreId: 'c9', name: 'Old', version: '', token: 'tok-old' });
  old.emit('zones', 'Changed', { zones_removed: ['z-o1'] });
  old.emit('outputs', 'Changed', { outputs_removed: ['o1'] });
  old.emit('closed', { code: 'closed' });
  await clock.advance(5 * TIMINGS.RETRY_MAX);
  await app.idle();
  assert.equal(sessions.length, 2, 'no retry opened');
  assert.equal(gladys.fake.connectionStatuses.length, statuses, 'no status');
  assert.equal(gladys.fake.states.length, states, 'no state');
  assert.ok(app.current.roon.outputs.has('o1'), 'the picture of the new one kept');
  assert.equal(store.data.tokens?.c9, undefined, 'no token of the old one');
});

test('a retry timer that fires while another session runs opens nothing', async () => {
  const { clock, app, sessions } = await handApp();
  await app.start({ host: '10.0.0.1' });
  sessions[0].emit('closed', { code: 'unreachable' });
  // A session appears without the timer being cleared (any future path).
  app.current = { session: new HandSession({}), roon: { outputs: new Map() } };
  await clock.advance(TIMINGS.RETRY_MIN);
  assert.equal(sessions.length, 1);
  app.current = undefined;
  app.generation += 1;
  await clock.advance(2 * TIMINGS.RETRY_MIN);
  assert.equal(sessions.length, 1, 'nor after another generation');
});

test('a flush stops when its session is lost in the middle', async () => {
  const devices = [created('A'), created('B')];
  const { gladys, clock, app, sessions, picture } = await handApp(devices);
  await app.start({ host: '10.0.0.1' });
  const original = gladys.publishNowPlaying.bind(gladys);
  let calls = 0;
  gladys.publishNowPlaying = async (...args) => {
    calls += 1;
    if (calls === 1) app.current.alive = false; // lost while the first one is published
    return original(...args);
  };
  picture(sessions[0], [makeOutput('o1', 'A'), makeOutput('o2', 'B')]);
  await clock.advance(TIMINGS.FLUSH);
  await app.idle();
  assert.equal(calls, 1, 'the second output is not published from a dead session');
});

// --- I3: getConfig and a form saved meanwhile -----------------------------------------------

test('getConfig failing after a form was saved: no status, no retry', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  let calls = 0;
  let reject;
  const slow = () => {
    calls += 1;
    return new Promise((_, r) => {
      reject = r;
    });
  };
  const run = env.app.connected(slow);
  await env.app.configUpdated(config(env.core));
  reject(new Error('late'));
  await run;
  await env.clock.advance(TIMINGS.CONFIG_RETRY_MAX);
  await env.app.idle();
  assert.equal(calls, 1);
  assert.ok(
    !env.gladys.fake.connectionStatuses.some((st) => /could not be read/.test(st.message?.en)),
  );
});

test('a form saved while the failure status is sent: no retry of getConfig', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  let calls = 0;
  const original = env.gladys.setConnectionStatus.bind(env.gladys);
  env.gladys.setConnectionStatus = async (ok, message) => {
    if (/could not be read/.test(message?.en ?? '')) env.app.configUpdated(config(env.core));
    return original(ok, message);
  };
  await env.app.connected(async () => {
    calls += 1;
    throw new Error('down');
  });
  await env.app.idle();
  await env.clock.advance(TIMINGS.CONFIG_RETRY_MAX);
  await env.app.idle();
  assert.equal(calls, 1);
});

test('an old session: no timer for its info, no picture completed by its last list', async () => {
  for (const [first, last] of [
    ['outputs', 'zones'],
    ['zones', 'outputs'],
  ]) {
    const { clock, app, sessions, logger } = await handApp();
    await app.start({ host: '10.0.0.1' });
    const [old] = sessions;
    const lists = { zones: { zones: [] }, outputs: { outputs: [] } };
    old.emit(first, 'Subscribed', lists[first]);
    await app.start({ host: '10.0.0.2' });
    const timers = clock.pending;
    old.emit('info', { coreId: 'c9', name: 'Old', version: '' });
    assert.equal(clock.pending, timers, 'no waiting timer for the old session');
    old.emit(last, 'Subscribed', lists[last]);
    assert.ok(
      !logger.lines.some((l) => /connected to/.test(l)),
      `old ${last} completing a picture`,
    );
    assert.equal(sessions[1].listenerCount('zones'), 1);
  }
});

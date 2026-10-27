// -----------------------------------------------------------------------------
// The app end to end: fake Gladys (SDK), fake Roon Core over a real loopback
// WebSocket, virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { E } from '../src/i18n.js';
import { createMemoryStore } from '../src/store.js';
import { TRACK, makeOutput, volume } from './helpers/fakeCore.js';
import { created, setup, until } from './helpers/app.js';

const LIVING = 'Living room';
const KITCHEN = 'Kitchen';

test('authorized Core: discovery of every output, states of the created ones, status connected', async (t) => {
  const env = await setup({ devices: [created(LIVING)] });
  t.after(() => env.close());
  await env.ready();
  const { gladys, core } = env;
  assert.deepEqual(gladys.fake.discoveredDevices.map((d) => d.name).sort(), [KITCHEN, LIVING]);
  assert.equal(env.status().connected, true);
  assert.match(env.status().message.en, /Roon Server 2\.0 \(build 1500\): 2 output/);
  assert.equal(env.last(LIVING, 'playback_state'), 2, 'stopped = IDLE');
  assert.equal(env.last(LIVING, 'volume'), 30);
  assert.equal(env.last(LIVING, 'mute'), 0);
  assert.equal(env.last(LIVING, 'zone'), LIVING);
  assert.equal(env.last(KITCHEN, 'volume'), undefined, 'not created: nothing published');
  // The token is kept in /data, and never in a log line.
  assert.deepEqual(env.store.data.tokens, { 'core-1': core.token });
  assert.ok(!env.logger.lines.join('\n').includes(core.token));
  assert.ok(!JSON.stringify(gladys.fake.connectionStatuses).includes(core.token));
  // The extension id is Gladys's own.
  assert.equal(core.registers[0].extension_id, 'com.gladysassistant.roon');
  assert.equal(core.registers[0].token, undefined, 'no token known yet');
});

test('not authorized: waiting status, no states; enabled in Roon: connected, token saved', async (t) => {
  const env = await setup({ core: { authorized: false }, devices: [created(LIVING)] });
  t.after(() => env.close());
  await until(() => env.app.current?.core, 'registry info');
  await env.clock.advance(2000);
  await env.app.idle();
  assert.equal(env.status().connected, false);
  assert.match(
    env.status().message.en,
    /waiting for the authorization: in Roon, open Settings > Extensions/,
  );
  assert.equal(env.gladys.fake.states.length, 0);
  // A device created meanwhile: still nothing (no picture yet, never a guess).
  await env.gladys.fake.deviceCreated(created(LIVING));
  await env.flush();
  assert.equal(env.gladys.fake.states.length, 0);
  env.core.authorize();
  await env.ready();
  assert.equal(env.status().connected, true);
  assert.deepEqual(env.store.data.tokens, { 'core-1': env.core.token });
});

test('a known token is sent at register, never logged', async (t) => {
  const store = createMemoryStore({ tokens: { 'core-1': 'tok-secret-123' } });
  const env = await setup({ core: { authorized: false }, store });
  t.after(() => env.close());
  await env.ready();
  assert.equal(env.core.registers[0].token, 'tok-secret-123');
  assert.ok(!env.logger.lines.join('\n').includes('tok-secret-123'));
});

test('now playing: title, artist, album, artwork key, duration, position, shuffle, repeat', async (t) => {
  const env = await setup({ devices: [created(LIVING)] });
  t.after(() => env.close());
  await env.ready();
  const zone = env.core.zoneOf('o1');
  zone.state = 'playing';
  zone.now_playing = structuredClone(TRACK);
  zone.settings = { loop: 'loop_one', shuffle: true };
  env.core.pushZones([zone.zone_id]);
  await until(() => env.app.current.roon.zones.get(zone.zone_id).state === 'playing');
  await env.flush();
  assert.equal(env.last(LIVING, 'playback_state'), 1);
  assert.equal(env.last(LIVING, 'title'), 'Blue in Green');
  assert.equal(env.last(LIVING, 'artist'), 'Miles Davis');
  assert.equal(env.last(LIVING, 'album'), 'Kind of Blue');
  assert.match(env.last(LIVING, 'artwork'), /^art-[0-9a-f]{12}$/);
  assert.equal(env.last(LIVING, 'duration'), 240);
  assert.equal(env.last(LIVING, 'position'), 12);
  assert.equal(env.last(LIVING, 'shuffle'), 1);
  assert.equal(env.last(LIVING, 'repeat'), 2);
  // The artwork is fetched from the Core over the session.
  const ack = await env.gladys.fake.musicGetArtwork(env.last(LIVING, 'artwork'));
  assert.equal(ack.success, true, ack.error);
  const image = env.core.requests.find((r) => r.name === 'com.roonlabs.image:1/get_image');
  assert.equal(image.body.image_key, TRACK.image_key);
  // A seek every second publishes nothing new (Gladys extrapolates).
  const before = env.gladys.fake.states.length;
  for (const s of [13, 14, 15]) env.core.seek(zone.zone_id, s);
  await until(() => env.app.current.roon.zones.get(zone.zone_id).seek === 15);
  await env.flush();
  assert.equal(env.gladys.fake.states.length, before);
  // Nothing loaded any more: the texts are cleared explicitly.
  delete zone.now_playing;
  zone.state = 'stopped';
  env.core.pushZones([zone.zone_id]);
  await until(() => !env.app.current.roon.zones.get(zone.zone_id).np);
  await env.flush();
  assert.equal(env.last(LIVING, 'title'), '');
  assert.equal(env.last(LIVING, 'artwork'), '');
  assert.equal(env.last(LIVING, 'playback_state'), 2);
});

test('commands: play, pause, stop, next, shuffle, repeat, seek, confirmed by the picture', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  await env.ready();
  const set = (key, value) => env.gladys.fake.setValue(device, env.feature(device, key), value);
  assert.deepEqual(await set('playback_state', 1), { success: true });
  assert.equal(env.core.zoneOf('o1').state, 'playing');
  assert.deepEqual(await set('pause', 1), { success: true });
  assert.equal(env.core.zoneOf('o1').state, 'paused');
  assert.deepEqual(await set('playback_state', 2), { success: true });
  assert.deepEqual(
    env.core.commands('control').map((b) => b.control),
    ['play', 'pause', 'stop'],
  );
  assert.deepEqual(await set('next', 1), { success: true });
  assert.deepEqual(await set('shuffle', 1), { success: true });
  assert.equal(env.core.zoneOf('o1').settings.shuffle, true);
  assert.deepEqual(await set('repeat', 1), { success: true });
  assert.equal(env.core.zoneOf('o1').settings.loop, 'loop');
  await set('playback_state', 1);
  assert.deepEqual(await set('position', 100), { success: true });
  assert.deepEqual(env.core.commands('seek').at(-1), {
    zone_or_output_id: 'o1',
    how: 'absolute',
    seconds: 100,
  });
  // Invalid values: nothing sent.
  const sent = env.core.requests.length;
  for (const [key, value] of [
    ['playback_state', 3],
    ['playback_state', 1.5],
    ['volume', 101],
    ['volume', Number.NaN],
    ['repeat', 3],
    ['zone', 1],
  ]) {
    const ack = await set(key, value);
    assert.equal(ack.success, false, `${key}=${value}`);
  }
  assert.equal(env.core.requests.length, sent);
});

test('pause of a zone that cannot pause (a live radio) stops it', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  const zone = env.core.zoneOf('o1');
  zone.state = 'playing';
  zone.is_pause_allowed = false;
  await env.ready();
  const ack = await env.gladys.fake.setValue(device, env.feature(device, 'pause'), 1);
  assert.deepEqual(ack, { success: true });
  assert.deepEqual(env.core.commands('control').at(-1), {
    zone_or_output_id: 'o1',
    control: 'stop',
  });
});

test('volume: under the cap (50 %), a lower one never held, step and dB range', async (t) => {
  const device = created(LIVING);
  const env = await setup({
    devices: [device],
    core: {
      outputs: [
        makeOutput('o1', LIVING, {
          volume: volume(-40, { type: 'db', min: -80, max: 0, step: 0.5 }),
        }),
      ],
    },
  });
  t.after(() => env.close());
  await env.ready();
  assert.equal(env.last(LIVING, 'volume'), 50);
  const set = (value) => env.gladys.fake.setValue(device, env.feature(device, 'volume'), value);
  assert.deepEqual(await set(90), { success: true });
  assert.equal(env.core.commands('change_volume').at(-1).value, -40, 'capped at 50 % of -80..0 dB');
  assert.deepEqual(await set(20), { success: true });
  assert.equal(env.core.commands('change_volume').at(-1).value, -64);
  await env.app.configUpdated({ host: '127.0.0.1', port: env.core.port, max_volume: 100 });
  assert.deepEqual(await set(33), { success: true });
  assert.equal(
    env.core.commands('change_volume').at(-1).value,
    -54,
    '-53.6 rounded down to a step',
  );
});

test('unmute: brought under the cap first; a mute clicked meanwhile wins', async (t) => {
  const device = created(LIVING);
  const env = await setup({
    devices: [device],
    core: { outputs: [makeOutput('o1', LIVING, { volume: volume(80, { is_muted: true }) })] },
  });
  t.after(() => env.close());
  await env.ready();
  const mute = (value) => env.gladys.fake.setValue(device, env.feature(device, 'mute'), value);
  assert.deepEqual(await mute(0), { success: true });
  assert.deepEqual(
    env.core.requests.slice(-2).map((r) => r.name.split('/').at(-1)),
    ['change_volume', 'mute'],
  );
  assert.equal(env.core.output('o1').volume.value, 50);
  assert.equal(env.core.output('o1').volume.is_muted, false);
  // Muted again, volume 80: an unmute waits for the volume, a mute clicked meanwhile goes first.
  env.core.output('o1').volume.value = 80;
  env.core.output('o1').volume.is_muted = true;
  env.core.pushOutputs(['o1']);
  await until(() => env.app.current.roon.outputs.get('o1').volume.value === 80);
  env.core.latencyMs = 50;
  const unmute = mute(0);
  await until(() => env.core.commands('change_volume').length === 2);
  const muteAgain = mute(1);
  const [first, second] = await Promise.all([unmute, muteAgain]);
  assert.equal(first.success, false);
  assert.equal(first.error, E.cancelled);
  assert.equal(second.success, true);
  assert.equal(env.core.output('o1').volume.is_muted, true);
  assert.equal(env.core.commands('mute').at(-1).how, 'mute', 'no unmute after the mute');
});

test('Success without the change: not confirmed; no answer: sent without confirmation', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  await env.ready();
  env.core.never = true;
  const play = env.gladys.fake.setValue(device, env.feature(device, 'play'), 1);
  await until(() => env.core.commands('control').length === 1);
  await env.clock.advance(TIMINGS.CONFIRM);
  const ack = await play;
  assert.equal(ack.success, false);
  assert.equal(ack.error, E.notConfirmed);
  env.core.silent.add('control');
  const pause = env.gladys.fake.setValue(device, env.feature(device, 'pause'), 1);
  await until(() => env.core.commands('control').length === 2);
  await env.clock.advance(TIMINGS.COMMAND);
  const late = await pause;
  assert.equal(late.error, E.sentNoAnswer);
  env.core.silent.clear();
  env.core.refuse.control = 'InvalidRequest';
  const refused = await env.gladys.fake.setValue(device, env.feature(device, 'pause'), 1);
  assert.equal(refused.error, E.refused('InvalidRequest'));
});

test('Core gone: nothing sent, unreachable badge, retried with a growing delay', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  await env.ready();
  assert.equal(env.gladys.fake.transports.at(-1).transport, 'local');
  env.core.dropAll();
  await until(() => !env.app.current, 'session lost');
  await env.app.idle();
  assert.equal(env.status().connected, false);
  assert.match(env.status().message.en, /lost, tried again in 5 s/);
  assert.equal(env.gladys.fake.transports.at(-1).transport, 'unreachable');
  const ack = await env.gladys.fake.setValue(device, env.feature(device, 'pause'), 1);
  assert.equal(ack.error, E.notConnected);
  const connections = env.core.connections;
  await env.clock.advance(TIMINGS.RETRY_MIN - 10);
  assert.equal(env.core.connections, connections, 'never before the delay');
  await env.clock.advance(20);
  await env.ready();
  assert.equal(env.core.connections, connections + 1);
  assert.equal(env.status().connected, true);
});

test('an output gone from Roon: IDLE, texts cleared, commands refused', async (t) => {
  const device = created(KITCHEN);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  const zone = env.core.zoneOf('o2');
  zone.state = 'playing';
  zone.now_playing = structuredClone(TRACK);
  await env.ready();
  assert.equal(env.last(KITCHEN, 'title'), 'Blue in Green');
  env.core.zones.delete(zone.zone_id);
  env.core.pushZones([], [zone.zone_id]);
  env.core.pushOutputs([], ['o2']);
  await until(() => !env.app.current.roon.outputs.has('o2'));
  await env.flush();
  assert.equal(env.last(KITCHEN, 'playback_state'), 2);
  assert.equal(env.last(KITCHEN, 'title'), '');
  const ack = await env.gladys.fake.setValue(device, env.feature(device, 'play'), 1);
  assert.equal(ack.error, E.noOutput);
});

test('two outputs of one name: neither commanded nor listed', async (t) => {
  const device = created(LIVING);
  const env = await setup({
    devices: [device],
    core: {
      outputs: [makeOutput('o1', LIVING), makeOutput('o3', LIVING), makeOutput('o2', KITCHEN)],
    },
  });
  t.after(() => env.close());
  await env.ready();
  assert.deepEqual(
    env.gladys.fake.discoveredDevices.map((d) => d.name),
    [KITCHEN],
  );
  const ack = await env.gladys.fake.setValue(device, env.feature(device, 'play'), 1);
  assert.equal(ack.error, E.twoOutputs);
});

test('grouping and ungrouping by scene actions, confirmed by the zones', async (t) => {
  const living = created(LIVING);
  const kitchen = created(KITCHEN);
  const env = await setup({
    devices: [living, kitchen],
    core: {
      outputs: [
        makeOutput('o1', LIVING, { can_group_with_output_ids: ['o1', 'o2'] }),
        makeOutput('o2', KITCHEN, { can_group_with_output_ids: ['o1', 'o2'] }),
      ],
    },
  });
  t.after(() => env.close());
  await env.ready();
  const ack = await env.gladys.fake.sceneAction('group_with', {
    device: living.external_id,
    with: kitchen.external_id,
  });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data, { outputs: { zone: 'Living room + Kitchen' } });
  await env.flush();
  assert.equal(env.last(KITCHEN, 'zone'), 'Living room + Kitchen');
  const back = await env.gladys.fake.sceneAction('ungroup', { device: kitchen.external_id });
  assert.equal(back.success, true);
  assert.deepEqual(back.data, { outputs: { zone: KITCHEN } });
  const same = await env.gladys.fake.sceneAction('group_with', {
    device: living.external_id,
    with: living.external_id,
  });
  assert.equal(same.error, E.sameOutput);
});

test('outputs Roon will not group: refused before sending', async (t) => {
  const living = created(LIVING);
  const kitchen = created(KITCHEN);
  const env = await setup({ devices: [living, kitchen] });
  t.after(() => env.close());
  await env.ready();
  const ack = await env.gladys.fake.sceneAction('group_with', {
    device: living.external_id,
    with: kitchen.external_id,
  });
  assert.equal(ack.error, E.notGroupable);
  assert.equal(env.core.commands('group_outputs').length, 0);
});

test('getConfig failing in connected: tried again with a status, then started', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  let calls = 0;
  const getConfig = async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return env.gladys.getConfig();
  };
  await env.app.connected(getConfig);
  await env.app.idle();
  assert.equal(env.status().connected, false);
  assert.match(
    env.status().message.en,
    /configuration could not be read from Gladys, tried again in 5 s/,
  );
  assert.equal(env.core.connections, 0);
  await env.clock.advance(TIMINGS.CONFIG_RETRY_MIN);
  await env.app.idle();
  await env.ready();
  assert.equal(calls, 2);
  assert.equal(env.status().connected, true);
});

test('configurations saved back to back: applied one by one, the last one wins', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const first = env.app.configUpdated({ host: '127.0.0.1', port: 1, max_volume: 50 });
  const second = env.app.configUpdated({ host: '127.0.0.1', port: env.core.port, max_volume: 40 });
  await Promise.all([first, second]);
  await env.ready();
  assert.equal(env.app.config.max_volume, 40);
  assert.equal(env.app.config.port, env.core.port);
  assert.equal(env.status().connected, true);
});

test('no address: no connection, a status that says what to do', async (t) => {
  const env = await setup({ config: {} });
  t.after(() => env.close());
  assert.equal(env.core.connections, 0);
  assert.match(env.status().message.en, /Type the address of the Roon Core/);
  await env.app.configUpdated({ host: '255.255.255.255' });
  assert.match(env.status().message.en, /Invalid value.*host/);
});

test('/data unreadable: nothing sent to the Core, never overwritten; forgetting it reconnects', async (t) => {
  const store = createMemoryStore({ tokens: { 'core-1': 'tok-secret-123' } });
  store.broken = true;
  const env = await setup({ store });
  t.after(() => env.close());
  assert.equal(env.core.connections, 0);
  assert.match(env.status().message.en, /cannot be read \(EIO\)/);
  assert.equal(store.saves, 0);
  store.broken = false;
  const ack = await env.gladys.fake.action('forget_authorization');
  assert.equal(ack.success, true);
  await env.ready();
  assert.equal(env.status().connected, true);
  assert.equal(env.core.registers.at(-1).token, undefined);
});

test('token not saved (/data full): connected, the status says so', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const env = await setup({ store });
  t.after(() => env.close());
  await env.ready();
  await env.flush();
  assert.equal(env.status().connected, true);
  assert.match(env.status().message.en, /could not be written to \/data/);
});

test('Find the Roon Core: one answer fills an empty address', async (t) => {
  const { buildAnswer } = await import('./helpers/sood.js');
  const env = await setup({ config: {} });
  t.after(() => env.close());
  env.gladys.fake.scanResults['udp-active-broadcast'] = [
    {
      source_ip: '127.0.0.1',
      source_port: 9003,
      payload_base64: buildAnswer({ port: env.core.port }),
    },
  ];
  const ack = await env.gladys.fake.action('find_core');
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.match(ack.data.message.en, /Found Roon Server \(127\.0\.0\.1:\d+\): its address is saved/);
  const scan = env.gladys.fake.scans.at(-1);
  assert.equal(scan.type, 'udp-active-broadcast');
  assert.equal(scan.port, 9003);
  await env.ready();
  assert.equal(env.status().connected, true);
});

test('Gladys reconnects: everything published again from the live picture only', async (t) => {
  const env = await setup({ devices: [created(LIVING)] });
  t.after(() => env.close());
  await env.ready();
  const count = env.gladys.fake.states.length;
  await env.app.connected(() => env.gladys.getConfig());
  await env.app.idle();
  await env.flush();
  assert.ok(env.gladys.fake.states.length > count, 'republished');
  assert.equal(env.core.connections, 1, 'the Core session is kept');
  // The Core is gone: a reconnection of Gladys publishes nothing stale.
  await env.core.close();
  await until(() => !env.app.current);
  const after = env.gladys.fake.states.length;
  await env.app.connected(() => env.gladys.getConfig());
  await env.app.idle();
  await env.flush();
  assert.equal(env.gladys.fake.states.length, after);
});

test('64 requests waiting: play is held, pause, mute and a lower volume still go', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  await env.ready();
  env.core.silent.add('control');
  env.core.silent.add('change_volume');
  env.core.silent.add('mute');
  const set = (key, value) => env.gladys.fake.setValue(device, env.feature(device, key), value);
  // The two subscriptions are waiting too: the plays fill the rest of 64.
  const fill = 64 - env.app.current.session.pending.size;
  const stuck = Array.from({ length: fill }, () => set('play', 1));
  await until(() => env.core.commands('control').length === fill, 'plays sent');
  assert.equal(env.app.current.session.pending.size, 64);
  const play = await set('play', 1);
  assert.equal(play.error, E.busy);
  const before = env.core.requests.length;
  const pause = set('pause', 1);
  const mute = set('mute', 1);
  const lower = set('volume', 10);
  await until(() => env.core.requests.length === before + 3, 'three urgent requests sent');
  await env.clock.advance(TIMINGS.COMMAND);
  for (const ack of await Promise.all([pause, mute, lower, ...stuck])) {
    assert.equal(ack.error, E.sentNoAnswer);
  }
});

test('a scene on 5 slow outputs (600 ms each): all 5 set', async (t) => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const devices = names.map((n) => created(n));
  const env = await setup({
    devices,
    core: { outputs: names.map((n, i) => makeOutput(`o${i}`, n)) },
  });
  t.after(() => env.close());
  await env.ready();
  env.core.latencyMs = 600;
  const acks = await Promise.all(
    devices.map((d) => env.gladys.fake.setValue(d, env.feature(d, 'volume'), 40)),
  );
  for (const ack of acks) assert.deepEqual(ack, { success: true });
  assert.deepEqual(
    names.map((_, i) => env.core.output(`o${i}`).volume.value),
    [40, 40, 40, 40, 40],
  );
});

test('the artwork endpoint failing never stops the states', async (t) => {
  const device = created(LIVING);
  const env = await setup({ devices: [device] });
  t.after(() => env.close());
  const zone = env.core.zoneOf('o1');
  zone.state = 'playing';
  zone.now_playing = structuredClone(TRACK);
  await env.ready();
  env.core.silent.add('get_image');
  const art = env.gladys.fake.musicGetArtwork(env.last(LIVING, 'artwork'));
  await until(() => env.core.requests.some((r) => r.name.endsWith('get_image')));
  zone.state = 'paused';
  env.core.pushZones([zone.zone_id]);
  await until(() => env.app.current.roon.zones.get(zone.zone_id).state === 'paused');
  await env.flush();
  assert.equal(env.last(LIVING, 'playback_state'), 0);
  await env.clock.advance(TIMINGS.IMAGE);
  assert.equal((await art).success, false);
  // A big or non-image answer is refused.
  env.core.silent.clear();
  env.core.image = Buffer.alloc(400 * 1024, 0xff);
  const big = await env.gladys.fake.musicGetArtwork(env.last(LIVING, 'artwork'));
  assert.equal(big.success, false);
  env.core.image = Buffer.from('<html>not an image</html>');
  assert.equal((await env.gladys.fake.musicGetArtwork(env.last(LIVING, 'artwork'))).success, false);
  assert.equal((await env.gladys.fake.musicGetArtwork('art-000000000000')).success, false);
});

test('unmute with a cap and an unknown volume: refused, nothing sent', async (t) => {
  const device = created(LIVING);
  const env = await setup({
    devices: [device],
    core: {
      outputs: [
        makeOutput('o1', LIVING, { volume: volume(30, { value: undefined, is_muted: true }) }),
      ],
    },
  });
  t.after(() => env.close());
  await env.ready();
  const ack = await env.gladys.fake.setValue(device, env.feature(device, 'mute'), 0);
  assert.equal(ack.error, E.volumeUnknown);
  assert.equal(env.core.commands('mute').length + env.core.commands('change_volume').length, 0);
  // Muting is never refused for that (already muted: the state shows it).
  const mute = await env.gladys.fake.setValue(device, env.feature(device, 'mute'), 1);
  assert.equal(mute.success, true);
  assert.equal(env.core.commands('mute').length, 1);
});

test('300 states a minute: a big house is published over two minutes, never more', async (t) => {
  const names = Array.from({ length: 40 }, (_, i) => `Room ${i}`);
  const devices = names.map((n) => created(n));
  const env = await setup({
    devices,
    core: { outputs: names.map((n, i) => makeOutput(`o${i}`, n)) },
  });
  t.after(() => env.close());
  await env.ready();
  const first = env.gladys.fake.states.length;
  assert.ok(first <= 280 + 20, `${first} states in the first minute`);
  assert.ok(first >= 200);
  assert.equal(env.last('Room 39', 'zone'), undefined, 'the last rooms wait');
  await env.clock.advance(60_000);
  await env.app.idle();
  assert.equal(env.last('Room 39', 'zone'), 'Room 39');
});

test('Gladys away: nothing published meanwhile; back: the picture of now', async (t) => {
  const env = await setup({ devices: [created(LIVING)] });
  t.after(() => env.close());
  await env.ready();
  env.app.disconnected();
  const count = env.gladys.fake.states.length;
  const zone = env.core.zoneOf('o1');
  zone.state = 'playing';
  zone.now_playing = structuredClone(TRACK);
  env.core.pushZones([zone.zone_id]);
  await until(() => env.app.current.roon.zones.get(zone.zone_id).state === 'playing');
  await env.flush();
  assert.equal(env.gladys.fake.states.length, count);
  await env.app.connected(() => env.gladys.getConfig());
  await env.app.idle();
  await env.flush();
  assert.equal(env.last(LIVING, 'title'), 'Blue in Green');
});

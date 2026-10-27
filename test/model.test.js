import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBACK,
  RoonState,
  outputOf,
  playbackOf,
  volumePercent,
  volumeTarget,
  zoneOf,
} from '../src/roon/model.js';
import { TRACK, makeOutput, makeZone, volume } from './helpers/fakeCore.js';

test('zone: lines, length, image, settings; bounded texts, control characters removed', () => {
  const zone = zoneOf(
    makeZone([makeOutput('o1', 'Living')], {
      state: 'playing',
      now_playing: { ...TRACK, three_line: { line1: `A\u0007${'b'.repeat(300)}`, line2: 'B' } },
      settings: { loop: 'loop', shuffle: true },
    }),
  );
  assert.equal(zone.state, 'playing');
  assert.equal(zone.np.title.length, 200);
  assert.ok(!zone.np.title.includes('\u0007'));
  assert.equal(zone.np.artist, 'B');
  assert.equal(zone.np.album, '');
  assert.equal(zone.np.length, 240);
  assert.equal(zone.seek, 12);
  assert.equal(zone.repeat, 1);
  assert.equal(zone.shuffle, true);
  // A two-line radio: no length (0), no album.
  const radio = zoneOf(
    makeZone([makeOutput('o2', 'Kitchen')], {
      now_playing: { two_line: { line1: 'FIP', line2: 'Live' }, seek_position: 5 },
    }),
  );
  assert.deepEqual(
    { title: radio.np.title, artist: radio.np.artist, length: radio.np.length },
    { title: 'FIP', artist: 'Live', length: 0 },
  );
  assert.equal(zoneOf({ zone_id: 'bad id!' }), undefined);
  assert.equal(zoneOf(null), undefined);
  assert.equal(zoneOf(makeZone([makeOutput('o3', 'X')], { state: 'weird' })).state, undefined);
});

test('playback states of Roon -> MUSIC_PLAYBACK_STATE', () => {
  assert.equal(playbackOf('playing'), PLAYBACK.PLAYING);
  assert.equal(playbackOf('paused'), PLAYBACK.PAUSED);
  assert.equal(playbackOf('loading'), PLAYBACK.BUFFERING);
  assert.equal(playbackOf('stopped'), PLAYBACK.IDLE);
  assert.equal(playbackOf(undefined), undefined);
});

test('volume: percent of the range, target under the cap, the step and the limits', () => {
  const db = outputOf(
    makeOutput('o1', 'A', { volume: volume(-40, { type: 'db', min: -80, max: 0, step: 0.5 }) }),
  ).volume;
  assert.equal(volumePercent(db), 50);
  assert.equal(volumeTarget(db, 100, 50), -40);
  assert.equal(volumeTarget(db, 10, 50), -72);
  assert.equal(volumeTarget(db, 0, 50), -80);
  const odd = outputOf(
    makeOutput('o1', 'A', { volume: volume(65, { min: 1, max: 99, step: 1 }) }),
  ).volume;
  assert.equal(volumeTarget(odd, 100, 100), 99);
  assert.equal(volumeTarget(odd, 50, 100), 50);
  // A hard limit or a soft limit of Roon is never passed.
  const limited = outputOf(
    makeOutput('o1', 'A', { volume: volume(10, { hard_limit_max: 70, soft_limit: 60 }) }),
  ).volume;
  assert.equal(volumeTarget(limited, 100, 100), 60);
  // Incremental (+/- only) and broken ranges: no value Gladys can set.
  const incremental = outputOf(makeOutput('o1', 'A', { volume: { type: 'incremental' } })).volume;
  assert.equal(volumePercent(incremental), undefined);
  assert.equal(volumeTarget(incremental, 50, 100), undefined);
  const broken = outputOf(
    makeOutput('o1', 'A', { volume: volume(5, { min: 10, max: 10 }) }),
  ).volume;
  assert.equal(broken.type, 'incremental');
  // An unknown type is a number (the API says so).
  assert.equal(
    outputOf(makeOutput('o1', 'A', { volume: volume(5, { type: 'new' }) })).volume.type,
    'number',
  );
});

test('state: Subscribed then Changed; seek; outputs of both subscriptions; bounds', () => {
  const state = new RoonState();
  const o1 = makeOutput('o1', 'Living');
  const o2 = makeOutput('o2', 'Kitchen');
  state.applyZones('Subscribed', { zones: [makeZone([o1]), makeZone([o2])] });
  assert.equal(state.complete, false);
  state.applyOutputs('Subscribed', { outputs: [o1, o2] });
  assert.equal(state.complete, true);
  assert.equal(state.zoneOfOutput('o2').id, 'z-o2');
  state.applyZones('Changed', { zones_seek_changed: [{ zone_id: 'z-o1', seek_position: 33 }] });
  assert.equal(state.zones.get('z-o1').seek, 33);
  state.applyOutputs('Changed', { outputs_changed: [{ ...o1, volume: volume(70) }] });
  assert.equal(volumePercent(state.outputs.get('o1').volume), 70);
  // Grouped: one zone lists both outputs.
  const grouped = makeZone([o1, { ...o2, zone_id: 'z-o1' }]);
  state.applyZones('Changed', { zones_changed: [grouped], zones_removed: ['z-o2'] });
  assert.equal(state.zoneOfOutput('o2').id, 'z-o1');
  assert.deepEqual(
    state.outputsNamed('Kitchen').map((o) => o.id),
    ['o2'],
  );
  state.applyOutputs('Changed', { outputs_removed: ['o2'] });
  assert.equal(state.outputs.has('o2'), false);
  // Too many zones: the extra ones are not kept.
  const many = Array.from({ length: 150 }, (_, i) => makeZone([makeOutput(`x${i}`, `X${i}`)]));
  state.applyZones('Subscribed', { zones: many });
  assert.ok(state.zones.size <= 100);
  // Garbage is ignored.
  state.applyZones('Changed', { zones_changed: 'nope', zones_removed: [{}] });
  state.applyOutputs('Changed', null);
});

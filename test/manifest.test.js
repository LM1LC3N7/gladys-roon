// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, EXTENSION, FEATURE, SCENE_ACTIONS } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};

test('the store basics; one semver version in 4 places, never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-roon:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-roon');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['multimedia']);
  assert.deepEqual(manifest.transports, ['local']);
  // The music field exists from Gladys 5.3.0 on (the store refuses a lower minimum).
  assert.equal(manifest.gladys_version, '>=5.3.0');
  assert.deepEqual(manifest.music, {});
  assert.deepEqual(manifest.network_discovery, [{ type: 'udp-active-broadcast', ports: [9003] }]);
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-roon\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/i);
  assert.ok(manifest.name.length <= 30);
});

test('the extension id is Gladys’s own, never one of another platform', () => {
  assert.equal(EXTENSION.extension_id, 'io.github.lm1lc3n7.gladys-roon');
  // Never the namespace or the name of the Gladys team: a community integration.
  for (const value of [EXTENSION.extension_id, EXTENSION.display_name, EXTENSION.publisher]) {
    assert.doesNotMatch(value, /gladysassistant/i);
    if (/Gladys Assistant/.test(value)) assert.match(value, /community|not by/i);
  }
  assert.match(EXTENSION.display_name, /community/);
  assert.equal(EXTENSION.display_version, pkg.version);
  for (const value of Object.values(EXTENSION)) {
    assert.doesNotMatch(String(value), /home.?assistant|hass|openhab|homey|jeedom|hubitat/i);
  }
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real Roon Core', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+été\s+testée\s+avec\s+un\s+vrai\s+Roon\s+Core/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+Roon\s+Core/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+Roon\s+Core/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'host', 'port', 'max_volume']);
  for (const key of Object.keys(fields)) assert.ok(!key.startsWith('gladys_'), key);
  assert.ok(!manifest.config_schema.some((f) => f.type === 'secret'), 'the token lives in /data');
  assert.equal(fields.host.type, 'string');
  assert.equal(fields.host.required, false);
  assert.equal(fields.port.default, DEFAULT_CONFIG.port);
  assert.equal(fields.max_volume.default, DEFAULT_CONFIG.max_volume);
  assert.equal(fields.max_volume.min, 1);
  assert.equal(fields.max_volume.max, 100);
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('the buttons and scene actions of the manifest are the handlers of the code', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTIONS),
  );
  for (const key of ['FIND', 'TEST', 'FORGET'])
    assert.ok(handlers.includes(`onAction(ACTIONS.${key}`));
  for (const key of ['GROUP', 'UNGROUP'])
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${key}`));
  assert.ok(handlers.includes('onSetValue'));
  assert.ok(handlers.includes('onMusicGetArtwork'));
  assert.match(
    handlers,
    /\.connected\(\(\) => gladys\.getConfig\(\)\)/,
    'getConfig retried by the app',
  );
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 10);
    for (const output of action.outputs)
      assert.ok(['string', 'number', 'boolean'].includes(output.type));
  }
});

test('the device: music features, no switch, labels of options are strings, keys forever', () => {
  const device = buildDevice(fakeGladys, { name: 'Living room', volume: { type: 'number' } });
  assert.match(device.external_id, /^ext:x:output:[0-9a-f]{16}$/);
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys.sort(), Object.values(FEATURE).sort());
  for (const feature of device.features) {
    assert.notEqual(feature.category, 'switch');
    assert.ok(feature.type !== 'binary', feature.external_id);
    assert.equal(feature.keep_history, false);
    if (!feature.read_only && !['play', 'pause', 'previous', 'next'].includes(feature.type)) {
      assert.equal(feature.has_feedback, true, feature.external_id);
    }
    for (const option of feature.supported_options ?? []) {
      assert.equal(typeof option.label, 'string', 'supported_options[].label is a string');
    }
  }
  const fixed = buildDevice(fakeGladys, { name: 'Fixed', volume: { type: 'incremental' } });
  assert.ok(!fixed.features.some((f) => ['volume', 'mute'].includes(f.type)));
});

test('the licenses ship in the image; no name in LICENSE; the ported code is credited', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  for (const name of [
    'node-roon-api',
    'node-roon-api-transport',
    'node-roon-api-image',
    'node-roon-api-status',
    '504c918d6da267e03fbb4337befa71ca3d3c7526',
    'Roon Labs',
  ]) {
    assert.ok(notices.includes(name), name);
  }
  assert.match(notices, /Apache License/);
  assert.match(notices, /055dae6c2ac45b6c738aa3b9e5ac1fd722ed60e8/);
});

test('nothing logs a token: no body of the Core reaches a logger', () => {
  for (const file of ['src/app.js', 'src/roon/session.js', 'src/roon/moo.js', 'src/handlers.js']) {
    const code = read(file);
    assert.doesNotMatch(code, /logger\.\w+\([^)]*(token|body)/i, file);
    assert.doesNotMatch(code, /console\./, file);
  }
});

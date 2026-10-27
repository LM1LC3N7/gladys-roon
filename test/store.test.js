// -----------------------------------------------------------------------------
// /data: no file is an empty state; a file that cannot be read is NOT (the
// app then never overwrites it nor registers without its token); saves go
// one after the other; the token file is readable by its owner only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/store.js';
import { setup } from './helpers/app.js';

const dirOf = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'roon-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('no file yet: an empty state; a save then a load give it back; mode 600', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(store.load(), { ok: true, data: {} });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(store.load(), { ok: true, data: { a: 2 } });
  assert.equal((await stat(file)).mode & 0o077, 0);
});

test('a file that cannot be read is not an empty state', async (t) => {
  const dir = await dirOf(t);
  for (const [name, content] of [
    ['broken.json', '{"tokens":'],
    ['array.json', '[1,2]'],
    ['big.json', `{"x":"${'a'.repeat(300 * 1024)}"}`],
  ]) {
    const file = join(dir, name);
    await writeFile(file, content);
    assert.equal(createFileStore(file).load().ok, false, name);
  }
  assert.equal(createFileStore(dir).load().ok, false, 'a directory (EISDIR)');
});

test('the app never overwrites a /data file it could not read, nor connects', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  await writeFile(file, '{"tokens":{"core-1":');
  const env = await setup({ store: createFileStore(file) });
  t.after(() => env.close());
  await env.clock.advance(60_000);
  await env.app.idle();
  assert.equal(await readFile(file, 'utf8'), '{"tokens":{"core-1":');
  assert.equal(env.core.connections, 0);
});

test('the token is written to the file, and only there', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  const env = await setup({ store: createFileStore(file) });
  t.after(() => env.close());
  await env.ready();
  await env.app.idle();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.tokens, { 'core-1': env.core.token });
  assert.equal(saved.version, 1);
});

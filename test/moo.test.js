import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MooError, encode, parse } from '../src/roon/moo.js';
import { mooMessage } from './helpers/fakeCore.js';

test('encode: a request with and without a JSON body, as node-roon-api writes it (length in bytes)', () => {
  assert.equal(
    encode('REQUEST', 'com.roonlabs.registry:1/info', 0).toString(),
    'MOO/1 REQUEST com.roonlabs.registry:1/info\nRequest-Id: 0\n\n',
  );
  assert.equal(
    encode('COMPLETE', 'Success', 7, { a: 'é' }).toString(),
    'MOO/1 COMPLETE Success\nRequest-Id: 7\nContent-Length: 10\nContent-Type: application/json\n\n{"a":"é"}',
  );
  assert.throws(() => encode('REQUEST', 'bad name\n', 1), MooError);
  assert.throws(() => encode('PUSH', 'x', 1), MooError);
});

test('parse: answers, requests of the Core, binary bodies', () => {
  const answer = parse(mooMessage('CONTINUE', 'Subscribed', 3, { zones: [] }));
  assert.deepEqual(answer, {
    verb: 'CONTINUE',
    name: 'Subscribed',
    requestId: 3,
    contentType: 'application/json',
    body: { zones: [] },
  });
  const ping = parse(mooMessage('REQUEST', 'com.roonlabs.ping:1/ping', 12));
  assert.equal(ping.service, 'com.roonlabs.ping:1');
  assert.equal(ping.name, 'ping');
  const image = parse(mooMessage('COMPLETE', 'Success', 4, Buffer.from([1, 2, 3]), 'image/jpeg'));
  assert.deepEqual([...image.body], [1, 2, 3]);
  assert.equal(image.contentType, 'image/jpeg');
  // Extra headers are accepted and ignored.
  const quiet = parse(Buffer.from('MOO/1 COMPLETE Success\nRequest-Id: 1\nLogging: quiet\n\n'));
  assert.equal(quiet.requestId, 1);
});

test('parse: anything malformed is refused', () => {
  const bad = [
    '',
    'MOO/1 COMPLETE Success\nRequest-Id: 1\n', // no blank line
    'HTTP/1.1 200 OK\n\n',
    'MOO/2 COMPLETE Success\nRequest-Id: 1\n\n',
    'MOO/1 COMPLETE Success\n\n', // no Request-Id
    'MOO/1 COMPLETE Success\nRequest-Id: -1\n\n',
    'MOO/1 COMPLETE Success\nRequest-Id: 1\nContent-Length: 5\nContent-Type: application/json\n\n{}',
    'MOO/1 COMPLETE Success\nRequest-Id: 1\nContent-Length: 2\n\n{}', // no type
    'MOO/1 COMPLETE Success\nRequest-Id: 1\nContent-Length: 2\nContent-Type: application/json\n\n{x',
    'MOO/1 COMPLETE Success\nRequest-Id: 1\n\nextra', // body without length
    'MOO/1 COMPLETE Success\nRequest-Id: 1\nContent-Length: 1e3\n\n',
    'MOO/1 REQUEST nouslash\nRequest-Id: 1\n\n',
    'MOO/1 COMPLETE Success\nRequest-Id: 1\nbad line\n\n',
    `MOO/1 COMPLETE Success\nRequest-Id: 1\n${'X-A: b\n'.repeat(40)}\n`,
    `MOO/1 COMPLETE Success\nRequest-Id: 1\nX-Long: ${'a'.repeat(9000)}\n\n`,
  ];
  for (const text of bad) {
    assert.throws(() => parse(Buffer.from(text)), MooError, JSON.stringify(text.slice(0, 60)));
  }
});

test('parse: a __proto__ key stays plain data', () => {
  const message = parse(
    mooMessage('COMPLETE', 'Success', 1, JSON.parse('{"__proto__": {"polluted": true}}')),
  );
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(message.body), Object.prototype);
});

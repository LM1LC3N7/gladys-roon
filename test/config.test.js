import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectable, normalizeConfig, parseHost, sessionKey } from '../src/config.js';

test('defaults: no address, port 9330, cap 50', () => {
  assert.deepEqual(normalizeConfig(), { host: '', port: 9330, max_volume: 50, invalid: [] });
  assert.equal(isConnectable(normalizeConfig()), false);
});

test('addresses: IPv4 and host names; never broadcast, multicast, 0.0.0.0, CR/LF', () => {
  assert.equal(parseHost(' 192.168.1.30 '), '192.168.1.30');
  assert.equal(parseHost('Roon-Server.lan'), 'roon-server.lan');
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1.255',
    '224.0.0.1',
    '1.2.3',
    'a b',
    'x\r\ny',
    'h:9330',
    '-x',
  ]) {
    assert.equal(parseHost(bad), undefined, bad);
  }
  assert.deepEqual(normalizeConfig({ host: '224.0.0.1' }).invalid, ['host']);
  assert.deepEqual(normalizeConfig({ host: 42 }).invalid, ['host']);
});

test('numbers are strict; a wrong cap is the lowest one', () => {
  assert.equal(normalizeConfig({ port: '9100' }).port, 9100);
  assert.deepEqual(normalizeConfig({ port: '9100.5' }).invalid, ['port']);
  assert.deepEqual(normalizeConfig({ port: 0 }).invalid, ['port']);
  assert.equal(normalizeConfig({ max_volume: 30 }).max_volume, 30);
  assert.equal(normalizeConfig({ max_volume: 'loud' }).max_volume, 1);
  assert.equal(normalizeConfig({ max_volume: 250 }).max_volume, 100);
  assert.equal(normalizeConfig({ max_volume: '' }).max_volume, 50);
  assert.equal(isConnectable(normalizeConfig({ host: '10.0.0.2', port: 'x' })), false);
});

test('the session key changes with the address and the port, not with the cap', () => {
  const a = normalizeConfig({ host: '10.0.0.2', max_volume: 20 });
  assert.equal(sessionKey(a), sessionKey(normalizeConfig({ host: '10.0.0.2', max_volume: 80 })));
  assert.notEqual(sessionKey(a), sessionKey(normalizeConfig({ host: '10.0.0.2', port: 9100 })));
});

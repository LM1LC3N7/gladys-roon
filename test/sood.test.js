import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOOD_CORE_SERVICE } from '../src/constants.js';
import { buildQuery, coresFound, parseMessage } from '../src/roon/sood.js';
import { buildAnswer, encodeSood } from './helpers/sood.js';

test('the query is the one node-roon-api broadcasts', () => {
  const query = buildQuery('tid-1');
  assert.equal(query.toString('latin1', 0, 6), 'SOOD\u0002Q');
  const parsed = parseMessage(query);
  assert.equal(parsed.type, 'Q');
  assert.equal(parsed.props.query_service_id, SOOD_CORE_SERVICE);
  assert.equal(parsed.props._tid, 'tid-1');
  assert.ok(query.length <= 512, 'the Gladys core takes at most 512 bytes');
});

test('answers: one per Core, from usable addresses, of our transaction', () => {
  const results = [
    { source_ip: '192.168.1.30', payload_base64: buildAnswer({ port: 9330 }) },
    { source_ip: '192.168.1.30', payload_base64: buildAnswer({ port: 9330 }) },
    { source_ip: '192.168.1.31', payload_base64: buildAnswer({ id: 'core-2', tid: 'other' }) },
    { source_ip: '0.0.0.0', payload_base64: buildAnswer({ id: 'core-3' }) },
    { source_ip: '192.168.1.255', payload_base64: buildAnswer({ id: 'core-4' }) },
    { source_ip: '192.168.1.32', payload_base64: buildAnswer({ id: 'core-5', port: 70000 }) },
    { source_ip: '192.168.1.33', payload_base64: 'bm90IHNvb2Q=' },
    {
      source_ip: '192.168.1.34',
      payload_base64: buildAnswer({ id: 'core-6', extra: { _replyaddr: '8.8.8.8' } }),
    },
    {
      source_ip: '192.168.1.35',
      payload_base64: encodeSood('R', {
        service_id: 'other',
        unique_id: 'x',
        http_port: 1,
      }).toString('base64'),
    },
  ];
  assert.deepEqual(coresFound(results, 'tid-1'), [
    { id: 'core-1', host: '192.168.1.30', port: 9330, name: 'Roon Server', version: '2.0' },
    { id: 'core-6', host: '192.168.1.34', port: 9330, name: 'Roon Server', version: '2.0' },
  ]);
  assert.deepEqual(coresFound(null, 'tid-1'), []);
});

test('truncated or oversized messages are refused', () => {
  const answer = Buffer.from(buildAnswer(), 'base64');
  assert.equal(parseMessage(answer.subarray(0, answer.length - 3)), undefined);
  assert.equal(parseMessage(Buffer.alloc(4000)), undefined);
  assert.equal(parseMessage(Buffer.from('SOOD\u0003R', 'latin1')), undefined);
});

// A SOOD answer of a Roon Core, as the Gladys core relays it (base64).
import { SOOD_CORE_SERVICE } from '../../src/constants.js';

export function encodeSood(type, props) {
  const parts = [Buffer.from(`SOOD\u0002${type}`, 'latin1')];
  for (const [name, value] of Object.entries(props)) {
    const n = Buffer.from(name);
    parts.push(Buffer.from([n.length]), n);
    if (value === null) {
      parts.push(Buffer.from([0xff, 0xff]));
    } else {
      const v = Buffer.from(String(value));
      const length = Buffer.alloc(2);
      length.writeUInt16BE(v.length);
      parts.push(length, v);
    }
  }
  return Buffer.concat(parts);
}

export function buildAnswer({
  port = 9330,
  tid = 'tid-1',
  id = 'core-1',
  name = 'Roon Server',
  extra = {},
} = {}) {
  return encodeSood('R', {
    service_id: SOOD_CORE_SERVICE,
    unique_id: id,
    name,
    display_version: '2.0',
    http_port: port,
    _tid: tid,
    ...extra,
  }).toString('base64');
}

// -----------------------------------------------------------------------------
// SOOD, the discovery protocol of the Roon Core (ported from node-roon-api
// sood.js, Apache-2.0, Roon Labs: see THIRD_PARTY_NOTICES.md). A query is
// broadcast on UDP 9003, each Core answers to the sender:
//
//   "SOOD" 0x02 "Q" | "R", then properties: <1 byte name length><name>
//   <2 bytes value length, 0xFFFF = null><value>
//
// The container cannot broadcast on the LAN: the query goes through the
// Gladys core (network_discovery `udp-active-broadcast`), which returns the
// raw answers. Pure functions; an answer is bounded and checked.
// -----------------------------------------------------------------------------

import { isUsableIPv4 } from '../config.js';
import { LIMITS, SOOD_CORE_SERVICE } from '../constants.js';
import { noControl } from './model.js';

const MAGIC = 'SOOD';

/** The query for Roon Cores, `tid` a transaction id echoed by the answers. */
export function buildQuery(tid) {
  const parts = [Buffer.from(`${MAGIC}\u0002Q`, 'latin1')];
  for (const [name, value] of [
    ['query_service_id', SOOD_CORE_SERVICE],
    ['_tid', tid],
  ]) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const lengths = Buffer.alloc(3);
    lengths[0] = n.length;
    lengths.writeUInt16BE(v.length, 1);
    parts.push(lengths.subarray(0, 1), n, lengths.subarray(1), v);
  }
  return Buffer.concat(parts);
}

/** The properties of a SOOD message, or undefined when it is not one. */
export function parseMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || buf.length > 2048) return undefined;
  if (buf.toString('latin1', 0, 4) !== MAGIC || buf[4] !== 2) return undefined;
  const type = buf.toString('latin1', 5, 6);
  const props = Object.create(null);
  let pos = 6;
  let count = 0;
  while (pos < buf.length) {
    if (++count > 32) return undefined;
    const nameLength = buf[pos++];
    if (!nameLength || pos + nameLength > buf.length) return undefined;
    const name = buf.toString('utf8', pos, pos + nameLength);
    pos += nameLength;
    if (pos + 2 > buf.length) return undefined;
    const valueLength = buf.readUInt16BE(pos);
    pos += 2;
    let value = null;
    if (valueLength !== 0xffff) {
      if (pos + valueLength > buf.length) return undefined;
      value = buf.toString('utf8', pos, pos + valueLength);
      pos += valueLength;
    }
    props[name] = value;
  }
  return { type, props };
}

const clean = (text, max = 64) =>
  typeof text === 'string' ? noControl(text).trim().slice(0, max) : '';

/**
 * The Cores found in the raw results of a scan (`[{ source_ip,
 * payload_base64 }]`): `[{ host, port, name, version, id }]`, one per Core,
 * only answers of our transaction, from a usable IPv4 address, with a port.
 * The `_replyaddr` of an answer is never followed (the address is the one the
 * answer came from).
 */
export function coresFound(results, tid) {
  const found = new Map();
  for (const result of Array.isArray(results) ? results.slice(0, 64) : []) {
    if (found.size >= LIMITS.FOUND) break;
    const host = typeof result?.source_ip === 'string' ? result.source_ip : '';
    if (!isUsableIPv4(host)) continue;
    let payload;
    try {
      payload = Buffer.from(String(result.payload_base64 ?? ''), 'base64');
    } catch {
      continue;
    }
    const message = parseMessage(payload);
    if (!message || message.type !== 'R') continue;
    const { props } = message;
    if (props.service_id !== SOOD_CORE_SERVICE) continue;
    if (props._tid !== undefined && props._tid !== null && props._tid !== tid) continue;
    const port = /^\d{1,5}$/.test(props.http_port ?? '') ? Number(props.http_port) : 0;
    if (port < 1 || port > 65535) continue;
    const id = clean(props.unique_id, 64);
    if (!id) continue;
    if (found.has(id)) continue;
    found.set(id, {
      id,
      host,
      port,
      name: clean(props.name) || 'Roon Core',
      version: clean(props.display_version, 32),
    });
  }
  return [...found.values()];
}

// -----------------------------------------------------------------------------
// MOO/1, the message format of the Roon extension API, carried one message per
// binary WebSocket frame (ported from node-roon-api moo.js / moomsg.js,
// Apache-2.0, Roon Labs: see THIRD_PARTY_NOTICES.md):
//
//   MOO/1 REQUEST com.roonlabs.registry:1/info\n
//   Request-Id: 0\n
//   Content-Length: 2\n
//   Content-Type: application/json\n
//   \n
//   {}
//
// The answers are `MOO/1 CONTINUE <name>` (more to come: a subscription) or
// `MOO/1 COMPLETE <name>` (the last one) with the Request-Id of the request.
// The Core also sends REQUESTs (ping, status) that the extension answers.
//
// Hardened against a peer that is not a Roon Core: header block and lines
// bounded, Content-Length a strict number equal to the body length, a JSON
// body parsed into plain data, nothing ever logged (a register body carries
// the authorization token).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export class MooError extends Error {
  constructor(reason) {
    super(`MOO: ${reason}`);
    this.name = 'MooError';
    this.code = 'protocol';
  }
}

const VERBS = new Set(['REQUEST', 'CONTINUE', 'COMPLETE']);
const NAME = /^[A-Za-z0-9_.:/-]{1,128}$/;
const REQUEST_ID = /^\d{1,10}$/;

/** A message to send: `verb` REQUEST | CONTINUE | COMPLETE, `body` a JSON value or undefined. */
export function encode(verb, name, requestId, body) {
  if (!VERBS.has(verb)) throw new MooError('bad verb');
  if (!NAME.test(name)) throw new MooError('bad name');
  if (!Number.isInteger(requestId) || requestId < 0) throw new MooError('bad request id');
  let header = `MOO/1 ${verb} ${name}\nRequest-Id: ${requestId}\n`;
  if (body === undefined) {
    return Buffer.from(`${header}\n`, 'utf8');
  }
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  header += `Content-Length: ${data.length}\nContent-Type: application/json\n\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), data]);
}

/**
 * One received frame -> `{ verb, name, service?, requestId, contentType?,
 * body? }`: `body` is the parsed JSON, or a Buffer for any other content type
 * (an image). Throws a MooError on anything malformed.
 */
export function parse(frame) {
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buf.length === 0) throw new MooError('empty message');
  const end = buf.indexOf('\n\n', 0, 'latin1');
  if (end < 0 || end > LIMITS.HEADER_BYTES) throw new MooError('no header end');
  const lines = buf.toString('utf8', 0, end).split('\n');
  if (lines.length > LIMITS.HEADER_LINES) throw new MooError('too many header lines');
  const first = /^MOO\/1 ([A-Z]+) (\S+)$/.exec(lines[0]);
  if (!first || !VERBS.has(first[1])) throw new MooError('bad first line');
  const message = { verb: first[1], name: first[2] };
  if (message.verb === 'REQUEST') {
    const slash = message.name.indexOf('/');
    if (slash <= 0 || slash === message.name.length - 1) throw new MooError('bad request name');
    message.service = message.name.slice(0, slash);
    message.name = message.name.slice(slash + 1);
  }
  if (!NAME.test(message.name)) throw new MooError('bad name');
  let length;
  for (const line of lines.slice(1)) {
    const match = /^([A-Za-z-]{1,40}): ?(.{0,200})$/.exec(line);
    if (!match) throw new MooError('bad header line');
    const [, key, value] = match;
    if (key === 'Request-Id') {
      if (!REQUEST_ID.test(value)) throw new MooError('bad Request-Id');
      message.requestId = Number(value);
    } else if (key === 'Content-Length') {
      if (!/^\d{1,8}$/.test(value)) throw new MooError('bad Content-Length');
      length = Number(value);
    } else if (key === 'Content-Type') {
      message.contentType = value.trim().toLowerCase();
    }
  }
  if (message.requestId === undefined) throw new MooError('no Request-Id');
  const body = buf.subarray(end + 2);
  if (length === undefined) {
    if (message.contentType !== undefined || body.length > 0)
      throw new MooError('body without length');
    return message;
  }
  if (length !== body.length) throw new MooError('Content-Length mismatch');
  if (length === 0) return message;
  if (message.contentType === undefined) throw new MooError('body without type');
  if (message.contentType === 'application/json') {
    try {
      message.body = JSON.parse(body.toString('utf8'));
    } catch {
      throw new MooError('bad JSON body');
    }
  } else {
    message.body = body;
  }
  return message;
}

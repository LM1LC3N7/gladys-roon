// -----------------------------------------------------------------------------
// One WebSocket session with a Roon Core (`ws://<host>:<port>/api`), the
// connection logic of node-roon-api lib.js / transport-websocket.js
// (Apache-2.0, Roon Labs: see THIRD_PARTY_NOTICES.md), ported without its
// file config, its console logging (it logs every body, the token included)
// and its discovery:
//
//   1. registry/info            -> the core_id
//   2. registry/register        -> answered `Registered` (with a token) once
//      the user enabled the extension in Roon, Settings > Extensions; until
//      then the request waits, which is the normal "waiting" state
//   3. transport subscribe_zones and subscribe_outputs -> the live picture
//
// The Core also asks: ping (answered), status (the line Roon shows under the
// extension). One session, one socket; any protocol error, a missed
// keepalive or a close ends it for good (the app opens a new one later).
// Nothing here ever logs: the register body carries the token.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { LIMITS, SERVICES, TIMINGS } from '../constants.js';
import { noControl } from './model.js';
import { encode, parse } from './moo.js';

export class RoonError extends Error {
  /** `code`: unreachable | closed | timeout | protocol | refused | busy | not_registered. */
  constructor(code, answer) {
    super(answer ? `Roon: ${code} (${answer})` : `Roon: ${code}`);
    this.name = 'RoonError';
    this.code = code;
    /** The name the Core answered (InvalidRequest, NotFound...), never a body. */
    this.answer = answer;
  }
}

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOKEN = /^[\x21-\x7e]{1,256}$/;

export class RoonSession extends EventEmitter {
  constructor({
    host,
    port,
    extension,
    getToken = () => undefined,
    statusText = 'Connected',
    WebSocketImpl = WebSocket,
    timers = defaultTimers,
    monotonic = () => performance.now(),
  }) {
    super();
    this.url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}/api`;
    this.extension = extension;
    this.getToken = getToken;
    this.statusText = statusText;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.monotonic = monotonic;
    this.nextId = 0;
    /** Request-Id -> `{ resolve, reject, onMessage?, timer }`. */
    this.pending = new Map();
    this.error = undefined;
    this.registered = undefined;
    this.ws = undefined;
    this.lastHeard = monotonic();
    this.keepalive = undefined;
    let closedResolve;
    this.closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
    this.closedResolve = closedResolve;
  }

  /** Opens the socket and runs the handshake; every outcome arrives as an event. */
  start() {
    try {
      this.ws = new this.WebSocketImpl(this.url, {
        handshakeTimeout: TIMINGS.CONNECT,
        maxPayload: LIMITS.MESSAGE_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch {
      this.fail(new RoonError('unreachable'));
      return;
    }
    this.ws.on('open', () => {
      this.wasOpen = true;
      this.lastHeard = this.monotonic();
      this.keepalive = this.timers.setInterval(() => this.checkAlive(), TIMINGS.KEEPALIVE);
      this.handshake().catch((err) => this.fail(err));
    });
    this.ws.on('message', (data) => this.onFrame(data));
    this.ws.on('pong', () => {
      this.lastHeard = this.monotonic();
    });
    this.ws.on('unexpected-response', () => this.fail(new RoonError('protocol')));
    this.ws.on('error', (err) => {
      const code = /^WS_ERR_/.test(String(err?.code ?? ''))
        ? 'protocol'
        : this.wasOpen
          ? 'closed'
          : 'unreachable';
      this.fail(new RoonError(code));
    });
    this.ws.on('close', () => {
      this.fail(new RoonError(this.wasOpen ? 'closed' : 'unreachable'));
      this.closedResolve();
    });
  }

  /** Ends the session (the first error wins); every request waiting is rejected. */
  fail(err) {
    if (!this.error) {
      this.error = err;
      this.timers.clearInterval(this.keepalive);
      for (const [requestId, entry] of this.pending) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(requestId);
        // Already on the wire: the Core may have acted on it.
        const lost = new RoonError(err.code, err.answer);
        lost.sent = true;
        entry.reject(lost);
      }
      this.emit('closed', err);
    }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.closedResolve();
      return;
    }
    if (this.ending) return;
    this.ending = true;
    try {
      ws.terminate();
    } catch {
      this.closedResolve();
    }
  }

  close() {
    this.fail(new RoonError('closed'));
    return this.closed;
  }

  get alive() {
    return !this.error && this.ws?.readyState === WebSocket.OPEN;
  }

  checkAlive() {
    if (this.error) return;
    if (this.monotonic() - this.lastHeard > 2 * TIMINGS.KEEPALIVE) {
      this.fail(new RoonError('timeout'));
      return;
    }
    try {
      this.ws.ping();
    } catch {
      this.fail(new RoonError('closed'));
    }
  }

  send(buffer) {
    if (!this.alive) throw this.error ?? new RoonError('closed');
    this.ws.send(buffer, { binary: true });
  }

  /**
   * Sends a request; resolves with the COMPLETE answer `{ name, body,
   * contentType }` (any name: the caller decides what Success means), or with
   * each CONTINUE through `onMessage` (a subscription, which resolves on its
   * first answer). `timeout` 0 waits as long as the session lives. An
   * `urgent` request (pause, stop, mute, a lower volume) is not held by the
   * limit of requests in flight (only by a hard bound four times higher).
   */
  request(name, body, { timeout = TIMINGS.REQUEST, onMessage, urgent = false } = {}) {
    if (this.error) return Promise.reject(this.error);
    const limit = urgent ? 4 * LIMITS.IN_FLIGHT : LIMITS.IN_FLIGHT;
    if (this.pending.size >= limit) return Promise.reject(new RoonError('busy'));
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onMessage, timer: undefined, settled: false };
      if (timeout > 0) {
        entry.timer = this.timers.setTimeout(() => {
          if (this.pending.get(requestId) !== entry) return;
          if (onMessage) {
            // A subscription never answered: the session is not usable.
            this.fail(new RoonError('timeout'));
            return;
          }
          this.pending.delete(requestId);
          const late = new RoonError('timeout');
          late.sent = true;
          reject(late);
        }, timeout);
      }
      this.pending.set(requestId, entry);
      try {
        this.send(encode('REQUEST', name, requestId, body));
      } catch (err) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  onFrame(data) {
    if (this.error) return;
    this.lastHeard = this.monotonic();
    let message;
    try {
      message = parse(Array.isArray(data) ? Buffer.concat(data) : data);
    } catch {
      this.fail(new RoonError('protocol'));
      return;
    }
    if (message.verb === 'REQUEST') {
      this.answerCore(message);
      return;
    }
    const entry = this.pending.get(message.requestId);
    if (!entry) {
      // An answer to nothing we asked: not a Roon Core talking to us.
      this.fail(new RoonError('protocol'));
      return;
    }
    if (message.verb === 'COMPLETE') {
      this.pending.delete(message.requestId);
      this.timers.clearTimeout(entry.timer);
    }
    const answer = { name: message.name, body: message.body, contentType: message.contentType };
    if (entry.onMessage) {
      if (!entry.settled) {
        entry.settled = true;
        this.timers.clearTimeout(entry.timer);
        entry.resolve(answer);
      }
      entry.onMessage(answer);
      return;
    }
    if (message.verb === 'COMPLETE') entry.resolve(answer);
  }

  /** The requests of the Core: ping and the status service, nothing else. */
  answerCore(message) {
    const reply = (verb, name, body) => {
      try {
        this.send(encode(verb, name, message.requestId, body));
      } catch {
        // The session is ending: nothing to answer on.
      }
    };
    const status = { message: this.statusText, is_error: false };
    if (message.service === SERVICES.PING && message.name === 'ping') {
      reply('COMPLETE', 'Success');
    } else if (message.service === SERVICES.STATUS && message.name === 'subscribe_status') {
      reply('CONTINUE', 'Subscribed', status);
    } else if (message.service === SERVICES.STATUS && message.name === 'unsubscribe_status') {
      reply('COMPLETE', 'Unsubscribed');
    } else if (message.service === SERVICES.STATUS && message.name === 'get_status') {
      reply('COMPLETE', 'Success', status);
    } else {
      reply('COMPLETE', 'InvalidRequest', { error: 'unknown request' });
    }
  }

  async handshake() {
    const info = await this.request(`${SERVICES.REGISTRY}/info`);
    const coreId = info.name === 'Success' && isPlain(info.body) ? info.body.core_id : undefined;
    if (typeof coreId !== 'string' || !ID.test(coreId)) throw new RoonError('protocol');
    const core = {
      coreId,
      name:
        typeof info.body.display_name === 'string'
          ? noControl(info.body.display_name).trim().slice(0, 64)
          : '',
      version:
        typeof info.body.display_version === 'string'
          ? noControl(info.body.display_version).trim().slice(0, 32)
          : '',
    };
    this.core = core;
    this.emit('info', core);
    const token = this.getToken(coreId);
    const registration = {
      ...this.extension,
      required_services: [SERVICES.TRANSPORT],
      optional_services: [SERVICES.IMAGE],
      provided_services: [SERVICES.PING, SERVICES.STATUS],
      ...(typeof token === 'string' && TOKEN.test(token) ? { token } : {}),
    };
    // No timeout: the Core answers once the user enabled the extension (as
    // CONTINUE or COMPLETE: node-roon-api takes either). A later answer on
    // the same request that is not `Registered` (the extension disabled)
    // ends the session.
    let first = true;
    const answer = await this.request(`${SERVICES.REGISTRY}/register`, registration, {
      timeout: 0,
      onMessage: (message) => {
        if (!first && message.name !== 'Registered') {
          this.fail(new RoonError('not_registered', String(message.name).slice(0, 40)));
        }
        first = false;
      },
    });
    if (answer.name !== 'Registered' || !isPlain(answer.body)) {
      throw new RoonError('not_registered', String(answer.name).slice(0, 40));
    }
    if (answer.body.core_id !== undefined && answer.body.core_id !== coreId) {
      throw new RoonError('protocol');
    }
    const newToken = answer.body.token;
    this.registered = {
      ...core,
      token: typeof newToken === 'string' && TOKEN.test(newToken) ? newToken : undefined,
      services: Array.isArray(answer.body.provided_services)
        ? answer.body.provided_services.filter((s) => typeof s === 'string').slice(0, 32)
        : [],
    };
    this.emit('registered', this.registered);
    let key = 0;
    for (const what of ['zones', 'outputs']) {
      const subscriptionKey = key++;
      await this.request(
        `${SERVICES.TRANSPORT}/subscribe_${what}`,
        { subscription_key: subscriptionKey },
        {
          onMessage: (message) => {
            if (this.error) return;
            if (message.name === 'Subscribed' || message.name === 'Changed') {
              this.emit(what, message.name, message.body);
            } else {
              // Unsubscribed by the Core, or an error: the picture stops.
              this.fail(new RoonError('closed', String(message.name).slice(0, 40)));
            }
          },
        },
      );
    }
  }

  /** A transport request (`control`, `change_volume`...) that must answer Success. */
  async command(name, body, timeout = TIMINGS.COMMAND, urgent = false) {
    const answer = await this.request(`${SERVICES.TRANSPORT}/${name}`, body, { timeout, urgent });
    if (answer.name !== 'Success') throw new RoonError('refused', String(answer.name).slice(0, 40));
  }

  /** An image of the Core (`image_key`), scaled to fit 400 px, as a Buffer. */
  async image(imageKey) {
    const answer = await this.request(
      `${SERVICES.IMAGE}/get_image`,
      { image_key: imageKey, scale: 'fit', width: 400, height: 400, format: 'image/jpeg' },
      { timeout: TIMINGS.IMAGE },
    );
    if (answer.name !== 'Success') throw new RoonError('refused', String(answer.name).slice(0, 40));
    if (!Buffer.isBuffer(answer.body)) throw new RoonError('protocol');
    return { type: answer.contentType, data: answer.body };
  }
}

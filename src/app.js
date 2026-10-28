// -----------------------------------------------------------------------------
// RoonApp: one session with the Roon Core of the configuration, the live
// picture of its zones and outputs, one Gladys device per output, the
// commands and the scene actions.
//
// - The picture comes by subscription (push): states are published only from
//   a live, complete picture of the current session, never from memory after
//   a loss (nothing stale republished at `connected`, `deviceCreated` or a
//   reconnection to the Core).
// - Commands go straight to the Core (MOO is multiplexed: each request has
//   its Request-Id; the Core is a server, not a one-request device), in click
//   order on one socket. Pause, stop, mute and a lower volume are never held
//   by the volume cap; only "not connected" or "output unknown" stops them,
//   since there is nothing to send them to.
// - A command succeeds when the Core said Success AND the picture shows it
//   (play, pause, stop, volume, mute, shuffle, repeat, grouping); a seek,
//   previous and next have nothing to compare and succeed on Success.
// - The token the Core gives is kept in /data, never logged, never shown.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { randomUUID } from 'node:crypto';
import { isConnectable, normalizeConfig, sessionKey } from './config.js';
import {
  ARTWORK_PREFIX,
  DEFAULT_MAX_VOLUME,
  EXTENSION,
  FEATURE,
  LIMITS,
  SOOD_PORT,
  TIMINGS,
} from './constants.js';
import {
  buildDevice,
  featureKey,
  hasVolume,
  keyOfDeviceId,
  mergeWithCreated,
  outputKey,
} from './devices.js';
import { E, T } from './i18n.js';
import {
  PLAYBACK,
  REPEAT_TO_LOOP,
  RoonState,
  playbackOf,
  volumePercent,
  volumeTarget,
} from './roon/model.js';
import { RoonSession } from './roon/session.js';
import { buildQuery, coresFound } from './roon/sood.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOKEN = /^[\x21-\x7e]{1,256}$/;
const IMAGE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Seconds a scene action may take (manifest timeout_seconds 10, kept under). */
const SCENE_BUDGET = 8000;
const STATUS_TEXT = 'Connected to Gladys (community integration)';

/** A command error carrying the text Gladys shows. */
const fail = (message) => new Error(message);

/** A strict value from Gladys: a finite number, an integer when asked. */
function numberOf(value, { integer = false, min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(E.badValue);
  if (integer && !Number.isInteger(value)) throw fail(E.badValue);
  if (value < min || value > max) throw fail(E.badValue);
  return value;
}

/** The image bytes Gladys accepts: JPEG, PNG or WebP, by their magic numbers. */
function imageKind(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length > 8 && data.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (
    data.length > 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  return undefined;
}

export class RoonApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'roon' }),
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    sessionFactory = (options) => new RoonSession(options),
    random = () => randomUUID(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.sessionFactory = sessionFactory;
    this.random = random;
    this.config = undefined;
    /** `{ gen, session, roon, core, ready, alive }` of the session being run. */
    this.current = undefined;
    this.generation = 0;
    this.retryTimer = undefined;
    this.retryDelay = TIMINGS.RETRY_MIN;
    this.waitTimer = undefined;
    this.lifecycle = Promise.resolve();
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = Promise.resolve();
    this.lastStatus = undefined;
    this.statusRun = Promise.resolve();
    this.flushTimer = undefined;
    this.flushRun = Promise.resolve();
    this.flushAgain = false;
    /** `[{ at, count }]` of the states published in the last minute. */
    this.published = [];
    this.lastTransports = undefined;
    this.lastDiscovery = undefined;
    /** Output id -> the number of the last command sent to it. */
    this.seq = new Map();
    /** Commands waiting to see their effect: `{ check, done }`. */
    this.waiters = new Set();
    this.finding = false;
    this.tokenUnsaved = false;
    this.gladysDown = false;
    /** Output key (of a name) -> the output id last seen with that name. */
    this.outputIds = new Map();
    this.loadStore();
  }

  // --- /data -------------------------------------------------------------------

  loadStore() {
    const result = this.store.load();
    this.tokens = new Map();
    if (!result.ok) {
      this.storeError = result.code;
      return;
    }
    this.storeError = undefined;
    const tokens = isPlain(result.data) && isPlain(result.data.tokens) ? result.data.tokens : {};
    for (const [coreId, token] of Object.entries(tokens).slice(0, 8)) {
      if (ID.test(coreId) && typeof token === 'string' && TOKEN.test(token)) {
        this.tokens.set(coreId, token);
      }
    }
    const outputs = isPlain(result.data) && isPlain(result.data.outputs) ? result.data.outputs : {};
    for (const [key, outputId] of Object.entries(outputs).slice(0, LIMITS.OUTPUTS)) {
      if (/^[0-9a-f]{16}$/.test(key) && typeof outputId === 'string' && ID.test(outputId)) {
        this.outputIds.set(key, outputId);
      }
    }
  }

  /** What /data keeps: the tokens and the output id last seen for each name. */
  snapshot(tokens = this.tokens) {
    return {
      version: 1,
      tokens: Object.fromEntries(tokens),
      outputs: Object.fromEntries(this.outputIds),
    };
  }

  /** Remembers the output id of a name (in /data when it can be written). */
  record(key, outputId) {
    if (this.outputIds.get(key) === outputId) return;
    this.outputIds.delete(key);
    this.outputIds.set(key, outputId);
    while (this.outputIds.size > LIMITS.OUTPUTS) {
      this.outputIds.delete(this.outputIds.keys().next().value);
    }
    if (this.storeError) return;
    this.store.save(this.snapshot()).catch((err) => {
      this.logger.warn(`roon: output ids not saved (${err?.code ?? 'Error'})`);
    });
  }

  /**
   * The output of a name, checked against the output id last seen for it
   * (review r1, M1): `{ output }` (one live output, its id recorded), or
   * `{ output, swapped }` when the id recorded for this name is alive under
   * ANOTHER name (two names swapped in Roon): `swapped` is the output the
   * device drove until now, the room it was created for.
   */
  identity(cur, key, outputs) {
    const [output] = outputs;
    const recorded = this.outputIds.get(key);
    if (recorded === undefined || recorded === output.id) {
      this.record(key, output.id);
      return { output };
    }
    const before = cur.roon.outputs.get(recorded);
    if (!before) {
      // The old id is gone (Roon changed it, or the device was replaced).
      this.record(key, output.id);
      return { output };
    }
    return { output, swapped: before };
  }

  async saveToken(coreId, token) {
    if (this.storeError || !token || this.tokens.get(coreId) === token) return;
    const next = new Map(this.tokens);
    next.delete(coreId);
    next.set(coreId, token);
    // At most 8 Cores remembered, the oldest forgotten.
    while (next.size > 8) next.delete(next.keys().next().value);
    // In memory BEFORE the write (review r2, I2): a record() saved while this
    // write is slow takes the token in its snapshot, never the old tokens.
    this.tokens = next;
    try {
      await this.store.save(this.snapshot());
      this.tokenUnsaved = false;
    } catch (err) {
      // Kept in memory for this run only.
      this.tokenUnsaved = true;
      this.logger.warn(`roon: the authorization could not be saved (${err?.code ?? 'Error'})`);
    }
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** A connection to Gladys: the configuration is read, tried again without end. */
  connected(getConfig) {
    this.gladysDown = false;
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the getConfig retries end (the Core session stays). */
  disconnected() {
    // Nothing published until Gladys is back (then everything, from the picture).
    this.gladysDown = true;
    this.connection += 1;
    this.clearConfigTimer();
  }

  /** The user saved the form: it wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(
        TIMINGS.CONFIG_RETRY_MIN * 2 ** this.configFailures,
        TIMINGS.CONFIG_RETRY_MAX,
      );
      this.configFailures += 1;
      this.logger.warn(`roon: the configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    return this.serialize(async () => {
      this.clearConfigTimer();
      this.connection += 1;
      await this.closeSession();
    });
  }

  /** Resolves once the queued starts, the getConfig try and the flush are done (tests). */
  async idle() {
    await this.configRun;
    await this.lifecycle;
    await this.flushRun;
    await this.statusRun;
  }

  async doStart(raw) {
    const config = normalizeConfig(raw);
    const changed = this.config === undefined || sessionKey(config) !== sessionKey(this.config);
    this.config = config;
    // Gladys may have restarted: everything is published again, from the
    // live picture only.
    this.gladys.forgetPublishedStates();
    this.lastStatus = undefined;
    this.lastTransports = undefined;
    this.lastDiscovery = undefined;
    if (!changed && !this.current && this.retryTimer !== undefined) {
      // Waiting for the next try (review r1, I1): a connection of Gladys or a
      // form saved with the same address never connects sooner, nor resets
      // the backoff; the status is said again.
      await this.setStatus(false, this.lossStatus ?? T.lost(this.retryDelay));
      return;
    }
    if (changed || !this.current) {
      await this.closeSession();
      this.retryDelay = TIMINGS.RETRY_MIN;
      this.openSession();
      return;
    }
    if (this.current.ready) {
      this.reportConnected();
      this.publishDiscovered();
      this.scheduleFlush(0);
    } else {
      // The status of the attempt running is said again by its next step.
      await this.setStatus(false, this.current.lastStatus ?? T.connecting(this.address()));
    }
  }

  address() {
    return `${this.config.host}:${this.config.port}`;
  }

  async closeSession() {
    this.clearRetry();
    this.timers.clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    const cur = this.current;
    this.current = undefined;
    this.generation += 1;
    this.endWaiters();
    if (cur) await cur.session.close();
  }

  clearRetry() {
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  openSession() {
    this.clearRetry();
    if (this.storeError) {
      this.setStatus(false, T.storeUnreadable(this.storeError));
      return;
    }
    const invalid = this.config.invalid.filter((key) => key !== 'max_volume');
    if (invalid.length > 0) {
      this.setStatus(false, T.invalid(invalid));
      return;
    }
    if (!isConnectable(this.config)) {
      this.setStatus(false, T.notConfigured);
      return;
    }
    const gen = ++this.generation;
    const session = this.sessionFactory({
      host: this.config.host,
      port: this.config.port,
      extension: EXTENSION,
      getToken: (coreId) => this.tokens.get(coreId),
      statusText: STATUS_TEXT,
      timers: this.timers,
      monotonic: this.monotonic,
    });
    const cur = { gen, session, roon: new RoonState(), core: undefined, ready: false, alive: true };
    this.current = cur;
    const mine = () => this.current === cur && this.generation === gen;
    session.on('info', (core) => {
      if (!mine()) return;
      cur.core = core;
      // A known token answers at once; otherwise the user has to enable us.
      this.waitTimer = this.timers.setTimeout(() => {
        this.waitTimer = undefined;
        if (mine() && !cur.registered) this.sessionStatus(cur, T.waiting(this.coreName(cur)));
      }, 2000);
    });
    session.on('registered', (registered) => {
      if (!mine()) return;
      cur.registered = true;
      this.timers.clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
      this.saveToken(registered.coreId, registered.token).catch(() => {});
    });
    session.on('zones', (name, body) => {
      if (!mine()) return;
      cur.roon.applyZones(name, body);
      this.pictureChanged(cur);
    });
    session.on('outputs', (name, body) => {
      if (!mine()) return;
      cur.roon.applyOutputs(name, body);
      this.pictureChanged(cur);
    });
    session.on('closed', (err) => {
      if (!mine()) return;
      this.sessionLost(cur, err);
    });
    this.sessionStatus(cur, T.connecting(this.address()));
    session.start();
  }

  coreName(cur) {
    const core = cur.core;
    if (!core) return 'Roon Core';
    return [core.name || 'Roon Core', core.version].filter(Boolean).join(' ');
  }

  sessionStatus(cur, message) {
    cur.lastStatus = message;
    return this.setStatus(false, message);
  }

  pictureChanged(cur) {
    for (const waiter of [...this.waiters]) waiter.check();
    if (!cur.roon.complete) return;
    if (!cur.ready) {
      cur.ready = true;
      this.retryDelay = TIMINGS.RETRY_MIN;
      this.logger.info(`roon: connected to ${this.coreName(cur)}`);
    }
    this.scheduleFlush();
  }

  sessionLost(cur, err) {
    cur.alive = false;
    this.current = undefined;
    this.timers.clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.endWaiters();
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, TIMINGS.RETRY_MAX);
    const code = err?.code ?? 'closed';
    this.logger.warn(`roon: session ended (${code}), next try in ${Math.round(wait / 1000)} s`);
    let message;
    if (code === 'unreachable') message = T.unreachable(this.address(), wait);
    else if (code === 'protocol') message = T.notRoon(this.address(), wait);
    else if (code === 'not_registered') message = T.disabled(wait);
    else message = T.lost(wait);
    this.lossStatus = message;
    this.setStatus(false, message);
    this.publishTransports(false);
    const gen = this.generation;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.generation !== gen || this.current) return;
      this.openSession();
    }, wait);
  }

  endWaiters() {
    for (const waiter of [...this.waiters]) waiter.done(false);
  }

  // --- Status ----------------------------------------------------------------------

  /** One setConnectionStatus per state; errors of Gladys are logged, never thrown. */
  setStatus(ok, message) {
    const key = JSON.stringify([ok, message?.en ?? null]);
    if (key === this.lastStatus) return this.statusRun;
    this.lastStatus = key;
    const connection = this.connection;
    this.statusRun = this.statusRun.then(async () => {
      try {
        await this.gladys.setConnectionStatus(ok, message);
      } catch (err) {
        if (connection === this.connection) {
          this.logger.warn(`roon: status not sent (${err?.name ?? 'Error'})`);
        }
        this.lastStatus = undefined;
      }
    });
    return this.statusRun;
  }

  reportConnected() {
    const cur = this.current;
    if (!cur?.ready) return;
    if (this.tokenUnsaved) {
      this.setStatus(true, T.tokenNotSaved);
      return;
    }
    this.setStatus(true, T.connected(this.coreName(cur), cur.roon.outputs.size));
  }

  // --- Publication -------------------------------------------------------------------

  /** The created devices of this integration, by output key. */
  createdByKey() {
    const map = new Map();
    for (const device of this.gladys.devices ?? []) {
      const key = keyOfDeviceId(device.external_id);
      if (key) map.set(key, device);
    }
    return map;
  }

  /** Output key -> the live outputs of that name (one, or several: ambiguous). */
  outputsByKey(roon) {
    const map = new Map();
    for (const output of roon.outputs.values()) {
      const key = outputKey(output.name);
      map.set(key, [...(map.get(key) ?? []), output]);
    }
    return map;
  }

  scheduleFlush(delay = TIMINGS.FLUSH) {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      this.flushRun = this.flushRun.then(() => this.flush()).catch(() => {});
    }, delay);
  }

  statesInLastMinute() {
    const now = this.monotonic();
    this.published = this.published.filter((entry) => now - entry.at < 60_000);
    return this.published.reduce((sum, entry) => sum + entry.count, 0);
  }

  async flush() {
    const cur = this.current;
    if (!cur?.ready || !cur.alive || this.gladysDown) return;
    this.reportConnected();
    const byKey = this.outputsByKey(cur.roon);
    const names = [...byKey.keys()].sort().join(',');
    if (names !== this.lastDiscovery) this.publishDiscovered();
    for (const [key, device] of this.createdByKey()) {
      if (this.current !== cur || !cur.alive) return;
      if (this.statesInLastMinute() >= LIMITS.STATES_PER_MINUTE) {
        // Gladys takes 300 states a minute: the rest waits for the window.
        const oldest = this.published[0]?.at ?? this.monotonic();
        this.scheduleFlush(Math.max(1000, 60_000 - (this.monotonic() - oldest)));
        return;
      }
      const outputs = byKey.get(key) ?? [];
      const features = new Set((device.features ?? []).map((f) => featureKey(f.external_id)));
      let nowPlaying;
      let zoneName;
      if (outputs.length === 1) {
        // Names swapped in Roon: nothing said until a Discovery accepts them.
        if (this.identity(cur, key, outputs).swapped) continue;
        nowPlaying = this.nowPlayingOf(cur.roon, outputs[0], features);
        zoneName = cur.roon.zoneOfOutput(outputs[0].id)?.name || outputs[0].name;
      } else if (outputs.length === 0) {
        // Roon says this output is gone (off, removed): nothing plays on it.
        nowPlaying = { playback_state: PLAYBACK.IDLE, title: '', artist: '', album: '' };
        if (features.has(FEATURE.ARTWORK)) nowPlaying.artwork_url = null;
      } else {
        continue; // two outputs of that name: nothing is said about either
      }
      await this.publishFor(device, nowPlaying, features, zoneName);
    }
    this.publishTransports(true);
  }

  async publishFor(device, nowPlaying, features, zoneName) {
    const filtered = Object.fromEntries(
      Object.entries(nowPlaying).filter(([key]) =>
        features.has(key === 'artwork_url' ? FEATURE.ARTWORK : key),
      ),
    );
    try {
      const result = await this.gladys.publishNowPlaying(device.external_id, filtered);
      if (result?.count) this.published.push({ at: this.monotonic(), count: result.count });
      if (zoneName && features.has(FEATURE.ZONE)) {
        const zone = await this.gladys.publishChangedStates([
          { device_feature_external_id: `${device.external_id}:${FEATURE.ZONE}`, text: zoneName },
        ]);
        if (zone?.count) this.published.push({ at: this.monotonic(), count: zone.count });
      }
    } catch (err) {
      this.logger.warn(`roon: states not published (${err?.name ?? 'Error'})`);
    }
  }

  /** What Gladys shows of an output (only the keys its device has). */
  nowPlayingOf(roon, output, features) {
    const zone = roon.zoneOfOutput(output.id);
    const np = {};
    if (zone) {
      const playback = playbackOf(zone.state);
      if (playback !== undefined) np.playback_state = playback;
      if (zone.np) {
        np.title = zone.np.title;
        np.artist = zone.np.artist;
        np.album = zone.np.album;
        np.artwork_url = zone.np.image ? `${ARTWORK_PREFIX}${zone.np.image}` : null;
        np.duration = zone.np.length;
        np.position = Math.min(zone.seek ?? 0, zone.np.length || Infinity);
      } else {
        Object.assign(np, {
          title: '',
          artist: '',
          album: '',
          artwork_url: null,
          duration: 0,
          position: 0,
        });
      }
      if (zone.shuffle !== undefined) np.shuffle = zone.shuffle;
      if (zone.repeat !== undefined) np.repeat = zone.repeat;
    }
    if (features.has(FEATURE.VOLUME)) {
      const percent = volumePercent(output.volume);
      if (percent !== undefined) np.volume = percent;
    }
    if (features.has(FEATURE.MUTE) && typeof output.volume?.muted === 'boolean') {
      np.mute = output.volume.muted;
    }
    return np;
  }

  publishTransports(live) {
    const cur = this.current;
    const byKey = live && cur?.ready ? this.outputsByKey(cur.roon) : new Map();
    // Local only for one live output of the name, not swapped (review r2:
    // a swapped device publishes nothing, its badge says so).
    const reachable = (key) => {
      const outputs = byKey.get(key) ?? [];
      return outputs.length === 1 && !this.identity(cur, key, outputs).swapped;
    };
    const entries = [...this.createdByKey()].map(([key, device]) => ({
      external_id: device.external_id,
      transport: reachable(key) ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
    const signature = JSON.stringify(entries);
    if (entries.length === 0 || signature === this.lastTransports) return;
    this.lastTransports = signature;
    this.gladys.publishTransports(entries).catch((err) => {
      this.lastTransports = undefined;
      this.logger.warn(`roon: transports not published (${err?.name ?? 'Error'})`);
    });
  }

  /** The Discovery list: every output of a unique name, created ones keeping their features. */
  publishDiscovered() {
    const cur = this.current;
    if (!cur?.ready) return Promise.resolve();
    const byKey = this.outputsByKey(cur.roon);
    this.lastDiscovery = [...byKey.keys()].sort().join(',');
    const created = this.createdByKey();
    const devices = [...byKey]
      .filter(([, outputs]) => outputs.length === 1)
      .map(([key, [output]]) =>
        mergeWithCreated(buildDevice(this.gladys, output, cur.core?.name ?? ''), created.get(key)),
      );
    return this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.lastDiscovery = undefined;
      this.logger.warn(`roon: discovery not published (${err?.name ?? 'Error'})`);
    });
  }

  /**
   * A Discovery asked by the user: the names as Roon has them now are taken
   * as they are (this is how a swap of two names is accepted).
   */
  scan() {
    const cur = this.current;
    if (cur?.ready) {
      for (const [key, outputs] of this.outputsByKey(cur.roon)) {
        if (outputs.length === 1) this.record(key, outputs[0].id);
      }
      // States and badges of the names just taken.
      this.scheduleFlush(0);
    }
    return this.publishDiscovered();
  }

  /** A device created, updated or deleted: its states come from the live picture. */
  devicesChanged() {
    this.lastTransports = undefined;
    this.scheduleFlush(0);
  }

  // --- Commands ------------------------------------------------------------------------

  /** The live output of a device, or an error saying why nothing can be sent. */
  resolve(externalId) {
    const { cur, outputs } = this.resolveAll(externalId);
    if (outputs.length > 1) throw fail(E.twoOutputs);
    const { output, swapped } = this.identity(cur, keyOfDeviceId(externalId), outputs);
    if (swapped) throw fail(E.swapped);
    return { cur, output };
  }

  /** Every live output of the name of a device (one, or several homonyms). */
  resolveAll(externalId) {
    const cur = this.current;
    if (!cur?.ready || !cur.alive || !cur.session.alive) throw fail(E.notConnected);
    const key = keyOfDeviceId(externalId);
    const outputs = key ? (this.outputsByKey(cur.roon).get(key) ?? []) : [];
    if (outputs.length === 0) throw fail(E.noOutput);
    return { cur, outputs };
  }

  /**
   * Two outputs or more of one name (review r1, I2): what only silences
   * (pause, stop, mute, a lower volume) goes to every one of them; anything
   * else is refused (which room would it be?).
   */
  async silenceAll(cur, outputs, key, value, started, refusal = E.twoOutputs) {
    let run;
    if (key === FEATURE.PAUSE) {
      run = (output) => this.playback(cur, output, 'pause', started);
    } else if (key === FEATURE.PLAYBACK_STATE) {
      const state = numberOf(value, { integer: true, min: 0, max: 2 });
      if (state === PLAYBACK.PLAYING) throw fail(refusal);
      const action = state === PLAYBACK.PAUSED ? 'pause' : 'stop';
      run = (output) => this.playback(cur, output, action, started);
    } else if (key === FEATURE.MUTE) {
      if (numberOf(value, { integer: true, min: 0, max: 1 }) !== 1) throw fail(refusal);
      run = (output) => this.mute(cur, output, true, started);
    } else if (key === FEATURE.VOLUME) {
      const percent = numberOf(value, { min: 0, max: 100 });
      // Only the outputs this volume lowers (each against its own volume).
      const lowered = outputs.filter((output) => {
        if (!hasVolume(output) || typeof output.volume.value !== 'number') return false;
        return volumeTarget(output.volume, percent, this.config.max_volume) <= output.volume.value;
      });
      if (lowered.length === 0) throw fail(refusal);
      outputs = lowered;
      run = (output) => this.volume(cur, output, percent, started);
    } else {
      throw fail(refusal);
    }
    const results = await Promise.allSettled(outputs.map((output) => run(output)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /** The output as the picture shows it now (by id), or undefined. */
  live(cur, outputId) {
    return this.current === cur ? cur.roon.outputs.get(outputId) : undefined;
  }

  bump(outputId) {
    const next = (this.seq.get(outputId) ?? 0) + 1;
    this.seq.set(outputId, next);
    return next;
  }

  /** Sends a transport request within the budget; the errors say whether it left. */
  async send(cur, name, body, started, { budget = TIMINGS.COMMAND_BUDGET, urgent = false } = {}) {
    const left = budget - (this.monotonic() - started) - 300;
    // Never removed: with no time left the request would leave without a
    // timer (timeout <= 0 waits as long as the session lives).
    if (left <= 0) throw fail(E.late);
    const most = budget === TIMINGS.COMMAND_BUDGET ? TIMINGS.COMMAND : budget - 1000;
    try {
      await cur.session.command(name, body, Math.min(most, left), urgent);
    } catch (err) {
      if (err?.code === 'refused') throw fail(E.refused(err.answer));
      if (err?.code === 'busy') throw fail(E.busy);
      if (err?.sent) throw fail(E.sentNoAnswer);
      throw fail(E.notConnected);
    }
  }

  /** Waits (within the budget) for the picture to show the command. */
  async confirm(check, started, budget = TIMINGS.COMMAND_BUDGET, most = TIMINGS.CONFIRM) {
    if (check()) return;
    const left = Math.min(most, budget - (this.monotonic() - started));
    if (left <= 0) throw fail(E.notConfirmed);
    const seen = await new Promise((resolve) => {
      let timer;
      const waiter = {
        check: () => {
          if (check()) waiter.done(true);
        },
        done: (value) => {
          if (!this.waiters.delete(waiter)) return;
          this.timers.clearTimeout(timer);
          resolve(value);
        },
      };
      this.waiters.add(waiter);
      timer = this.timers.setTimeout(() => waiter.done(false), left);
    });
    if (!seen) throw fail(E.notConfirmed);
  }

  async setValue(device, feature, value) {
    const started = this.monotonic();
    const key = featureKey(feature?.external_id);
    if (!Object.values(FEATURE).includes(key) || key === FEATURE.ZONE) throw fail(E.unknownFeature);
    const { cur, outputs } = this.resolveAll(device?.external_id);
    if (outputs.length > 1) return this.silenceAll(cur, outputs, key, value, started);
    const { output, swapped } = this.identity(cur, keyOfDeviceId(device.external_id), outputs);
    if (swapped) {
      // Never a command to the room that took this name: what silences goes
      // to the room the device was made for, the rest is refused.
      return this.silenceAll(cur, [swapped], key, value, started, E.swapped);
    }
    switch (key) {
      case FEATURE.PLAYBACK_STATE: {
        const state = numberOf(value, { integer: true, min: 0, max: 2 });
        const action =
          state === PLAYBACK.PLAYING ? 'play' : state === PLAYBACK.PAUSED ? 'pause' : 'stop';
        return this.playback(cur, output, action, started);
      }
      case FEATURE.PLAY:
        return this.playback(cur, output, 'play', started);
      case FEATURE.PAUSE:
        return this.playback(cur, output, 'pause', started);
      case FEATURE.PREVIOUS:
      case FEATURE.NEXT:
        this.bump(output.id);
        return this.send(cur, 'control', { zone_or_output_id: output.id, control: key }, started);
      case FEATURE.VOLUME:
        return this.volume(cur, output, numberOf(value, { min: 0, max: 100 }), started);
      case FEATURE.MUTE:
        return this.mute(
          cur,
          output,
          numberOf(value, { integer: true, min: 0, max: 1 }) === 1,
          started,
        );
      case FEATURE.POSITION:
        return this.seek(cur, output, numberOf(value, { min: 0, max: 604800 }), started);
      case FEATURE.SHUFFLE: {
        const shuffle = numberOf(value, { integer: true, min: 0, max: 1 }) === 1;
        this.bump(output.id);
        await this.send(cur, 'change_settings', { zone_or_output_id: output.id, shuffle }, started);
        return this.confirm(() => cur.roon.zoneOfOutput(output.id)?.shuffle === shuffle, started);
      }
      case FEATURE.REPEAT: {
        const repeat = numberOf(value, { integer: true, min: 0, max: 2 });
        this.bump(output.id);
        await this.send(
          cur,
          'change_settings',
          { zone_or_output_id: output.id, loop: REPEAT_TO_LOOP[repeat] },
          started,
        );
        return this.confirm(() => cur.roon.zoneOfOutput(output.id)?.repeat === repeat, started);
      }
      default:
        throw fail(E.unknownFeature);
    }
  }

  /**
   * Play, pause or stop the zone of an output. Pause and stop are never held
   * by anything but the absence of a session: a zone that cannot pause (a
   * live radio) is stopped instead.
   */
  async playback(cur, output, action, started) {
    let control = action;
    if (action === 'pause' && cur.roon.zoneOfOutput(output.id)?.allowed.pause === false) {
      control = 'stop';
    }
    this.bump(output.id);
    await this.send(cur, 'control', { zone_or_output_id: output.id, control }, started, {
      urgent: control !== 'play',
    });
    const wanted = action === 'play' ? ['playing', 'loading'] : ['paused', 'stopped'];
    return this.confirm(() => wanted.includes(cur.roon.zoneOfOutput(output.id)?.state), started);
  }

  /** Any volume Gladys asks, under the cap; a lower volume is never held. */
  async volume(cur, output, percent, started) {
    if (!hasVolume(output)) throw fail(E.noVolume);
    const target = volumeTarget(output.volume, percent, this.config.max_volume);
    if (target === undefined) throw fail(E.noVolume);
    this.bump(output.id);
    const lower = typeof output.volume.value === 'number' && target <= output.volume.value;
    await this.send(
      cur,
      'change_volume',
      { output_id: output.id, how: 'absolute', value: target },
      started,
      { urgent: lower },
    );
    const tolerance = (output.volume.step ?? 1) / 2 + 1e-6;
    return this.confirm(() => {
      const value = this.live(cur, output.id)?.volume?.value;
      return typeof value === 'number' && Math.abs(value - target) <= tolerance;
    }, started);
  }

  /**
   * Mute: sent as is. Unmute: a volume above the cap is first brought to
   * the cap (the volume known now; unknown = refused while a cap applies),
   * and the unmute leaves only if no other command for this output was
   * clicked meanwhile (nothing clicked before a mute goes after it).
   */
  async mute(cur, output, muted, started) {
    if (!hasVolume(output)) throw fail(E.noVolume);
    const seq = this.bump(output.id);
    if (!muted && this.config.max_volume < 100) {
      const percent = volumePercent(output.volume);
      if (percent === undefined) throw fail(E.volumeUnknown);
      if (percent > this.config.max_volume) {
        const target = volumeTarget(output.volume, this.config.max_volume, this.config.max_volume);
        await this.send(
          cur,
          'change_volume',
          { output_id: output.id, how: 'absolute', value: target },
          started,
          { urgent: true },
        );
        if (this.seq.get(output.id) !== seq) throw fail(E.cancelled);
      }
    }
    await this.send(
      cur,
      'mute',
      { output_id: output.id, how: muted ? 'mute' : 'unmute' },
      started,
      { urgent: muted },
    );
    return this.confirm(() => this.live(cur, output.id)?.volume?.muted === muted, started);
  }

  async seek(cur, output, seconds, started) {
    const zone = cur.roon.zoneOfOutput(output.id);
    if (!zone?.np || !(zone.np.length > 0) || zone.allowed.seek === false) throw fail(E.noTrack);
    this.bump(output.id);
    const target = Math.min(Math.round(seconds), Math.floor(zone.np.length));
    return this.send(
      cur,
      'seek',
      { zone_or_output_id: output.id, how: 'absolute', seconds: target },
      started,
    );
  }

  // --- Scene actions --------------------------------------------------------------------

  async groupWith(fields) {
    const started = this.monotonic();
    const main = this.resolve(fields?.device);
    const member = this.resolve(fields?.with);
    if (main.output.id === member.output.id) throw fail(E.sameOutput);
    const { cur } = main;
    if (!main.output.groupable.includes(member.output.id)) throw fail(E.notGroupable);
    this.bump(main.output.id);
    this.bump(member.output.id);
    await this.send(
      cur,
      'group_outputs',
      { output_ids: [main.output.id, member.output.id] },
      started,
      { budget: SCENE_BUDGET },
    );
    const together = () => {
      const zone = cur.roon.zoneOfOutput(main.output.id);
      return Boolean(zone?.outputIds.includes(member.output.id));
    };
    await this.confirm(together, started, SCENE_BUDGET, SCENE_BUDGET);
    return { zone: cur.roon.zoneOfOutput(main.output.id)?.name ?? '' };
  }

  async ungroup(fields) {
    const started = this.monotonic();
    const { cur, output } = this.resolve(fields?.device);
    const alone = () => {
      const zone = cur.roon.zoneOfOutput(output.id);
      return Boolean(zone) && zone.outputIds.length === 1;
    };
    if (!alone()) {
      this.bump(output.id);
      await this.send(cur, 'ungroup_outputs', { output_ids: [output.id] }, started, {
        budget: SCENE_BUDGET,
      });
      await this.confirm(alone, started, SCENE_BUDGET, SCENE_BUDGET);
    }
    return { zone: cur.roon.zoneOfOutput(output.id)?.name ?? '' };
  }

  // --- Artwork ----------------------------------------------------------------------------

  /** The bytes of an artwork key published by this run, fetched from the Core (base64). */
  async artwork(key) {
    const url = this.gladys.artworkUrls?.get(key);
    if (typeof url !== 'string' || !url.startsWith(ARTWORK_PREFIX)) throw fail('Unknown artwork.');
    const imageKey = url.slice(ARTWORK_PREFIX.length);
    if (!IMAGE_KEY.test(imageKey)) throw fail('Unknown artwork.');
    const cur = this.current;
    if (!cur?.registered || !cur.session.alive) throw fail(E.notConnected);
    let image;
    try {
      image = await cur.session.image(imageKey);
    } catch (err) {
      throw fail(err?.code === 'refused' ? E.refused(err.answer) : E.notConnected);
    }
    if (
      image.data.length === 0 ||
      image.data.length > LIMITS.ARTWORK_BYTES ||
      !imageKind(image.data)
    ) {
      throw fail('Artwork refused (not a small JPEG, PNG or WebP).');
    }
    return image.data.toString('base64');
  }

  // --- Configuration buttons ---------------------------------------------------------------

  /** Finds the Cores of the LAN (SOOD through the Gladys core); one found fills an empty address. */
  async findCore() {
    if (this.finding) return T.findBusy;
    this.finding = true;
    try {
      const tid = this.random();
      let results;
      try {
        results = await this.gladys.scanNetwork('udp-active-broadcast', {
          port: SOOD_PORT,
          payload: buildQuery(tid),
          timeoutSeconds: Math.round(TIMINGS.FIND / 1000),
        });
      } catch (err) {
        this.logger.warn(`roon: search failed (${err?.name ?? 'Error'})`);
        return T.findFailed;
      }
      const cores = coresFound(results, tid);
      if (cores.length === 0) return T.findNone;
      const label = (core) => `${core.name} (${core.host}:${core.port})`;
      if (cores.length === 1 && !this.config?.host) {
        const [core] = cores;
        try {
          await this.gladys.setConfig({ host: core.host, port: core.port });
          // Applied now (Gladys may also send it back as a configuration update).
          await this.configUpdated({
            host: core.host,
            port: core.port,
            max_volume: this.config?.max_volume ?? DEFAULT_MAX_VOLUME,
          });
          return T.findSaved(label(core));
        } catch (err) {
          this.logger.warn(`roon: address not saved (${err?.name ?? 'Error'})`);
        }
      }
      return T.findList(cores.map(label).join(', '));
    } finally {
      this.finding = false;
    }
  }

  /** What the integration sees now (never a new connection: the session runs on its own). */
  testConnection() {
    const cur = this.current;
    let status;
    if (this.storeError) status = T.storeUnreadable(this.storeError);
    else if (!this.config || !isConnectable(this.config)) status = T.notConfigured;
    else if (cur?.ready) status = T.connected(this.coreName(cur), cur.roon.outputs.size);
    else if (cur?.core && !cur.registered) status = T.waiting(this.coreName(cur));
    else status = cur?.lastStatus ?? T.lost(this.retryDelay);
    return T.test(status, this.config?.max_volume ?? 0);
  }

  /** Forgets every token (the user enables the extension again), and reconnects. */
  forgetAuthorization() {
    return this.serialize(async () => {
      try {
        await this.store.save(this.snapshot(new Map()));
      } catch (err) {
        this.logger.warn(`roon: /data not written (${err?.code ?? 'Error'})`);
        return T.forgetFailed;
      }
      this.tokens = new Map();
      this.storeError = undefined;
      this.tokenUnsaved = false;
      await this.closeSession();
      this.retryDelay = TIMINGS.RETRY_MIN;
      this.lastStatus = undefined;
      if (this.config) this.openSession();
      return T.forgotten;
    });
  }
}

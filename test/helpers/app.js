// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Roon Core on a real loopback
// WebSocket and a virtual clock that moves at every read (1 µs): the timers
// of the app (flush, confirmation, keepalive, retries) fire only through
// `clock.advance`, the network is real.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { memoryLogger, testClock } from '../kit/index.mjs';
import { RoonApp } from '../../src/app.js';
import { TIMINGS } from '../../src/constants.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { fakeCore } from './fakeCore.js';

export const SELECTOR = 'roon';

/** Waits (real time) until `check()` is truthy. */
export async function until(check, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The device of an output as the user created it in Gladys. */
export function created(name, { volume = true, id } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, { name, volume: volume ? { type: 'number' } : undefined });
  device.id = id ?? `device-${name}`;
  return device;
}

export async function setup({
  core: coreOptions,
  devices = [],
  store = createMemoryStore(),
  config,
  start = true,
} = {}) {
  const core = await fakeCore(coreOptions);
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { host: '127.0.0.1', port: core.port, max_volume: 50 },
    devices,
  });
  await gladys.connect();
  const clock = testClock();
  const logger = memoryLogger();
  const app = new RoonApp({
    gladys,
    logger,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    random: () => 'tid-1',
  });
  registerHandlers(gladys, app, logger);
  const env = {
    core,
    gladys,
    clock,
    logger,
    app,
    store,
    /** Lets the flush run (virtual time) and waits for the app. */
    async flush() {
      await clock.advance(TIMINGS.FLUSH);
      await app.idle();
    },
    /** Waits for a complete picture, then publishes it. */
    async ready() {
      await until(() => app.current?.ready, 'the picture of the Core');
      await env.flush();
    },
    status: () => gladys.fake.connectionStatus,
    last: (name, key) => gladys.fake.lastState(`${created(name).external_id}:${key}`),
    feature: (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    async close() {
      await app.stop();
      await core.close();
    },
  };
  if (start) {
    await app.connected(() => gladys.getConfig());
    await app.idle();
  }
  return env;
}

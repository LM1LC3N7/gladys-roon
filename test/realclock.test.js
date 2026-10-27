// -----------------------------------------------------------------------------
// The app on a REAL moving clock sped up 20 times (performance.now and real
// timers) against the fake Core on a real loopback WebSocket: the keepalive
// really runs every 10 s, the reconnections really wait 5 s then 10 s, and a
// command never applied answers within the 3.5 s budget. Periods measured on
// the methods that decide; margins wide (late under load, never early).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, memoryLogger, realClock, refusePort, spyOn } from './kit/index.mjs';
import { RoonApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { RoonSession } from '../src/roon/session.js';
import { createMemoryStore } from '../src/store.js';
import { created, until } from './helpers/app.js';
import { fakeCore } from './helpers/fakeCore.js';

const SPEED = 20;

async function realApp(config, devices = []) {
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'roon', config, devices });
  await gladys.connect();
  const app = new RoonApp({
    gladys,
    logger: memoryLogger(),
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
  });
  registerHandlers(gladys, app, memoryLogger());
  return { clock, gladys, app };
}

test('real clock x20: the keepalive every 10 s keeps a live session', async (t) => {
  const core = await fakeCore();
  t.after(() => core.close());
  const { clock, app, gladys } = await realApp({ host: '127.0.0.1', port: core.port });
  const spy = spyOn(RoonSession.prototype, 'checkAlive', clock);
  t.after(() => {
    spy.restore();
    clock.close();
  });
  await app.connected(() => gladys.getConfig());
  await measurePeriod(spy, { count: 4, period: TIMINGS.KEEPALIVE });
  assert.equal(app.current?.session.alive, true, 'pongs keep it');
  assert.equal(core.connections, 1);
  await app.stop();
});

test('real clock x20: an unreachable Core is tried again after 5 s, then 10 s', async (t) => {
  const refused = await refusePort();
  const { clock, app, gladys } = await realApp({ host: '127.0.0.1', port: refused.port });
  const spy = spyOn(app, 'openSession', clock);
  t.after(() => {
    spy.restore();
    clock.close();
  });
  await app.connected(() => gladys.getConfig());
  await until(() => spy.calls.length >= 3, 'three tries', 10_000);
  await app.stop();
  const at = spy.calls.map((c) => c.at);
  const gaps = [at[1] - at[0], at[2] - at[1]];
  assert.ok(gaps[0] >= 0.9 * 5000 && gaps[0] <= 1.5 * 5000 + 2000, `first gap ${gaps[0]}`);
  assert.ok(gaps[1] >= 0.9 * 10000 && gaps[1] <= 1.5 * 10000 + 2000, `second gap ${gaps[1]}`);
});

test('real clock x20: a command the Core never applies answers within the budget', async (t) => {
  const core = await fakeCore();
  t.after(() => core.close());
  const device = created('Living room');
  const { clock, app, gladys } = await realApp({ host: '127.0.0.1', port: core.port }, [device]);
  t.after(() => clock.close());
  await app.connected(() => gladys.getConfig());
  await until(() => app.current?.ready, 'ready', 5000);
  core.never = true;
  const started = clock.monotonic();
  const feature = device.features.find((f) => f.external_id.endsWith(':play'));
  const ack = await gladys.fake.setValue(device, feature, 1);
  const took = clock.monotonic() - started;
  assert.equal(ack.success, false);
  assert.ok(took <= TIMINGS.COMMAND_BUDGET + 1000, `answered after ${Math.round(took)} ms`);
  assert.ok(took >= TIMINGS.CONFIRM * 0.9, 'waited for the confirmation');
  await app.stop();
});

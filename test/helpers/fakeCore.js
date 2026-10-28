// -----------------------------------------------------------------------------
// A fake Roon Core on a loopback WebSocket (the real `ws` server), speaking
// MOO/1 with its own small encoder and parser (not the module's, so that a
// bug in src/roon/moo.js is not mirrored here). It keeps zones and outputs,
// answers the registry, the transport and the image services the way the
// node-roon-api documentation describes them, and pushes `Changed` messages
// like a Core. Knobs: authorization by click, latency, commands left
// unanswered or refused, changes applied late or never.
// -----------------------------------------------------------------------------

import { WebSocketServer } from 'ws';

const TRANSPORT = 'com.roonlabs.transport:2';

/** One MOO message, as a Core writes it. */
export function mooMessage(verb, name, requestId, body, contentType = 'application/json') {
  let header = `MOO/1 ${verb} ${name}\nRequest-Id: ${requestId}\n`;
  if (body === undefined) return Buffer.from(`${header}\n`);
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  header += `Content-Length: ${data.length}\nContent-Type: ${contentType}\n\n`;
  return Buffer.concat([Buffer.from(header), data]);
}

function readMessage(buf) {
  const text = buf.toString('utf8');
  const end = text.indexOf('\n\n');
  const [first, ...headers] = text.slice(0, end).split('\n');
  const [, verb, name] = /^MOO\/1 (\w+) (.+)$/.exec(first);
  const fields = Object.fromEntries(headers.map((h) => h.split(/: */)));
  const body = fields['Content-Length'] ? JSON.parse(text.slice(end + 2)) : undefined;
  return { verb, name, requestId: Number(fields['Request-Id']), body };
}

export const volume = (value = 30, extra = {}) => ({
  type: 'number',
  min: 0,
  max: 100,
  value,
  step: 1,
  is_muted: false,
  ...extra,
});

export function makeOutput(id, name, extra = {}) {
  return {
    output_id: id,
    zone_id: `z-${id}`,
    display_name: name,
    volume: volume(),
    can_group_with_output_ids: [],
    ...extra,
  };
}

export function makeZone(outputs, extra = {}) {
  return {
    zone_id: outputs[0].zone_id,
    display_name: outputs.map((o) => o.display_name).join(' + '),
    outputs,
    state: 'stopped',
    is_play_allowed: true,
    is_pause_allowed: true,
    is_previous_allowed: true,
    is_next_allowed: true,
    is_seek_allowed: true,
    settings: { loop: 'disabled', shuffle: false, auto_radio: true },
    ...extra,
  };
}

export const TRACK = {
  seek_position: 12,
  length: 240,
  image_key: 'a1b2c3d4e5',
  one_line: { line1: 'Blue in Green - Miles Davis' },
  two_line: { line1: 'Blue in Green', line2: 'Miles Davis' },
  three_line: { line1: 'Blue in Green', line2: 'Miles Davis', line3: 'Kind of Blue' },
};

/** A JPEG small enough for Gladys. */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

export async function fakeCore({
  coreId = 'core-1',
  name = 'Roon Server',
  version = '2.0 (build 1500)',
  token = 'tok-secret-123',
  authorized = true,
  outputs: initial = [makeOutput('o1', 'Living room'), makeOutput('o2', 'Kitchen')],
  latencyMs = 0,
} = {}) {
  const core = {
    coreId,
    name,
    version,
    token,
    authorized,
    latencyMs,
    /** Command names left without answer, or answered with another name: `{ name: 'InvalidRequest' }`. */
    silent: new Set(),
    refuse: {},
    /** Applied this long after the Success (`never`: not applied). */
    applyDelayMs: 0,
    never: false,
    zones: new Map(),
    connections: 0,
    open: 0,
    requests: [],
    registers: [],
    pendingRegister: [],
    image: JPEG,
    clients: new Set(),
  };
  for (const output of initial) {
    core.zones.set(output.zone_id, makeZone([output]));
  }
  core.outputs = () => [...core.zones.values()].flatMap((z) => z.outputs);
  core.output = (id) => core.outputs().find((o) => o.output_id === id);
  core.zoneOf = (id) =>
    [...core.zones.values()].find((z) => z.outputs.some((o) => o.output_id === id));

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api' });
  await new Promise((resolve) => server.once('listening', resolve));
  core.port = server.address().port;
  core.url = `127.0.0.1:${core.port}`;

  const send = (ws, ...args) => {
    if (ws.readyState === 1) ws.send(mooMessage(...args));
  };
  const later = (fn) => (core.latencyMs ? setTimeout(fn, core.latencyMs) : fn());

  /** Pushes the zones listed (or all) to every subscriber. */
  core.pushZones = (zoneIds = [...core.zones.keys()], removed = []) => {
    for (const client of core.clients) {
      if (client.zonesKey === undefined) continue;
      const zones = zoneIds.map((id) => core.zones.get(id)).filter(Boolean);
      send(client.ws, 'CONTINUE', 'Changed', client.zonesKey, {
        ...(zones.length ? { zones_changed: zones } : {}),
        ...(removed.length ? { zones_removed: removed } : {}),
      });
    }
  };
  core.pushOutputs = (outputIds, removed = []) => {
    for (const client of core.clients) {
      if (client.outputsKey === undefined) continue;
      const outputs = outputIds.map(core.output).filter(Boolean);
      send(client.ws, 'CONTINUE', 'Changed', client.outputsKey, {
        ...(outputs.length ? { outputs_changed: outputs } : {}),
        ...(removed.length ? { outputs_removed: removed } : {}),
      });
    }
  };
  core.seek = (zoneId, seconds) => {
    const zone = core.zones.get(zoneId);
    if (zone.now_playing) zone.now_playing.seek_position = seconds;
    for (const client of core.clients) {
      if (client.zonesKey === undefined) continue;
      send(client.ws, 'CONTINUE', 'Changed', client.zonesKey, {
        zones_seek_changed: [{ zone_id: zoneId, seek_position: seconds }],
      });
    }
  };
  /** The user enables the extension in Roon: every register waiting is answered. */
  core.authorize = () => {
    core.authorized = true;
    for (const { ws, requestId } of core.pendingRegister.splice(0)) {
      send(ws, 'COMPLETE', 'Registered', requestId, {
        core_id: core.coreId,
        token: core.token,
        display_name: core.name,
        provided_services: [TRANSPORT, 'com.roonlabs.image:1'],
      });
    }
  };
  /** The Core asks the extension (ping); resolves with its answer. */
  core.ask = (service, name) =>
    new Promise((resolve) => {
      const [client] = core.clients;
      client.asked = resolve;
      send(client.ws, 'REQUEST', `${service}/${name}`, 9000);
    });
  core.dropAll = () => {
    for (const client of core.clients) client.ws.terminate();
  };

  const apply = (fn, zoneIds, outputIds = []) => {
    const run = () => {
      fn();
      if (outputIds.length) core.pushOutputs(outputIds);
      core.pushZones(zoneIds);
    };
    if (core.never) return;
    if (core.applyDelayMs) setTimeout(run, core.applyDelayMs);
    else run();
  };

  const commands = {
    control(body) {
      const zone = core.zoneOf(body.zone_or_output_id);
      if (!zone || core.refuseFor?.has(body.zone_or_output_id)) return 'InvalidRequest';
      const next = { play: 'playing', pause: 'paused', stop: 'stopped' }[body.control];
      if (body.control === 'pause' && zone.is_pause_allowed === false) return 'InvalidRequest';
      if (next) {
        apply(() => {
          zone.state = next;
          if (next === 'playing' && !zone.now_playing) zone.now_playing = structuredClone(TRACK);
        }, [zone.zone_id]);
      }
      return 'Success';
    },
    change_volume(body) {
      const output = core.output(body.output_id);
      if (!output?.volume) return 'InvalidRequest';
      apply(() => (output.volume.value = body.value), [output.zone_id], [output.output_id]);
      return 'Success';
    },
    mute(body) {
      const output = core.output(body.output_id);
      if (!output?.volume) return 'InvalidRequest';
      apply(
        () => (output.volume.is_muted = body.how === 'mute'),
        [output.zone_id],
        [output.output_id],
      );
      return 'Success';
    },
    change_settings(body) {
      const zone = core.zoneOf(body.zone_or_output_id);
      if (!zone) return 'InvalidRequest';
      apply(() => {
        if ('shuffle' in body) zone.settings.shuffle = body.shuffle;
        if ('loop' in body) zone.settings.loop = body.loop;
      }, [zone.zone_id]);
      return 'Success';
    },
    seek(body) {
      const zone = core.zoneOf(body.zone_or_output_id);
      if (!zone?.now_playing) return 'InvalidRequest';
      apply(() => core.seek(zone.zone_id, body.seconds), []);
      return 'Success';
    },
    group_outputs(body) {
      const [first, ...rest] = body.output_ids;
      const main = core.zoneOf(first);
      if (!main) return 'InvalidRequest';
      apply(() => {
        const removed = [];
        for (const id of rest) {
          const zone = core.zoneOf(id);
          const output = core.output(id);
          zone.outputs = zone.outputs.filter((o) => o.output_id !== id);
          if (zone.outputs.length === 0) {
            core.zones.delete(zone.zone_id);
            removed.push(zone.zone_id);
          }
          output.zone_id = main.zone_id;
          main.outputs.push(output);
        }
        main.display_name = main.outputs.map((o) => o.display_name).join(' + ');
        core.pushZones([main.zone_id], removed);
      }, []);
      return 'Success';
    },
    ungroup_outputs(body) {
      apply(() => {
        const changed = [];
        for (const id of body.output_ids) {
          const zone = core.zoneOf(id);
          const output = core.output(id);
          zone.outputs = zone.outputs.filter((o) => o.output_id !== id);
          zone.display_name = zone.outputs.map((o) => o.display_name).join(' + ');
          output.zone_id = `z-${id}`;
          core.zones.set(output.zone_id, makeZone([output]));
          changed.push(zone.zone_id, output.zone_id);
        }
        core.pushZones(changed);
      }, []);
      return 'Success';
    },
  };

  server.on('connection', (ws) => {
    core.connections += 1;
    core.open += 1;
    const client = { ws };
    core.clients.add(client);
    ws.on('close', () => {
      core.open -= 1;
      core.clients.delete(client);
      core.pendingRegister = core.pendingRegister.filter((p) => p.ws !== ws);
    });
    ws.on('message', (data) => {
      const msg = readMessage(Buffer.from(data));
      if (msg.verb !== 'REQUEST') {
        client.asked?.(msg);
        return;
      }
      core.requests.push({ name: msg.name, body: msg.body });
      const short = msg.name.split('/').at(-1);
      later(() => {
        if (msg.name === 'com.roonlabs.registry:1/info') {
          send(ws, 'COMPLETE', 'Success', msg.requestId, {
            core_id: core.coreId,
            display_name: core.name,
            display_version: core.version,
          });
        } else if (msg.name === 'com.roonlabs.registry:1/register') {
          core.registers.push(msg.body);
          if (core.authorized || (msg.body.token && msg.body.token === core.token)) {
            core.pendingRegister.push({ ws, requestId: msg.requestId });
            core.authorize();
          } else {
            core.pendingRegister.push({ ws, requestId: msg.requestId });
          }
        } else if (msg.name === `${TRANSPORT}/subscribe_zones`) {
          client.zonesKey = msg.requestId;
          send(ws, 'CONTINUE', 'Subscribed', msg.requestId, { zones: [...core.zones.values()] });
        } else if (msg.name === `${TRANSPORT}/subscribe_outputs`) {
          client.outputsKey = msg.requestId;
          send(ws, 'CONTINUE', 'Subscribed', msg.requestId, { outputs: core.outputs() });
        } else if (msg.name === 'com.roonlabs.image:1/get_image') {
          if (core.silent.has('get_image')) return;
          send(ws, 'COMPLETE', 'Success', msg.requestId, core.image, 'image/jpeg');
        } else if (msg.name.startsWith(`${TRANSPORT}/`) && commands[short]) {
          if (core.silent.has(short)) return;
          if (core.refuse[short]) {
            send(ws, 'COMPLETE', core.refuse[short], msg.requestId, { error: 'no' });
            return;
          }
          const answer = commands[short](msg.body);
          send(
            ws,
            'COMPLETE',
            answer,
            msg.requestId,
            answer === 'Success' ? undefined : { error: 'x' },
          );
        } else {
          send(ws, 'COMPLETE', 'InvalidRequest', msg.requestId, { error: 'unknown' });
        }
      });
    });
  });

  core.commands = (name) =>
    core.requests.filter((r) => r.name === `${TRANSPORT}/${name}`).map((r) => r.body);
  let closing;
  core.close = () => {
    if (!closing) {
      for (const client of core.clients) client.ws.terminate();
      closing = new Promise((resolve) => server.close(() => resolve()));
    }
    return closing;
  };
  return core;
}

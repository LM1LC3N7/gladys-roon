// -----------------------------------------------------------------------------
// What the transport service says -> what Gladys shows (pure). The zones and
// the outputs arrive by subscription (`Subscribed` with the whole list, then
// `Changed` with what was added, changed, removed, and the seek positions);
// each message is checked and bounded field by field, nothing is copied from
// it as is (no prototype pollution, no unbounded text).
//
// Field names from node-roon-api-transport (Apache-2.0, Roon Labs), the
// volume percent and the now playing lines as Home Assistant reads them
// (roon integration, Apache-2.0).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

/** MUSIC_PLAYBACK_STATE of the Gladys core. */
export const PLAYBACK = Object.freeze({ PAUSED: 0, PLAYING: 1, IDLE: 2, BUFFERING: 3 });
/** MUSIC_REPEAT_MODE of the Gladys core <-> the `loop` setting of a zone. */
export const REPEAT = Object.freeze({ OFF: 0, ALL: 1, ONE: 2 });
const LOOP_TO_REPEAT = { disabled: REPEAT.OFF, loop: REPEAT.ALL, loop_one: REPEAT.ONE };
export const REPEAT_TO_LOOP = ['disabled', 'loop', 'loop_one'];

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isPlain(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);
/** Control characters (C0 and DEL) replaced by spaces. */
export const noControl = (value) =>
  value.replace(/[\s\S]/g, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c));
/** A text shown by Gladys: control characters removed, at most 200 characters. */
export const text = (value) =>
  typeof value === 'string' ? noControl(value).trim().slice(0, LIMITS.TEXT) : '';
const id = (value) => (typeof value === 'string' && ID.test(value) ? value : undefined);

const STATES = new Set(['playing', 'paused', 'loading', 'stopped']);

/** The volume of an output, or undefined (a fixed volume). */
function volumeOf(raw) {
  if (!isPlain(raw)) return undefined;
  const type = typeof raw.type === 'string' ? raw.type : 'number';
  const muted = bool(own(raw, 'is_muted'));
  if (type === 'incremental') return { type, muted };
  const min = own(raw, 'min');
  const max = own(raw, 'max');
  const value = own(raw, 'value');
  const step = own(raw, 'step');
  if (!finite(min) || !finite(max) || !(max > min)) return { type: 'incremental', muted };
  return {
    // "If you receive an unanticipated value for this, treat it like number".
    type: type === 'db' ? 'db' : 'number',
    min,
    max,
    value: finite(value) ? value : undefined,
    step: finite(step) && step > 0 ? step : undefined,
    muted,
    hardMax: finite(own(raw, 'hard_limit_max')) ? own(raw, 'hard_limit_max') : undefined,
    softMax: finite(own(raw, 'soft_limit')) ? own(raw, 'soft_limit') : undefined,
  };
}

/** An output -> `{ id, zoneId, name, volume, groupable }`, or undefined. */
export function outputOf(raw) {
  const outputId = id(own(raw, 'output_id'));
  const name = text(own(raw, 'display_name'));
  if (!outputId || !name) return undefined;
  const groupable = own(raw, 'can_group_with_output_ids');
  return {
    id: outputId,
    zoneId: id(own(raw, 'zone_id')),
    name,
    volume: volumeOf(own(raw, 'volume')),
    groupable: Array.isArray(groupable)
      ? groupable.slice(0, LIMITS.OUTPUTS).map(id).filter(Boolean)
      : [],
  };
}

/** The now playing lines -> `{ title, artist, album }` (three_line, else two_line, else one_line). */
function linesOf(np) {
  const three = own(np, 'three_line');
  if (isPlain(three)) {
    return {
      title: text(own(three, 'line1')),
      artist: text(own(three, 'line2')),
      album: text(own(three, 'line3')),
    };
  }
  const two = own(np, 'two_line');
  if (isPlain(two)) {
    return { title: text(own(two, 'line1')), artist: text(own(two, 'line2')), album: '' };
  }
  return { title: text(own(own(np, 'one_line'), 'line1')), artist: '', album: '' };
}

/** A zone -> `{ id, name, state, outputIds, outputs, allowed, seek, np, shuffle, repeat }`. */
export function zoneOf(raw) {
  const zoneId = id(own(raw, 'zone_id'));
  if (!zoneId) return undefined;
  const state = own(raw, 'state');
  const rawOutputs = own(raw, 'outputs');
  const outputs = Array.isArray(rawOutputs)
    ? rawOutputs.slice(0, LIMITS.OUTPUTS_PER_ZONE).map(outputOf).filter(Boolean)
    : [];
  const np = own(raw, 'now_playing');
  const settings = own(raw, 'settings');
  const loop = own(settings, 'loop');
  const length = own(np, 'length');
  const seek = own(np, 'seek_position') ?? own(raw, 'seek_position');
  const image = own(np, 'image_key');
  return {
    id: zoneId,
    name: text(own(raw, 'display_name')),
    state: STATES.has(state) ? state : undefined,
    outputIds: outputs.map((o) => o.id),
    outputs,
    allowed: {
      play: bool(own(raw, 'is_play_allowed')),
      pause: bool(own(raw, 'is_pause_allowed')),
      previous: bool(own(raw, 'is_previous_allowed')),
      next: bool(own(raw, 'is_next_allowed')),
      seek: bool(own(raw, 'is_seek_allowed')),
    },
    seek: finite(seek) && seek >= 0 ? seek : undefined,
    np: isPlain(np)
      ? {
          ...linesOf(np),
          length: finite(length) && length > 0 ? length : 0,
          image: typeof image === 'string' && ID.test(image) ? image : undefined,
        }
      : undefined,
    shuffle: bool(own(settings, 'shuffle')),
    repeat:
      typeof loop === 'string' && Object.hasOwn(LOOP_TO_REPEAT, loop)
        ? LOOP_TO_REPEAT[loop]
        : undefined,
  };
}

/** Roon zone state -> MUSIC_PLAYBACK_STATE. */
export function playbackOf(state) {
  switch (state) {
    case 'playing':
      return PLAYBACK.PLAYING;
    case 'paused':
      return PLAYBACK.PAUSED;
    case 'loading':
      return PLAYBACK.BUFFERING;
    case 'stopped':
      return PLAYBACK.IDLE;
    default:
      return undefined;
  }
}

/** The volume of an output in percent of its range (0-100, rounded), or undefined. */
export function volumePercent(volume) {
  if (!volume || volume.type === 'incremental' || !finite(volume.value)) return undefined;
  const pct = ((volume.value - volume.min) / (volume.max - volume.min)) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/**
 * The native value to write for `percent` (0-100), under the cap (percent of
 * the range, rounded DOWN to a step: a wrong value may make a player quieter,
 * never louder), and under the limits the output declares.
 */
export function volumeTarget(volume, percent, capPercent) {
  if (!volume || volume.type === 'incremental') return undefined;
  const pct = Math.min(Math.max(0, percent), 100);
  const range = volume.max - volume.min;
  let value = volume.min + (range * pct) / 100;
  // The ceiling: the cap, then every limit the output declares.
  let ceiling = volume.min + (range * Math.min(capPercent, 100)) / 100;
  for (const limit of [volume.hardMax, volume.softMax, volume.max]) {
    if (finite(limit)) ceiling = Math.min(ceiling, limit);
  }
  value = Math.min(value, ceiling);
  if (volume.step) {
    value = volume.min + Math.floor((value - volume.min) / volume.step + 1e-9) * volume.step;
  }
  // Floating point: never a hair above the ceiling nor under the minimum.
  value = Math.max(volume.min, Math.min(value, ceiling));
  return Math.round(value * 1000) / 1000;
}

/**
 * The live picture of one Core: the zones and the outputs, updated by the
 * subscription messages. Outputs come from both subscriptions (the zone
 * carries its outputs with their volume); the last message wins.
 */
export class RoonState {
  constructor() {
    this.zones = new Map();
    this.outputs = new Map();
    /** Both lists were received once (`Subscribed`): the picture is complete. */
    this.ready = { zones: false, outputs: false };
  }

  get complete() {
    return this.ready.zones && this.ready.outputs;
  }

  setOutput(output) {
    if (!this.outputs.has(output.id) && this.outputs.size >= LIMITS.OUTPUTS) return;
    this.outputs.set(output.id, output);
  }

  setZone(zone) {
    if (!this.zones.has(zone.id) && this.zones.size >= LIMITS.ZONES) return;
    this.zones.set(zone.id, zone);
    for (const output of zone.outputs) {
      // The zone of an output is the zone that lists it.
      this.setOutput({ ...output, zoneId: zone.id });
    }
  }

  /** A `zones` subscription message; returns the ids of the zones touched. */
  applyZones(name, body) {
    const touched = new Set();
    const list = (key) => {
      const value = own(body, key);
      return Array.isArray(value) ? value.slice(0, LIMITS.ZONES) : [];
    };
    if (name === 'Subscribed') {
      for (const zoneId of this.zones.keys()) touched.add(zoneId);
      this.zones.clear();
      for (const raw of list('zones')) {
        const zone = zoneOf(raw);
        if (zone) {
          this.setZone(zone);
          touched.add(zone.id);
        }
      }
      this.ready.zones = true;
      return touched;
    }
    if (name !== 'Changed') return touched;
    for (const zoneId of list('zones_removed')) {
      if (typeof zoneId === 'string' && this.zones.delete(zoneId)) touched.add(zoneId);
    }
    for (const raw of [...list('zones_added'), ...list('zones_changed')]) {
      const zone = zoneOf(raw);
      if (zone) {
        this.setZone(zone);
        touched.add(zone.id);
      }
    }
    for (const raw of list('zones_seek_changed')) {
      const zone = this.zones.get(own(raw, 'zone_id'));
      const seek = own(raw, 'seek_position');
      if (zone && finite(seek) && seek >= 0) {
        this.zones.set(zone.id, { ...zone, seek });
        touched.add(zone.id);
      }
    }
    return touched;
  }

  /** An `outputs` subscription message; returns the ids of the outputs touched. */
  applyOutputs(name, body) {
    const touched = new Set();
    const list = (key) => {
      const value = own(body, key);
      return Array.isArray(value) ? value.slice(0, LIMITS.OUTPUTS) : [];
    };
    if (name === 'Subscribed') {
      for (const outputId of this.outputs.keys()) touched.add(outputId);
      this.outputs.clear();
      for (const zone of this.zones.values()) {
        for (const output of zone.outputs) this.setOutput({ ...output, zoneId: zone.id });
      }
      for (const raw of list('outputs')) {
        const output = outputOf(raw);
        if (output) {
          this.setOutput(output);
          touched.add(output.id);
        }
      }
      this.ready.outputs = true;
      return touched;
    }
    if (name !== 'Changed') return touched;
    for (const outputId of list('outputs_removed')) {
      if (typeof outputId === 'string' && this.outputs.delete(outputId)) touched.add(outputId);
    }
    for (const raw of [...list('outputs_added'), ...list('outputs_changed')]) {
      const output = outputOf(raw);
      if (output) {
        this.setOutput(output);
        touched.add(output.id);
      }
    }
    return touched;
  }

  /** The zone an output plays in (the zone listing it, else its zone_id). */
  zoneOfOutput(outputId) {
    for (const zone of this.zones.values()) {
      if (zone.outputIds.includes(outputId)) return zone;
    }
    const output = this.outputs.get(outputId);
    return output?.zoneId ? this.zones.get(output.zoneId) : undefined;
  }

  /** The outputs whose display name is `name` (the identity Gladys keeps). */
  outputsNamed(name) {
    return [...this.outputs.values()].filter((o) => o.name === name);
  }
}

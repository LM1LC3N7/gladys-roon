// -----------------------------------------------------------------------------
// One Gladys device per Roon output (a room, a speaker, a DAC), the way Home
// Assistant does it: an output keeps its name, while its zone changes with
// every grouping and Home Assistant saw output ids change. The identity is
// the output display name: `output:<16 hex of SHA-256(name)>` (renaming the
// output in Roon gives a new device, as in Home Assistant). Feature keys are
// the Gladys types; keys and id shape are forever.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURE } from './constants.js';

/** The platform id of an output: from its display name, Unicode-normalized. */
export const outputKey = (name) =>
  createHash('sha256').update(String(name).normalize('NFC'), 'utf8').digest('hex').slice(0, 16);

export const deviceIdOf = (gladys, name) => gladys.externalIds('output', outputKey(name)).device;

/** The output key of a device external id, or undefined when it is not one of ours. */
export function keyOfDeviceId(externalId) {
  const match = /:output:([0-9a-f]{16})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The feature key of a feature external id (`…:output:<key>:volume` -> `volume`). */
export const featureKey = (featureExternalId) =>
  String(featureExternalId ?? '')
    .split(':')
    .at(-1);

/** The volume of this output can be set by Gladys (a range, not +/- buttons). */
export const hasVolume = (output) => Boolean(output.volume) && output.volume.type !== 'incremental';

const feature = (deviceId, key, name, category, type, extra = {}) => ({
  name,
  external_id: `${deviceId}:${key}`,
  category,
  type,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: true,
  keep_history: false,
  ...extra,
});

/** The device of a live output (`{ name, volume }`). */
export function buildDevice(gladys, output, coreName = '') {
  const id = deviceIdOf(gladys, output.name);
  const M = T.MUSIC;
  const press = { has_feedback: false };
  const shown = { read_only: true, has_feedback: false, max: 0 };
  const seconds = { unit: U.SECONDS, max: 604800 };
  const features = [
    feature(id, FEATURE.PLAYBACK_STATE, 'Playback', C.MUSIC, M.PLAYBACK_STATE, { max: 2 }),
    feature(id, FEATURE.PLAY, 'Play', C.MUSIC, M.PLAY, press),
    feature(id, FEATURE.PAUSE, 'Pause', C.MUSIC, M.PAUSE, press),
    feature(id, FEATURE.PREVIOUS, 'Previous', C.MUSIC, M.PREVIOUS, press),
    feature(id, FEATURE.NEXT, 'Next', C.MUSIC, M.NEXT, press),
    feature(id, FEATURE.TITLE, 'Title', C.MUSIC, M.TITLE, shown),
    feature(id, FEATURE.ARTIST, 'Artist', C.MUSIC, M.ARTIST, shown),
    feature(id, FEATURE.ALBUM, 'Album', C.MUSIC, M.ALBUM, shown),
    feature(id, FEATURE.ARTWORK, 'Artwork', C.MUSIC, M.ARTWORK, shown),
    feature(id, FEATURE.DURATION, 'Duration', C.MUSIC, M.DURATION, { ...shown, ...seconds }),
    feature(id, FEATURE.POSITION, 'Position', C.MUSIC, M.POSITION, seconds),
    feature(id, FEATURE.SHUFFLE, 'Shuffle', C.MUSIC, M.SHUFFLE),
    feature(id, FEATURE.REPEAT, 'Repeat', C.MUSIC, M.REPEAT, { max: 2 }),
    ...(hasVolume(output)
      ? [
          feature(id, FEATURE.VOLUME, 'Volume', C.MUSIC, M.VOLUME, { max: 100 }),
          feature(id, FEATURE.MUTE, 'Mute', C.MUSIC, M.MUTE),
        ]
      : []),
    feature(id, FEATURE.ZONE, 'Zone', C.TEXT, T.TEXT.TEXT, shown),
  ];
  return {
    name: output.name,
    external_id: id,
    features,
    params: [
      { name: 'roon_output', value: output.name },
      ...(coreName ? [{ name: 'roon_core', value: coreName.slice(0, 64) }] : []),
    ],
  };
}

/**
 * The discovered device of an output already created: the features of the
 * created device that the output does not offer any more (a volume turned
 * fixed) are kept, so that a republication never removes one.
 */
export function mergeWithCreated(built, created) {
  if (!created) return built;
  const ids = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => !ids.has(f.external_id))
    .map((f) => ({
      name: f.name,
      external_id: f.external_id,
      category: f.category,
      type: f.type,
      min: f.min,
      max: f.max,
      read_only: f.read_only,
      has_feedback: f.has_feedback,
      keep_history: false,
      ...(f.unit ? { unit: f.unit } : {}),
    }));
  return { ...built, features: [...built.features, ...kept] };
}

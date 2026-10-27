// -----------------------------------------------------------------------------
// Timings, limits and the keys users store (manifest keys, feature keys,
// external id shape): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * What the Roon Core shows in Settings > Extensions. The extension id is
 * Gladys's own (never the one of another platform: lot 16, laundrify): the
 * Core keys the authorization on it, so it never changes.
 */
export const EXTENSION = Object.freeze({
  extension_id: 'com.gladysassistant.roon',
  display_name: 'Gladys Assistant',
  display_version: String(pkg.version),
  publisher: 'Gladys Assistant community (gladys-roon)',
  email: '14235706+LM1LC3N7@users.noreply.github.com',
  website: 'https://github.com/LM1LC3N7/gladys-roon',
});

export const SERVICES = Object.freeze({
  REGISTRY: 'com.roonlabs.registry:1',
  TRANSPORT: 'com.roonlabs.transport:2',
  IMAGE: 'com.roonlabs.image:1',
  PING: 'com.roonlabs.ping:1',
  STATUS: 'com.roonlabs.status:1',
});

/** The WebSocket port of a Roon Core 2.x (1.x used 9100). */
export const DEFAULT_PORT = 9330;
/** The SOOD discovery port and the service id of a Roon Core (node-roon-api sood.js). */
export const SOOD_PORT = 9003;
export const SOOD_CORE_SERVICE = '00720724-5143-4a9b-abac-0e50cba674bb';

/** Manifest keys (config screen buttons and scene actions). */
export const ACTIONS = Object.freeze({
  FIND: 'find_core',
  TEST: 'test_connection',
  FORGET: 'forget_authorization',
});
export const SCENE_ACTIONS = Object.freeze({
  GROUP: 'group_with',
  UNGROUP: 'ungroup',
});

/** Volume cap, percent of the range of each output (manifest default). */
export const DEFAULT_MAX_VOLUME = 50;

const SECOND = 1000;
export const TIMINGS = Object.freeze({
  /** Opening the WebSocket (TCP + upgrade). */
  CONNECT: 8 * SECOND,
  /** registry/info and the subscriptions. */
  REQUEST: 10 * SECOND,
  /** A command, under the 5 s Gladys gives an acknowledgement. */
  COMMAND: 3 * SECOND,
  /** The state showing a command, after the Core said Success. */
  CONFIRM: 2 * SECOND,
  /** The whole budget of a command handler (Gladys cuts at 5 s). */
  COMMAND_BUDGET: 3.5 * SECOND,
  /** An artwork (Gladys waits 10 s). */
  IMAGE: 8 * SECOND,
  /** A WebSocket ping; no message nor pong for two of them closes the session. */
  KEEPALIVE: 10 * SECOND,
  /** Reconnection: 5 s, doubled up to 2 min. */
  RETRY_MIN: 5 * SECOND,
  RETRY_MAX: 120 * SECOND,
  /** getConfig() refused by Gladys: 5 s, doubled up to 5 min, without end. */
  CONFIG_RETRY_MIN: 5 * SECOND,
  CONFIG_RETRY_MAX: 300 * SECOND,
  /** States are gathered this long before they are published (one batch per change). */
  FLUSH: 250,
  /** A SOOD search through the Gladys core. */
  FIND: 4 * SECOND,
});

export const LIMITS = Object.freeze({
  /** One WebSocket message (an artwork is at most 300 KB for Gladys). */
  MESSAGE_BYTES: 1024 * 1024,
  /** A MOO header block. */
  HEADER_BYTES: 8 * 1024,
  HEADER_LINES: 32,
  /** Requests waiting for their answer, per session. */
  IN_FLIGHT: 64,
  ZONES: 100,
  OUTPUTS: 200,
  OUTPUTS_PER_ZONE: 32,
  TEXT: 200,
  ID: 128,
  /** Gladys checks the artwork: at most 300 KB decoded. */
  ARTWORK_BYTES: 300 * 1024,
  /** Gladys accepts 300 states a minute per integration. */
  STATES_PER_MINUTE: 280,
  /** SOOD answers kept per search. */
  FOUND: 16,
});

/** The feature keys (= the Gladys types; `zone` is a text feature). */
export const FEATURE = Object.freeze({
  PLAYBACK_STATE: 'playback_state',
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ARTWORK: 'artwork',
  DURATION: 'duration',
  POSITION: 'position',
  SHUFFLE: 'shuffle',
  REPEAT: 'repeat',
  VOLUME: 'volume',
  MUTE: 'mute',
  ZONE: 'zone',
});

/** The artwork "URL" recorded by gladys.artworkKey: an image key of the Core, fetched over MOO. */
export const ARTWORK_PREFIX = 'roon-image:';

// -----------------------------------------------------------------------------
// The configuration of the form (config_schema of the manifest), normalized:
// the rest of the code never sees a raw value. Defaults mirror the manifest.
// -----------------------------------------------------------------------------

import { isIPv4 } from 'node:net';
import { DEFAULT_MAX_VOLUME, DEFAULT_PORT } from './constants.js';

export const DEFAULT_CONFIG = Object.freeze({
  host: '',
  port: DEFAULT_PORT,
  max_volume: DEFAULT_MAX_VOLUME,
});

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** An IPv4 address a Roon Core can have: never 0.0.0.0, a broadcast or a multicast address. */
export function isUsableIPv4(address) {
  if (!isIPv4(address)) return false;
  const [a, , , d] = address.split('.').map(Number);
  return a !== 0 && a < 224 && d !== 255 && address !== '255.255.255.255';
}

/** The address typed by the user: an IPv4 address or a host name, else undefined. */
export function parseHost(raw) {
  if (typeof raw !== 'string') return undefined;
  const host = raw.trim();
  if (!host) return undefined;
  if (/^[\d.]+$/.test(host)) return isUsableIPv4(host) ? host : undefined;
  return HOSTNAME.test(host) ? host.toLowerCase() : undefined;
}

/** A strict integer from a number or a string of digits; anything else is undefined. */
function strictInteger(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^\s*\d{1,6}\s*$/.test(raw)) return Number(raw.trim());
  return undefined;
}

/**
 * `{ host, port, max_volume, invalid: [keys] }`. An empty address is "not
 * configured", a wrong one is listed in `invalid` (never connected to).
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const invalid = [];
  const rawHost = Object.hasOwn(source, 'host') ? source.host : '';
  const host = parseHost(rawHost);
  if (host === undefined && typeof rawHost === 'string' && rawHost.trim()) invalid.push('host');
  else if (
    rawHost !== '' &&
    rawHost !== null &&
    rawHost !== undefined &&
    typeof rawHost !== 'string'
  )
    invalid.push('host');

  let port = DEFAULT_PORT;
  if (Object.hasOwn(source, 'port') && source.port !== null && source.port !== '') {
    const value = strictInteger(source.port);
    if (value === undefined || value < 1 || value > 65535) invalid.push('port');
    else port = value;
  }

  let maxVolume = DEFAULT_MAX_VOLUME;
  if (
    Object.hasOwn(source, 'max_volume') &&
    source.max_volume !== null &&
    source.max_volume !== ''
  ) {
    const value = strictInteger(source.max_volume);
    // A wrong cap is the lowest one: a mistake may make a player quieter, never louder.
    maxVolume = value === undefined ? 1 : Math.min(100, Math.max(1, value));
    if (value === undefined || value < 1 || value > 100) invalid.push('max_volume');
  }
  return { host: host ?? '', port, max_volume: maxVolume, invalid };
}

/** The key of what a session is (a change reconnects). */
export const sessionKey = (config) =>
  JSON.stringify([config.host, config.port, config.invalid.filter((key) => key !== 'max_volume')]);

/** The Core can be reached: an address, and nothing wrong in the address or the port. */
export const isConnectable = (config) =>
  Boolean(config.host) && !config.invalid.includes('host') && !config.invalid.includes('port');

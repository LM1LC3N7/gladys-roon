// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// authorization token the Roon Core gave, by core id. A small JSON file,
// written through a temporary file and a rename, one save after the other.
// Taken from gladys-ecodevices (approved): a file that exists but cannot be
// read is NOT an empty state; `load()` says so (`ok: false`), and the app
// then neither writes /data (no overwrite) nor registers without the token
// (the Core would take it for another extension to enable again).
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/roon-state.json';
/** A larger file is not ours: unreadable (never taken for an empty state). */
const MAX_STATE_BYTES = 256 * 1024;

const isPlain = (data) => Boolean(data) && typeof data === 'object' && !Array.isArray(data);

/**
 * @returns {{ load(): { ok: true, data: object } | { ok: false, code: string },
 *   save(data: object): Promise<void> }}
 */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  };
  return {
    load() {
      try {
        if (statSync(file).size > MAX_STATE_BYTES) {
          return { ok: false, code: 'too_large' };
        }
        const data = JSON.parse(readFileSync(file, 'utf8'));
        return isPlain(data) ? { ok: true, data } : { ok: false, code: 'not_state' };
      } catch (err) {
        // No file yet (first start): an empty state. Anything else is not.
        if (err?.code === 'ENOENT') {
          return { ok: true, data: {} };
        }
        return {
          ok: false,
          code: typeof err?.code === 'string' ? err.code.slice(0, 20) : 'not_state',
        };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `broken` makes load fail, `failSave` makes save fail. */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  const store = {
    broken: false,
    failSave: false,
    saves: 0,
    load: () =>
      store.broken ? { ok: false, code: 'EIO' } : { ok: true, data: structuredClone(data) },
    async save(next) {
      if (store.failSave) {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      }
      store.saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
  return store;
}

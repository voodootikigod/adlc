// The decision-layer suite never touches the network (AC3). In-process tests
// call installNoNetwork(); spawned CLIs get NO_NETWORK_PRELOAD on --import, so
// a stray fetch fails the run instead of reaching a provider.
import { after } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Exit status of a spawned CLI that reached fetch. */
export const FETCH_EXIT_CODE = 97;

/** file:// URL of the preload that makes fetch fatal in a child process. */
export const NO_NETWORK_PRELOAD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'no-network-preload.mjs')).href;

/** Replace fetch for the rest of this test file; any call fails the calling test. */
export function installNoNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('decision-layer tests must not reach the network (fetch was called)');
  };
  after(() => { globalThis.fetch = original; });
}

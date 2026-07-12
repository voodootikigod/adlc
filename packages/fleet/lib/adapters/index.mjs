// WorkerAdapter registry (spec §4). The scheduler is harness-blind; live-deps
// resolves the configured adapter here. Adding a harness = adding a module and a
// line here — the scheduler and gates never change.

import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';
import * as agy from './agy.mjs';
import * as opencode from './opencode.mjs';
import * as pi from './pi.mjs';
import * as cursor from './cursor.mjs';

const REGISTRY = new Map([
  [claudeCode.name, claudeCode],
  [codex.name, codex],
  [agy.name, agy],
  [opencode.name, opencode],
  [pi.name, pi],
  [cursor.name, cursor],
]);

/** Registered adapter names, for validation/help. */
export const ADAPTERS = [...REGISTRY.keys()];

/**
 * Resolve a WorkerAdapter by name. Fails CLOSED on an unknown name — an
 * unrecognized `fleet.adapter` must abort the run, never silently fall back.
 */
export function getAdapter(name) {
  const adapter = REGISTRY.get(name);
  if (!adapter) {
    throw new Error(`unknown fleet worker adapter: "${name}". Registered adapters: ${ADAPTERS.join(', ')}`);
  }
  return adapter;
}

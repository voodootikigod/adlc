// WorkerAdapter registry (spec §4). The scheduler is harness-blind; live-deps
// resolves the configured adapter here. Adding a harness = adding a module and a
// line here — the scheduler and gates never change.

import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';
import * as agy from './agy.mjs';
import * as opencode from './opencode.mjs';
import * as pi from './pi.mjs';
import * as cursor from './cursor.mjs';
import * as copilot from './copilot.mjs';

const REGISTRY = new Map([
  [claudeCode.name, claudeCode],
  [codex.name, codex],
  [agy.name, agy],
  [opencode.name, opencode],
  [pi.name, pi],
  [cursor.name, cursor],
  [copilot.name, copilot],
]);

/** Registered adapter names, for validation/help. */
export const ADAPTERS = [...REGISTRY.keys()];

/**
 * The adapter catalog `@adlc/quartermaster` validates a registry against
 * (operating-stack §4b rules 2 and 6).
 *
 * This is the ONLY definition of "an adapter that exists" and "an alias this
 * harness resolves at run time" — the alias contract is adapter-OWNED, so the
 * registry loader reads it from here rather than restating harness knowledge.
 * Building it from REGISTRY (not a hand-written list) is what keeps rule 2's
 * allowlist identical to the set of modules in this directory: adding an adapter
 * cannot forget to update the validator.
 */
export function adapterCatalog() {
  return Object.fromEntries(
    [...REGISTRY.entries()].map(([adapterName, mod]) => [
      adapterName,
      {
        aliases: [...(mod.aliases ?? [])],
        // §4c: whether this adapter can put an explicit model on the command
        // line. Defaulting to FALSE is the fail-closed direction — an adapter
        // that forgets to declare it cannot be bound to a seat naming a model,
        // rather than silently running the harness's ambient default under a
        // plan that claims the registry's.
        forcesModel: mod.forcesModel === true,
        // §4c attest half. Fail-closed default again: an adapter that does not
        // declare it cannot be bound to an alias-based channel.
        attestsResolvedModel: mod.attestsResolvedModel === true,
      },
    ])
  );
}

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

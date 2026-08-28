// WorkerAdapter registry (spec §4). The scheduler is harness-blind; live-deps
// resolves the configured adapter here. Adding a harness = adding a module and a
// line here — the scheduler and gates never change.

import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';
import * as gemini from './gemini.mjs';
import * as agy from './agy.mjs';
import * as jetski from './jetski.mjs';
import * as opencode from './opencode.mjs';
import * as pi from './pi.mjs';
import * as cursor from './cursor.mjs';
import * as copilot from './copilot.mjs';

const REGISTRY = new Map([
  [claudeCode.name, claudeCode],
  [codex.name, codex],
  [gemini.name, gemini],
  [agy.name, agy],
  [jetski.name, jetski],
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
/**
 * One adapter's declared capabilities. Both booleans default to FALSE, which is
 * the fail-closed direction: an adapter that forgets to declare a capability
 * cannot be bound to a seat that needs it, rather than silently running the
 * harness's ambient default under a plan claiming the registry's model.
 */
function capabilitiesOf(mod) {
  const aliases = [...(mod.aliases ?? [])];
  const forcesModel = mod.forcesModel === true;
  const attestsResolvedModel = mod.attestsResolvedModel === true;
  // §4b transport classes (issue #396). Defaults to SERVES NONE — the same
  // fail-closed direction as the booleans above: an adapter that forgets to
  // declare a class cannot be bound to a seat that needs it, rather than
  // silently inheriting whatever ambient auth the host happens to carry.
  const transports = { ...(mod.transports ?? {}) };
  // §7.3 model-plane filesystem policy (#395). Defaults to DECLARES NOTHING, the
  // same fail-closed direction: an adapter that forgets to declare where its
  // harness keeps state gets no write grant outside the worktree, so the omission
  // shows up as that harness erroring loudly rather than as a silent hole.
  const homeState = {
    dirs: [...(mod.homeState?.dirs ?? [])],
    files: [...(mod.homeState?.files ?? [])],
  };
  // §6.4 model-plane egress allowlist (item 13). Defaults to DECLARES NOTHING,
  // fail-closed once more: under allowlist mode an adapter that names no hosts
  // gets NO egress, so the omission is a harness that cannot reach its model API
  // and says so, never a proxy that quietly opens every target.
  const egressHosts = [...(mod.egressHosts ?? [])];
  return { aliases, forcesModel, attestsResolvedModel, transports, homeState, egressHosts };
}

export function adapterCatalog() {
  return Object.fromEntries([...REGISTRY.entries()].map(([name, mod]) => [name, capabilitiesOf(mod)]));
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

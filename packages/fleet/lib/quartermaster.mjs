// The fleet ↔ quartermaster seam (operating-stack §4c, §5; ticket T151 item 3).
//
// Fleet dispatch resolves {adapter, model, transport} for each ticket from the
// OPERATOR-LOCAL registry, via the routing contract — never from the candidate
// tree, and never from a caller-supplied channel label. Everything the registry
// says is data; the execution shape stays inside the adapter modules.
//
// ENGAGEMENT (transitional, §9 item 3): the registry takes over dispatch when the
// operator has one — `ADLC_QUARTERMASTER_REGISTRY` is set, or the default
// home/XDG file exists. With neither, fleet keeps its pre-quartermaster behavior
// (`--adapter` + `fleet.model`). This is not a downgrade surface: both signals
// are operator-local, and a repo-committed config already cannot choose the
// adapter (adversarial-review K1) or the registry path (§4b). Once the operator
// HAS engaged, every §4b fail-closed rule applies — including a path that points
// inside the repo, which disables loading rather than reading it.

import { existsSync, readFileSync } from 'node:fs';
import { computeFloat, ADLC_DIR } from '@adlc/core';
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { assignAll } from '@adlc/model-router/lib/assign.mjs';
import { buildPriors } from '@adlc/model-router/lib/priors.mjs';
import { activeTickets as routableTickets } from '@adlc/model-router/lib/active-tickets.mjs';
import {
  HARNESS_DEFAULT_MODEL,
  REGISTRY_ENV,
  deriveBuildJob,
  loadRegistry,
  resolveRegistryPath,
  resolveRoute,
  routeJob,
} from '@adlc/quartermaster';
import { adapterCatalog, getAdapter } from './adapters/index.mjs';

/** True when the operator has a registry, so §4b/§5 govern dispatch. */
export function quartermasterEngaged({ env = process.env, repoDir, exists = existsSync } = {}) {
  const configured = env[REGISTRY_ENV];
  // A configured path engages the layer even when it is INVALID — otherwise
  // pointing the variable inside the repo would quietly fall back to the legacy
  // adapter instead of failing closed, which is the exact bypass §4 forbids.
  if (typeof configured === 'string' && configured.length > 0) return true;
  const resolved = resolveRegistryPath({ env, repoDir });
  // A DISABLED default path engages the layer for the same reason. It means the
  // home/XDG path resolved INSIDE the candidate tree — e.g. a wrapper exporting
  // XDG_CONFIG_HOME=$PWD/.config over a repo that ships .config/adlc/
  // quartermaster.json. Returning false there would skip loadRegistry entirely,
  // emit no notice, and dispatch on legacy selection: the repo would have
  // successfully suppressed the guard by making it refuse to look. Engaging
  // instead routes it into loadRegistry, which fails closed and says why.
  if (resolved.disabled) return true;
  return exists(resolved.path);
}

/**
 * §4c on the LEGACY path: `--model` must not be silently discarded.
 *
 * Registry seats are covered by the loader's force rule, but the un-engaged path
 * has no registry to validate. `cursor`, `pi`, and `copilot` do not accept a
 * model at all, so passing one there is dropped on the floor by JavaScript and
 * the harness runs its ambient default — the operator asked for one model and
 * silently got another. Nothing downstream would look wrong.
 */
export function assertAdapterCanForceModel({ adapter, model, adapterArgs } = {}) {
  if (typeof model !== 'string' || model.length === 0 || model === HARNESS_DEFAULT_MODEL) return;

  // A wholesale argv override discards the model just as surely as an adapter
  // that never renders it — the adapter's `args ?? [...]` branch never builds the
  // flag. Same silent substitution, different cause, so it fails the same way.
  if (adapterArgs != null) {
    throw new Error(
      `--model "${model}" cannot be honoured alongside --adapter-args, which replaces the adapter's argv wholesale ` +
        'and so never renders the model flag. The build would silently run the harness default. Drop one of them.'
    );
  }

  const capable = adapterCatalog()[adapter]?.forcesModel === true;
  if (capable) return;
  throw new Error(
    `--model "${model}" cannot be honoured by the "${adapter}" adapter, which passes no model to its harness. ` +
      'The build would silently run the harness default instead. Choose an adapter that forces the model, or drop --model.'
  );
}

/**
 * A legacy dispatch override and a registry seat cannot both be in force.
 *
 * `--adapter-args` replaces the adapter's entire argv, discarding the `-m
 * <model>` the registry just forced (§4c) — a worker on the harness default
 * while every downstream record claims the registry's model.
 *
 * `--adapter-command` is the same class of problem one level up: it is a single
 * global binary, but the registry picks an adapter PER TICKET, so the override
 * would run one harness's binary with another harness's arguments (an
 * `/opt/codex` executing `run -m zai/glm-5.2`). It is also invisible to
 * `previewArgv`, so the dry-run would report a command the live run does not
 * use — breaking the one guarantee the dry-run exists to give.
 *
 * Two conflicting sources of truth for one command line is an operator error, so
 * this fails closed rather than picking a winner.
 */
export function assertNoArgvOverride(config = {}) {
  if (config.adapterArgs != null) {
    throw new Error(
      'fleet.adapterArgs / --adapter-args replaces the adapter argv wholesale, which would drop the model the ' +
        'registry forces (§4c). Unset it, or unset the quartermaster registry — they cannot both decide the command line.'
    );
  }
  if (config.adapterCommand != null) {
    throw new Error(
      '--adapter-command is a single global binary, but the registry selects an adapter PER TICKET — the override ' +
        'would run one harness\'s binary with another harness\'s arguments, and the dry-run could not see it. ' +
        'Unset it, or unset the quartermaster registry — they cannot both decide the command line.'
    );
  }
}

/**
 * Resolve every ticket's dispatch seat through the real pipeline:
 * DAG → computeFloat → assignAll → routeJob → registry.
 *
 * `assign.mjs` is consumed exactly as it emits — float comes from the assignment,
 * never from the ticket.
 *
 * @returns {{ registryPath, registryDigest, notices, seats: Map<string, {job, route, seat, assignment, registryDigest}> }}
 * @throws on a disabled/missing/invalid registry, or an unroutable ticket (fail closed)
 */
export function planSeats({
  tickets,
  onlyIds,
  repoDir,
  env = process.env,
  adlcDir = ADLC_DIR,
  floor = 0.2,
  exists = existsSync,
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const { registry, path: registryPath, notices, registryDigest } = loadRegistry({
    env,
    repoDir,
    adapters: adapterCatalog(),
    exists,
    readFile,
  });

  const seats = new Map();
  if (!Array.isArray(tickets) || tickets.length === 0) return { registryPath, registryDigest, notices, seats };

  // CPM float is a property of the WHOLE active DAG, never of a selection from
  // it. `tickets` must therefore be every active ticket, and a `--tickets`
  // subset is applied only AFTER routing:
  //
  //   - float changes under filtering. With A(3)->C and B(1)->C, B has float 2
  //     in the full DAG (ladder-start -> mid) but float 0 once A is dropped
  //     (critical-path -> frontier). Routing the subset would make a dry-run
  //     advertise a channel the live run never uses — destroying the dry-run's
  //     only job, which is to predict the live run.
  //   - a subset is not even well-formed. computeFloat indexes predecessors by
  //     edge target, so a selected ticket whose edge points at an omitted one
  //     throws rather than routing.
  // `tickets` must be the FULL store, completed tombstones included, because the
  // completion-aware filter has to see them: an edge pointing at a completed
  // ticket has to be dropped along with the node, and it can only know which
  // targets were completed if it is handed them. Fleet's own `activeTickets`
  // deliberately keeps those edges (its scheduler treats a completed
  // prerequisite as satisfied), which is correct for scheduling and fatal for
  // CPM — `computeFloat` indexes predecessors by edge target and dereferences a
  // missing one. The repo's own store carries four such edges today.
  const routable = routableTickets(tickets);
  const known = new Set(routable.map((t) => t.id));
  const dangling = [];
  for (const t of routable) {
    for (const e of t.edges ?? []) if (e && !known.has(e.to)) dangling.push(`${t.id} -> ${e.to}`);
  }
  if (dangling.length > 0) {
    // Not a completed target (those are gone) — an edge to a ticket that does
    // not exist. That is a store-integrity problem, and saying so beats the
    // TypeError computeFloat would otherwise raise.
    throw new Error(`quartermaster: cannot route — ticket DAG has edges to unknown tickets: ${dangling.join(', ')}`);
  }

  const cpm = computeFloat(routable);
  if (cpm.error) throw new Error(`quartermaster: cannot route — ${cpm.error}`);
  const { entries } = readManifestForest(adlcDir);
  const assignments = assignAll(routable, cpm, buildPriors(entries), floor);
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));

  const selected = Array.isArray(onlyIds) && onlyIds.length > 0 ? new Set(onlyIds) : null;
  for (const ticket of routable) {
    const assignment = assignmentById.get(ticket.id);
    const job = deriveBuildJob({ assignment, ticket });
    const route = routeJob({ job, assignment, ticket });
    if (selected && !selected.has(ticket.id)) continue; // routed on the full DAG, reported for the subset
    seats.set(ticket.id, { job, route, seat: resolveRoute(registry, route), assignment, registryDigest });
  }
  return { registryPath, registryDigest, notices, seats };
}

/**
 * The argv this seat WOULD run, produced by the adapter itself.
 *
 * The adapter's real `dispatch` is invoked with a capture-only `exec`, so nothing
 * is spawned and the preview cannot drift from the live command: re-deriving the
 * argv here would be a copy of the adapter, and a copy is exactly what a dry-run
 * must not print.
 */
export async function previewArgv({ seat, prompt, worktree = '.' }) {
  const adapter = getAdapter(seat.adapter);
  let captured = null;
  await adapter.dispatch({
    worktree,
    prompt,
    timeoutMs: 0,
    env: {},
    model: seat.model,
    exec: (cmd, args) => {
      captured = { cmd, args };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  return captured;
}

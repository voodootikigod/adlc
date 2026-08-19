// Environment scrubbing for the two planes (spec §7.2, adversarial-review F2/K2).
//
// Repo-command plane (init, build, test, gate — orchestrator-run): the hardest
// scrub. Only PATH, ADLC_* control vars, and config-named keys survive; HOME is
// redirected to a synthetic in-worktree home; every provider key / cloud
// credential is stripped. Combined with the sandbox (§7.3) this bounds
// credential exfiltration through arbitrary test code.
//
// Model plane (the `claude -p` worker): the worker must reach its provider, so it
// keeps PATH, its real HOME (subscription/session already lives there), and its
// OWN model auth (or a single injected model key), but unrelated host creds and
// cloud secrets are stripped — and, since #395, so is every ambient ADLC_* var.
// Those name the operator's trust roots (the quartermaster registry, the ticket
// store, the rails bypass), and the worker runs candidate-authored gate commands.

// Patterns that identify a secret-bearing variable name. Matched
// case-insensitively against the full var name.
const SECRET_PATTERNS = [
  /API_KEY$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /SECRET$/i,
  /_TOKEN$/i,
  /TOKEN$/i,
  /PASSWORD/i,
  /^AWS_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^AZURE_/i,
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /CREDENTIAL/i,
  /^NPM_TOKEN$/i,
];

// Never stripped: the control vars the fleet itself relies on.
const ALWAYS_KEEP = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']);

function isSecretName(name) {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/**
 * Secrets no `modelAuthKey` may unlock. The ledger signing key authenticates
 * cross-model attestations; a worker that can read it can forge the evidence the
 * merge gate trusts, which is a strictly worse outcome than any build failure
 * caused by withholding it.
 */
export const NEVER_EXEMPT = new Set(['ADLC_MANIFEST_KEY']);

/**
 * Remove every never-exempt name from a COPY of `source` (issue #446).
 *
 * Takes the name set as a parameter for one reason: with `NEVER_EXEMPT` holding a
 * single member, "iterate the set" and "delete the one member" are behaviourally
 * identical, so the property that actually matters — that this scales when the
 * set GROWS — cannot be tested through the production constant. A test can pass a
 * two-member set here and prove it; production passes the real one.
 *
 * Always copies. The production caller hands in `process.env`, and deleting in
 * place would strip the signing key from the ORCHESTRATOR, which needs it to sign
 * manifest entries.
 */
export function denyNeverExempt(source, names = NEVER_EXEMPT) {
  const out = { ...source };
  for (const name of names) delete out[name];
  return out;
}

function isAdlcControl(name) {
  return name.startsWith('ADLC_');
}

/**
 * The ADLC control vars the MODEL-plane worker may inherit from the ambient
 * environment (issue #395).
 *
 * It is an ALLOW-list, and it is EMPTY. That is the whole point: `ADLC_*` is not a
 * namespace of harmless knobs, it is where this toolkit keeps operator-local
 * PATHS and AUTHORITY — `ADLC_QUARTERMASTER_REGISTRY` names the channel registry
 * that decides which model serves which ticket, `ADLC_TICKET_STORE`/`ADLC_TICKETS`
 * name the ticket store, `ADLC_RAILS_BYPASS` and `ADLC_BUILD_GATE_BYPASS` are
 * standing permission to edit a frozen rail, `ADLC_SIGNED_RUNNER_POOL` and
 * `ADLC_RUNNER_PATH` name trusted binaries. Passing them through told a worker
 * running candidate-authored gate commands exactly where the operator's trust
 * roots live.
 *
 * The worker needs none of them: dispatch resolves the seat BEFORE the worker
 * starts and injects what the charter actually requires (`ADLC_TICKET`,
 * `ADLC_P4_ENFORCEMENT`) through `extra`. Stating the rule as an allow-list rather
 * than a deny-list is what makes a var added LATER withheld by construction —
 * a deny-list would have to be remembered on every future addition, and forgetting
 * is silent.
 */
export const MODEL_PLANE_AMBIENT_ADLC_VARS = new Set([]);

/**
 * Env for a REPO-COMMAND-plane command (init/build/test/gate). Keeps only
 * PATH, ADLC_*, explicitly-named passthrough keys, and a synthetic HOME; strips
 * every secret-shaped var. `syntheticHome` is the in-worktree home the sandbox
 * provides (§7.3); when omitted (e.g. a unit test), HOME is dropped entirely
 * rather than leaking the operator's real home.
 *
 * @param source     the base environment (defaults to process.env)
 * @param opts.passthrough  extra var names the repo config explicitly allows
 * @param opts.syntheticHome absolute path to the in-worktree home
 */
export function repoCommandEnv(source = process.env, { passthrough = [], syntheticHome } = {}) {
  const allow = new Set(passthrough);
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (k === 'HOME') continue; // set explicitly below to the synthetic home
    if (isSecretName(k) && !allow.has(k)) continue;
    if (k === 'PATH' || isAdlcControl(k) || allow.has(k) || ALWAYS_KEEP.has(k)) {
      out[k] = v;
    }
    // Everything else (arbitrary non-secret vars) is dropped by default: the
    // repo-command plane runs with a minimal, predictable environment.
  }
  if (syntheticHome) out.HOME = syntheticHome;
  return out;
}

/**
 * Env for the MODEL-plane worker (`claude -p`). Keeps PATH, ADLC_*, the real
 * HOME (so the worker can read its own subscription/session auth), and only the
 * single model-auth key named by `opts.modelAuthKey` if present; strips all
 * OTHER secrets (cloud creds, unrelated tokens). The worker keeps just enough to
 * reach its model, nothing more.
 *
 * @param source            base environment (defaults to process.env)
 * @param opts.modelAuthKey the one provider key the worker may keep (e.g. 'ANTHROPIC_API_KEY'); optional
 * @param opts.extra        additional {k:v} the orchestrator injects (ADLC_TICKET, ADLC_P4_ENFORCEMENT)
 * @param opts.ambientAdlcVars  the ADLC_* names inheritable from `source` (default:
 *   MODEL_PLANE_AMBIENT_ADLC_VARS, which is empty). Injectable for the same reason
 *   `denyNeverExempt` takes its name set: with the production set empty, "filter by
 *   the set" and "drop every ADLC_ var" are behaviourally identical, so the property
 *   that matters — that this is an allow-list and not a hardcoded blanket drop —
 *   cannot be tested through the production constant.
 */
export function modelPlaneEnv(
  source = process.env,
  { modelAuthKey, extra = {}, ambientAdlcVars = MODEL_PLANE_AMBIENT_ADLC_VARS } = {}
) {
  const ambient = ambientAdlcVars;
  const out = {};
  // Defence in depth: some secrets must never be exemptable, whoever asks.
  // `modelAuthKey` exists to let ONE provider credential through, but the ADLC
  // ledger signing key is not a provider credential — a worker holding it could
  // forge the cross-model attestations the gate is built on. There is no
  // legitimate configuration in which a model worker needs it, so the exemption
  // does not apply to it even from the operator-local CLI flag.
  const exemptable = NEVER_EXEMPT.has(modelAuthKey) ? null : modelAuthKey;
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (k === exemptable) { out[k] = v; continue; }
    if (isSecretName(k)) continue; // strip all other secrets
    // ADLC_* is NOT inherited (#395) — see MODEL_PLANE_AMBIENT_ADLC_VARS. What the
    // worker legitimately needs arrives through `extra`, which is applied below and
    // therefore still wins.
    if (isAdlcControl(k) && !ambient.has(k)) continue;
    if (k === 'PATH' || k === 'HOME' || isAdlcControl(k) || ALWAYS_KEEP.has(k)) {
      out[k] = v;
    }
  }
  return { ...out, ...extra };
}

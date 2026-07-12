// Environment scrubbing for the two planes (spec §7.2, adversarial-review F2/K2).
//
// Repo-command plane (init, build, test, gate — orchestrator-run): the hardest
// scrub. Only PATH, ADLC_* control vars, and config-named keys survive; HOME is
// redirected to a synthetic in-worktree home; every provider key / cloud
// credential is stripped. Combined with the sandbox (§7.3) this bounds
// credential exfiltration through arbitrary test code.
//
// Model plane (the `claude -p` worker): the worker must reach its provider, so it
// keeps PATH, ADLC_*, and its OWN model auth (subscription/session already lives
// in its real HOME, or a single injected model key), but unrelated host creds
// and cloud secrets are still stripped.

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

function isAdlcControl(name) {
  return name.startsWith('ADLC_');
}

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
 */
export function modelPlaneEnv(source = process.env, { modelAuthKey, extra = {} } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (k === modelAuthKey) { out[k] = v; continue; }
    if (isSecretName(k)) continue; // strip all other secrets
    if (k === 'PATH' || k === 'HOME' || isAdlcControl(k) || ALWAYS_KEEP.has(k)) {
      out[k] = v;
    }
  }
  return { ...out, ...extra };
}

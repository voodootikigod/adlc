// Argument parsing for `adlc rails-guard-ci` (#140).
//
// Split out of the bin so the resolution rules — especially which base ref a run
// actually diffs against — are unit-testable. Picking the wrong base is a silent
// fail-OPEN: an unfetched or mistyped ref would look like "no rails declared", which is
// why git.mjs resolves it strictly and why the choice is tested here rather than trusted.

export const USAGE = `adlc rails-guard-ci — CI rail-freeze backstop

  adlc rails-guard-ci [--base <ref>] [--trust-root <path>]…
      Run the rail-freeze gate: deny a PR whose diff touches a frozen rail or an
      immutable trust root without the #141 authorization ceremony.

  adlc rails-guard-ci bootstrap [--base <ref>]
      Verify the repo is bootstrapped: base-branch acknowledgement, CODEOWNERS
      protection of the deployed workflow, config downgrade safety, and — in signed
      mode — the audited runner binary on the dedicated runner pool.

Options
  --base <ref>          base ref to diff against. Defaults to $RAILS_BASE, else
                        origin/$BASE_REF when BASE_REF is set (the GitHub Actions
                        shape), else origin/main.
  --trust-root <path>   an ADDITIONAL immutable trust root for this repo, on top of
                        the built-in defaults (DEFAULT_IMMUTABLE_TRUST_ROOTS in
                        lib/ci/trust-roots.mjs — this flag only EXTENDS that set,
                        never replaces or shrinks it). Repeatable. Safe to pass on
                        the command line because the caller that supplies it is
                        itself a default trust root, so a PR cannot shrink the list
                        without tripping the ceremony.
  -h, --help            show this help

Exit codes: 0 pass · 1 operational error / unverifiable · 2 rail or trust root violated`;

/**
 * Resolve the base ref when none was given explicitly.
 *
 * Order mirrors how the gate is actually invoked: RAILS_BASE is the local/manual escape
 * hatch, BASE_REF is what GitHub Actions supplies (a BARE branch name, hence the
 * `origin/` prefix — the workflow's fetch step creates that remote-tracking ref).
 */
export function defaultBase(env) {
  if (env.RAILS_BASE) return env.RAILS_BASE;
  if (env.BASE_REF) return `origin/${env.BASE_REF}`;
  return 'origin/main';
}

/**
 * @returns {{command: 'rail-freeze'|'bootstrap'|'help', base?: string, trustRoots?: string[], error?: string}}
 *   An unrecognized argument is an ERROR, never ignored: silently dropping a
 *   misspelled `--trust-root` would narrow the frozen set without saying so.
 */
export function parseArgs(argv, env = process.env) {
  const args = [...argv];
  const command = args[0] === 'bootstrap' ? args.shift() : 'rail-freeze';
  let base = null;
  const trustRoots = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (arg === '--base') {
      if (args[i + 1] === undefined) return { command, error: '--base requires a ref' };
      base = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--trust-root') {
      if (args[i + 1] === undefined) return { command, error: '--trust-root requires a path' };
      trustRoots.push(args[i + 1]);
      i += 1;
      continue;
    }
    return { command, error: `unrecognized argument: ${arg}` };
  }

  return { command, base: base ?? defaultBase(env), trustRoots };
}

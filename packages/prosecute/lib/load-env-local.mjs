// load-env-local.mjs — a LOCAL developer convenience: pick up ADLC_MANIFEST_KEY from a
// project `.env.local` so a maintainer can SIGN an attestation (`adlc-prosecute record-cross-model`)
// without an explicit shell export. This touches a secret, so the rules are deliberately strict:
//
//   0. SIGNING ONLY. The bin invokes this from `record-cross-model`, NEVER from `tier-check`.
//      tier-check VERIFIES, and a verifier must not source its key from the tree it is verifying —
//      a contributor can force-add a .env.local (gitignore does not stop `git add -f`) plus a
//      matching forged signed approve, and a local tier-check would then pass (Codex #354 loader
//      F2). Using a wrong key while SIGNING only yields an attestation that fails in CI under the
//      real secret — inert, not a bypass — so the convenience is safe on the record path alone.
//   1. ONLY `ADLC_MANIFEST_KEY` is read from the file — no other variable is ever injected into
//      the process, so a stray or hostile .env.local cannot set arbitrary environment.
//   2. An already-DEFINED process.env value ALWAYS wins — by PRESENCE, not truthiness, so even an
//      explicitly EMPTY `ADLC_MANIFEST_KEY=''` (a deliberate fail-closed) is never overwritten.
//   3. NEVER loads under CI (GitHub Actions / CI=…). The trust-root gate runs with its cwd set
//      to the PR-controlled tree; reading a key out of a checked-out `.env.local` there would let
//      a contributor supply their own key and forge an approve. In CI the key must come from the
//      secret env only. This check is FIRST, so even a mis- or unconfigured secret cannot fall
//      through to a file. Together with (2) the CI path never reads a file-provided key.
//
// It reads a file (no code execution) and mutates only process.env[ADLC_MANIFEST_KEY].
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_KEY = 'ADLC_MANIFEST_KEY';

// True when we are running under continuous integration and must NOT read a key from a file.
export function isCIEnv(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return true;
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

// Extract the value of a single key from `.env`-style text. Accepts `KEY=value` and
// `export KEY=value`, ignores blanks/comments, strips one pair of surrounding quotes. Returns
// the value of the FIRST matching line, or null. Only the requested key is ever parsed.
export function readKeyFromEnvText(text, key = MANIFEST_KEY) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let val = m[2].trim();
    if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
      val = val.slice(1, -1);
    }
    return val;
  }
  return null;
}

// Populate env[ADLC_MANIFEST_KEY] from `<cwd>/.env.local` iff (a) not in CI, (b) the var is not
// already DEFINED in the environment, and (c) the file provides a non-empty value. Returns true
// iff it set the value. cwd/env/isCI are injectable for tests; by default they reflect the process.
export function loadManifestKeyFromEnvLocal({ cwd = process.cwd(), env = process.env, isCI = isCIEnv(env) } = {}) {
  if (isCI) return false;                                          // (3) never read a file key in CI
  // (2) never override an already-DEFINED value — presence, not truthiness. An EXPLICITLY EMPTY
  // key (`ADLC_MANIFEST_KEY=''`) is a deliberate "no key → fail closed" and must win over the
  // file, exactly like a non-empty one. Using length>0 here would let .env.local overwrite an
  // empty exported/secret value and, outside GitHub, could feed a file key into a gate run.
  if (Object.hasOwn(env, MANIFEST_KEY)) return false;
  const file = join(cwd, '.env.local');
  if (!existsSync(file)) return false;
  let val;
  try {
    val = readKeyFromEnvText(readFileSync(file, 'utf8'));          // (1) only ADLC_MANIFEST_KEY
  } catch {
    return false;                                                 // unreadable file → no-op, stay fail-closed
  }
  if (val === null || val === '') return false;
  env[MANIFEST_KEY] = val;
  return true;
}

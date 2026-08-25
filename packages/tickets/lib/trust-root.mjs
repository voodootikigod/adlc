// trust-root.mjs — is this ticket store a FROZEN TRUST ROOT?
//
// Once any ticket declares a rail, the ticket store stops being ordinary data and
// becomes the configuration that decides what the rail guards freeze. Editing it
// could remove the rails, so the PreToolUse rail hook treats `.adlc/tickets/**` as
// an implicit rail of its own from that moment on: a structured edit is denied
// unless ADLC_RAILS_BYPASS is set AND the override is recorded to the gate-manifest
// (plugins/adlc-claude-code/hooks/adlc-hook.mjs, `anyRailsDeclared`).
//
// The CLI reaches the same bytes through a door the hook deliberately does not
// parse — a Bash command — so the same rule has to hold here, in the library every
// door goes through. This module answers only the predicate; transaction.mjs owns
// what to do about it.
//
// #162 — the freeze keys off "this repo uses rails AT ALL", NOT "a rail is in force
// right now". A completed ticket's rails expire for the purpose of freezing its
// build's source files, but they must NOT thaw the trust root: otherwise completing
// the last railed ticket would unfreeze the rail configuration itself, and one
// unaudited edit could then disable enforcement for everything that follows.
//
// "AT ALL" is bounded by what is READABLE, not by the repo's whole history — see the
// KNOWN BOUNDARY on repoDeclaresRails below for the one state that leaves no trace.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_DIRECTORY, LEGACY_ARCHIVE_FILE } from './constants.mjs';
import { invalid, operational, policy } from './errors.mjs';
import { validateKeyParam } from './key-contract.mjs';

/** The store's own manifest file, which every store directory carries. */
const STORE_MARKER = '.store.json';

/**
 * A SYMLINK where trust-root evidence should be — dangling or not.
 *
 * `existsSync` follows links, so a dangling one reports the path as absent and the
 * evidence it should have held simply vanishes from these predicates; a live one
 * redirects the read somewhere the attacker chose. Either way the answer stops
 * being about this repo's own state, so it is not proof of "no rails".
 * DirectoryTicketStore already refuses a symlinked store for the same reason, and
 * this REFUSES WITH THE SAME CODE rather than silently answering "trust root". The
 * distinction is the diagnosis: "your archive is a symlink" is actionable, whereas
 * folding it into the key requirement would tell an operator to find a signing key
 * for a problem no key can fix. A throw is also the strongest fail-closed answer —
 * no caller can read past it. A genuinely absent path lstats as ENOENT and is a
 * real, honest absence.
 */
function assertNotSymlink(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    // ENOENT is the only honest absence. A permission or I/O failure means the path
    // may well hold rails that simply cannot be read right now, and swallowing it
    // would let `existsSync` below report "no evidence" for what is really "cannot
    // tell" — the fail-OPEN reading.
    if (error?.code === 'ENOENT') return;
    throw operational('TRUST_ROOT_PATH_UNREADABLE', `cannot determine whether ${path} holds trust-root evidence: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw invalid('UNSAFE_STORE_PATH', `${path} must be a real path, not a symlink — trust-root evidence read through a link is not this repo's own`);
  }
}

/**
 * True when at least one ticket in the store declares at least one rail —
 * completed tickets included (#162).
 *
 * FAILS CLOSED. Anything this cannot read as a definite "no rails" — a
 * non-array store, a ticket that is not an object, a `rails` field that is present
 * but not an array (`null` included) — counts as a frozen trust root, because a
 * rail may be hiding in the part it could not parse and the cost of guessing wrong
 * is an unaudited mutation of the trust root. Only an ABSENT `rails` field and an
 * empty array read as a definite no.
 *
 * @param {unknown} tickets the store's tickets
 * @returns {boolean}
 */
export function storeDeclaresRails(tickets) {
  if (!Array.isArray(tickets)) return true;
  return tickets.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const rails = item.rails;
    // ABSENT is a definite no-rails and the only shape that reads as one. `null` is
    // not absent — it is a malformed field, and the schema accepts only an array —
    // so it falls through to the fail-closed branch below with every other
    // non-array. The distinction matters because not every caller has been through
    // the validating loader: ticket-prune re-reads the raw envelope under its lock,
    // so a concurrent or hand-made edit can reach this predicate unvalidated.
    if (rails === undefined) return false;
    if (!Array.isArray(rails)) return true;
    return rails.length > 0;
  });
}

/**
 * Whether any ARCHIVED ticket declares a rail.
 *
 * The active store alone is not the whole answer. Archiving or discarding the last
 * railed ticket empties `rails` out of the active set, and a predicate that looked
 * only there would report the store thawed from that moment on — so one
 * key-authorized archive would permanently switch the audit off for every write
 * after it. That is the escalation #162 names: a ticket's rails expire for its own
 * build, but the trust root does not un-freeze. The archive is where the evidence
 * that this repo uses rails survives, so it is consulted too.
 *
 * FAILS CLOSED on an archive that exists but cannot be read: a present-but-opaque
 * archive is exactly the state an attacker would want to produce.
 */
function archiveDeclaresRails(root) {
  const directory = join(root, ARCHIVE_DIRECTORY);
  const legacy = join(root, LEGACY_ARCHIVE_FILE);
  assertNotSymlink(directory);
  assertNotSymlink(legacy);
  if (existsSync(directory)) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { return true; }
    // The archive's own manifest must be present and parse. A store directory whose
    // marker is missing or corrupt is not an archive this function can reason about,
    // and "cannot reason about it" is not "no rails".
    let sawMarker = false;
    for (const entry of entries) {
      if (entry.name === STORE_MARKER) {
        try {
          const marker = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
          if (!marker || typeof marker !== 'object' || typeof marker.format !== 'string') return true;
          sawMarker = true;
        } catch { return true; }
        continue;
      }
      // EVERY other entry must read as a TICKET document — a JSON object carrying a
      // string id. Anything else (a directory, an unparseable file, a JSON value of
      // the wrong shape) is a file this function cannot rule a rail out of, and
      // reporting "no rails" for it is the fail-OPEN answer.
      if (entry.isSymbolicLink()) assertNotSymlink(join(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try { parsed = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')); }
      catch { return true; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.id !== 'string') return true;
      if (storeDeclaresRails([parsed])) return true;
    }
    if (!sawMarker) return true;
  }
  if (existsSync(legacy)) {
    try {
      const parsed = JSON.parse(readFileSync(legacy, 'utf8'));
      if (storeDeclaresRails(parsed?.tickets)) return true;
    } catch { return true; }
  }
  return false;
}

/**
 * Has this repo ever recorded a frozen-trust-root override?
 *
 * The ticket set is not a durable record of "this repo uses rails". A signed
 * discard, or an authorized update that empties the last `rails` array, removes the
 * evidence from the active store AND the archive at once — and every write after it
 * would then be keyless and unaudited, which is exactly the sticky invariant #162
 * exists to hold. The manifest is where that fact survives: it is append-only, and
 * every audited override writes `bypass: true` into it. So once one has been
 * recorded, the repo stays a trust root no matter what happens to the tickets.
 *
 * That bootstraps correctly: the mutation that removes the last rail is itself
 * performed while the store is still frozen, so it records the marker on its way
 * out.
 *
 * KNOWN BOUNDARY — the one state these predicates cannot see. Closure is tracked by
 * ticket T-01M0TMRSQKGTNWZTFXBPQ2JHNB, the adoption-record / manifest-key
 * hermeticity mechanism; it is not built here.
 *
 * The state: a repo that used rails, had NO hook override ever recorded, and removed
 * its last railed ticket with the PRE-change writer. Only then is every source
 * silent: the ticket set, the archive, this contract's own audit entries, and the
 * hook's rails-bypass entries. The evidence does not exist to read. Reconstructing
 * it needs a durable adoption record (the mechanism
 * .adlc/specs/manifest-key-hermeticity.md specifies) or git archaeology over
 * .adlc/tickets — neither of which a filesystem predicate can synthesise after the
 * fact.
 *
 * Its extent: the uncovered set is those pre-change repos alone. It cannot grow,
 * because every removal from this change forward leaves a marker, and it shrinks as
 * each such repo takes one audited write. A repo that enforced rails through the
 * PreToolUse hook already has rails-bypass entries and is outside it.
 *
 * TWO shapes count, because two writers record overrides:
 *   - `data.bypass: true` — this contract's own audit entry, on any gate;
 *   - `gate: 'rails-bypass'` — what the PreToolUse rail hook has always written when
 *     ADLC_RAILS_BYPASS authorised a structured edit (its data carries only
 *     { path, reason }, no bypass field). Ignoring it would discard the very
 *     evidence a rails-using repo is most likely to have, and would let a hook
 *     override that removed the last rail thaw the trust root.
 *
 * Cheap substring pre-filter, then a real parse to confirm — a marker must be an
 * actual entry field, not the words appearing in a ticket body.
 */
function manifestRecordsBypass(root) {
  const rootManifest = join(root, '.adlc', 'manifest.jsonl');
  const segments = join(root, '.adlc', 'manifest.d');
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync(segments)) {
    try {
      for (const entry of readdirSync(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(segments, entry.name));
      }
    } catch { return true; } // an unreadable forest is not proof of anything
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch { return true; }
    if (!text.includes('"bypass"') && !text.includes('rails-bypass')) continue;
    for (const line of text.split('\n')) {
      if (!line.includes('"bypass"') && !line.includes('rails-bypass')) continue;
      // A line that NAMES a marker but will not parse is exactly the shape a
      // truncated or tampered one takes. Skipping it would let the sticky trust-root
      // state be erased by corrupting the entry that carries it, so it counts.
      try {
        const entry = JSON.parse(line);
        if (entry?.data?.bypass === true || entry?.gate === 'rails-bypass') return true;
      } catch { return true; }
    }
  }
  return false;
}

/**
 * The repo-wide predicate: this store is a frozen trust root if rails are declared
 * ANYWHERE it keeps tickets — the active set or the archive — or if the manifest
 * already records an override, which no later ticket edit can undo.
 *
 * @param {string} root repository root
 * @param {unknown} tickets the active store's tickets
 */
export function repoDeclaresRails(root, tickets) {
  // The shared PARENT first. lstat only declines to follow the FINAL component, so
  // checking each evidence path on its own still reads through a symlinked `.adlc`
  // — which would point every one of them at a directory someone else chose, and
  // report redirected-away evidence as simply absent. `.adlc` is ADLC's own
  // directory and is never legitimately a link; the repo root above it may well be
  // (macOS /var, a linked checkout), so the check stops here.
  assertNotSymlink(join(root, '.adlc'));
  return storeDeclaresRails(tickets) || archiveDeclaresRails(root) || manifestRecordsBypass(root);
}

/**
 * The refusal, in ONE place. Callers that have already settled the predicate — the
 * recovery path, which asks the journal rather than a mid-transaction store — call
 * this directly; everything else goes through assertSignableTrustRootWrite below.
 *
 * WHY `allowUnsigned` DOES NOT ALSO REFUSE A SIGNED-ERA MANIFEST. Appending an
 * unsigned entry to a ledger that already holds signed ones is a weaker record, and
 * the fix for it is specified — but it is a different mechanism, not this flag.
 * .adlc/specs/manifest-key-hermeticity.md ties the hard error to an ADOPTION RECORD
 * ("--allow-unsigned with an adoption record present → hard error naming the
 * record") and is explicit that until a store has one it stays permissive: "a
 * nonempty ledger WITHOUT an adoption record is simply a not-yet-adopted store",
 * "behavior unchanged (unsigned writes permitted)". Adoption records are not built
 * yet, so inferring adoption from "some entry is signed" would refuse writes the
 * spec sanctions. Note also that the unsigned-after-signed shape long predates this
 * flag: a keyless `ticket complete` has always appended an unsigned entry. What is
 * new here is that reaching it takes an explicit flag and prints a warning.
 *
 * @throws when the audit entry this write owes could not be signed.
 */
export function assertWriteIsSignable({ key, allowUnsigned = false } = {}) {
  // The key-contract FIRST, exactly as every other key-taking entrypoint applies
  // it: `key !== null` alone treats an OMITTED key —
  // `assertSignableTrustRootWrite(tickets)` with no options bag, or a caller that
  // spread `{ ...opts }` where opts had no key — as "a key is present", which is
  // the fail-OPEN reading of the one thing this guard exists to refuse. undefined,
  // '' and non-strings are caller bugs and throw here rather than passing.
  const resolved = validateKeyParam(key);
  if (resolved !== null || allowUnsigned) return;
  throw policy(
    'MANIFEST_KEY_REQUIRED',
    'this ticket store is a frozen trust root (a ticket declares rails), so mutating it is an audited override — '
    + 'and ADLC_MANIFEST_KEY is not set, so the audit entry would be written UNSIGNED, proving nothing about who made the change. '
    + 'Refusing before the write: nothing has changed.\n'
    + '  Set ADLC_MANIFEST_KEY and re-run. It is commonly kept in the MAIN checkout\'s gitignored .env.local, which is ABSENT '
    + 'from a git worktree — from a worktree, export it explicitly.\n'
    + '  To record an UNSIGNED audit entry on purpose, pass --allow-unsigned.',
  );
}

/**
 * Every writer that can reach the ticket store calls this before it touches
 * anything, so the audited-override rule cannot hold on one path and quietly not
 * on another — which is exactly how the gap this closes came to exist: the rail
 * hook enforced it for structured edits while the CLI, the migration, and
 * ticket-prune's direct legacy write did not.
 *
 * @returns {boolean} whether the store is a frozen trust root — true means the
 *   caller must record an audit entry for the mutation it is about to perform.
 * @throws when it is, and the write could not be signed.
 */
export function assertSignableTrustRootWrite(tickets, { key, allowUnsigned = false, root = '.' } = {}) {
  if (!repoDeclaresRails(root, tickets)) return false;
  assertWriteIsSignable({ key, allowUnsigned });
  return true;
}

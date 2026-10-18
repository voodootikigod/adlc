// Git-boundary guards for the committed findings ledger (.adlc/findings.jsonl, ADR 0014):
//   1. scanFindingsLedger — independent secret/dump/JSONL-validity scan of the committed ledger.
//   2. guardFindingsLedgerAppendOnly — merge-base prefix guard ensuring the ledger is never
//      truncated, rewritten in place, or deleted across a change.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { assertPublishableFinding } from '@adlc/core';

export const LEDGER = '.adlc/findings.jsonl';

function defaultGit(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Set process.exitCode and RETURN in callers — never process.exit() here. process.exit
// terminates before buffered stdout/stderr is flushed, so a caller capturing our diagnostics
// (our own tests, or a CI log) can see empty output on failure.
export function scanFindingsLedger(ledger = LEDGER) {
  if (!existsSync(ledger)) {
    console.log(`scan-findings-ledger: no ledger at ${ledger} — nothing to scan.`);
    return 0;
  }

  let text;
  try {
    text = readFileSync(ledger, 'utf8');
  } catch (err) {
    console.error(`scan-findings-ledger: cannot read ${ledger}: ${err.message}`);
    return 1;
  }

  const lines = text.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A malformed line is a violation on its own, not merely a secret risk. The ledger
      // is committed and curated, and `readEntries` SILENTLY SKIPS an unparseable line —
      // so a corrupt record would pass the gate while starving lesson-foundry of that
      // finding. Fail on it. Also scan the raw text so a secret hidden in the corrupt
      // bytes is named too.
      violations.push({
        line: i + 1,
        reason: 'malformed JSONL record — a committed ledger must be valid JSON (readEntries silently skips this, starving lesson-foundry)',
      });
      try { assertPublishableFinding({ desc: line }); } catch (err) { violations.push({ line: i + 1, reason: err.message }); }
      continue;
    }
    try {
      assertPublishableFinding(entry);
    } catch (err) {
      violations.push({ line: i + 1, reason: err.message });
    }
  }

  if (violations.length > 0) {
    console.error(`scan-findings-ledger: ${violations.length} line(s) in ${ledger} are not publishable:`);
    for (const v of violations) console.error(`  line ${v.line}: ${v.reason}`);
    console.error('\nThis file is committed to git. Describe the failure class instead of quoting the value (ADR 0014).');
    return 2;
  }

  console.log(`scan-findings-ledger: ${lines.filter((l) => l.trim()).length} ledger line(s) clean.`);
  return 0;
}

/**
 * Resolve the base ledger content, distinguishing "base is a real commit with no ledger yet"
 * (legitimately nothing to protect) from "base ref does not resolve at all" (an operational
 * failure that must NOT be silently treated as an empty base — that would let a deletion pass
 * on a misspelled/deleted/unfetched base).
 *
 * @returns { resolved: true, text } when the base resolves (text '' ONLY when the ledger is
 *          genuinely absent from the base tree), or { resolved: false } when the base ref
 *          cannot be resolved OR the base ledger cannot be read for any operational reason.
 */
export function baseLedger(baseRef, run = defaultGit) {
  let point = null;
  // Prefer the merge-base so findings other PRs added to the base are not counted removed.
  try { point = run('merge-base', baseRef, 'HEAD').trim(); }
  catch { /* no merge-base (unrelated/shallow history) — verify the ref directly below */ }
  if (!point) {
    try { point = run('rev-parse', '--verify', `${baseRef}^{commit}`).trim(); }
    catch { return { resolved: false }; } // the base ref itself does not resolve → fail closed
  }
  // Separate "ledger genuinely absent at base" from an operational read failure. `git ls-tree`
  // on a resolved commit exits 0 with EMPTY output when the path is not in the tree, and
  // prints a tree entry when it is — so ONLY empty output is the safe "nothing to protect"
  // case. A corrupt/missing object, an fs error, or the blob being present-but-unreadable must
  // NOT be collapsed into an empty base (that would let a deletion pass); they fail closed.
  let listed;
  try { listed = run('ls-tree', point, '--', LEDGER); }
  catch { return { resolved: false }; } // cannot even inspect the base tree → fail closed
  if (!listed.trim()) return { resolved: true, text: '' }; // ledger genuinely absent at base
  try { return { resolved: true, text: run('show', `${point}:${LEDGER}`) }; }
  catch { return { resolved: false }; } // present in the tree but unreadable → fail closed
}

/** The ledger content in the working tree ('' if absent). Reads the WORKING copy so an
 *  uncommitted deletion is caught too, not only a committed one. */
export function headLedgerText(read = readFileSync, exists = existsSync) {
  return exists(LEDGER) ? read(LEDGER, 'utf8') : '';
}

const nonEmptyLines = (text) => text.split('\n').filter((line) => line.trim() !== '');

/**
 * Return the list of append-only violations: `head` must be exactly `base` followed by
 * zero-or-more appended lines. An in-place rewrite of an existing finding and a removal of
 * any existing finding are both violations.
 */
export function appendOnlyViolations(baseText, headText) {
  const base = nonEmptyLines(baseText);
  const head = nonEmptyLines(headText);
  const violations = [];
  const common = Math.min(base.length, head.length);
  for (let i = 0; i < common; i++) {
    if (head[i] !== base[i]) {
      violations.push(
        `finding on line ${i + 1} was rewritten relative to the base — existing findings are immutable (append-only)`,
      );
      break; // the first divergence is enough to fail; more would be noise
    }
  }
  if (head.length < base.length) {
    violations.push(
      `the base ledger had ${base.length} finding(s); head has only ${head.length} — ` +
      `${base.length - head.length} removed (deletion or truncation)`,
    );
  }
  return violations;
}

export function guardFindingsLedgerAppendOnly(baseRef, { run = defaultGit, read = readFileSync, exists = existsSync } = {}) {
  const base = baseLedger(baseRef, run);
  if (!base.resolved) {
    // Fail CLOSED (operational error), never fall through to an empty-base pass: an
    // unresolvable base means we cannot verify the ledger at all, and treating that as
    // "nothing to protect" would let a deletion or rewrite slip through on a bad base.
    console.error(
      `guard-findings-ledger-append-only: base ref '${baseRef}' does not resolve to a commit ` +
      `(unfetched, misspelled, or deleted). Refusing to verify the ledger against an unknown ` +
      `base — fetch/spell the base ref correctly and re-run.`,
    );
    return 1;
  }
  const violations = appendOnlyViolations(base.text, headLedgerText(read, exists));
  if (violations.length > 0) {
    console.error(`guard-findings-ledger-append-only: ${LEDGER} is not append-only vs ${baseRef}:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\nThe findings ledger is durable P5->P7 memory (ADR 0014): findings are only ever ` +
      `appended, and dropping one erases the trail that lets a repeated finding become a ` +
      `banked defense. Restore the base findings and append any new ones.`,
    );
    return 2;
  }
  console.log(`guard-findings-ledger-append-only: ${LEDGER} is append-only vs ${baseRef}.`);
  return 0;
}

export { scanFindingsLedger as scan, guardFindingsLedgerAppendOnly as guard };

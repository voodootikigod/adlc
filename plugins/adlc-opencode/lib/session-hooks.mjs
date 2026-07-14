// session-hooks.mjs — advisory session lifecycle checks for OpenCode (plan
// Phase C, plus issue #59's mechanical adversarial-review trigger). All three
// checks are ADVISORY and FAIL-SAFE: they only surface warnings, never throw,
// and no-op when the repo is not ADLC-initialized.
//
// Event-name note: the plan specified `session.created` + `session.ended`, but
// OpenCode exposes `session.created` and `session.idle` (there is no
// `session.ended`). We map the end-of-work audits onto `session.idle`.
//
// The subprocess calls are injected (`spawnImpl`) so the logic is unit-testable
// offline without `adlc` or `git` installed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyRiskTier, decideAdversarialReviewNotice, ticketStoreExists } from '@adlc/core';
import { resolveActiveTicketId } from '../rails-checker.mjs';

function run(spawnImpl, bin, args, cwd) {
  try {
    const r = spawnImpl(bin, args, { cwd, encoding: 'utf8' });
    return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err), error: err };
  }
}

/**
 * session.created check: is the environment ready for ADLC work / fan-out?
 * Advisory only. Returns { ready, skipped, warnings[] }.
 */
export function checkPreflight(root, { spawnImpl = spawnSync, env = process.env } = {}) {
  if (!ticketStoreExists(root, env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null)) {
    return { ready: true, skipped: true, warnings: [] }; // not ADLC-initialized → no-op
  }
  const warnings = [];

  const ver = run(spawnImpl, 'adlc', ['--version'], root);
  if (ver.error || ver.status !== 0) {
    warnings.push('`adlc` is not on PATH — install @adlc/cli (npm i -g @adlc/cli) before running gates.');
  }

  const git = run(spawnImpl, 'git', ['status', '--porcelain'], root);
  if (!git.error && git.status === 0 && git.stdout.trim()) {
    warnings.push('git worktree is dirty — a non-deterministic tree weakens evidence; commit or stash before fan-out.');
  }

  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    warnings.push('ADLC_P4_ENFORCEMENT is not set — in-session rail enforcement is inactive (advisory). The CI gate remains authoritative.');
  }

  return { ready: warnings.length === 0, skipped: false, warnings };
}

/**
 * session.idle audit: is the gate-evidence chain intact? Advisory only.
 * Returns { ok, skipped, warning }.
 */
export function auditGateManifest(root, { spawnImpl = spawnSync } = {}) {
  if (!existsSync(join(root, '.adlc', 'manifest.jsonl'))) {
    return { ok: true, skipped: true, warning: null }; // nothing recorded yet → no-op
  }
  const res = run(spawnImpl, 'adlc', ['gate-manifest', 'verify', '--json'], root);
  if (res.error) {
    return { ok: true, skipped: true, warning: null }; // can't run the verifier → stay silent (advisory)
  }
  if (res.status !== 0) {
    return { ok: false, skipped: false, warning: `gate-manifest verify reported a problem: ${(res.stderr || res.stdout || '').trim().slice(0, 300)}` };
  }
  return { ok: true, skipped: false, warning: null };
}

/**
 * Unquote a path token from `git status --porcelain` (non -z form). Git
 * C-quotes any path containing a space or other "unusual" character by
 * wrapping it in double quotes and backslash-escaping the contents (e.g.
 * ` M "secrets/api key.pem"`), unlike `git diff --name-only`/`git ls-files`,
 * which never quote. Left as-is, the literal surrounding `"` (and any `\\`
 * escapes) become part of the path string and silently defeat the `$`-anchored
 * risk-tier globs in classifyRiskTier. Pass-through for the common (unquoted)
 * case; only unquotes tokens that are actually wrapped in `"..."`.
 * KEEP IN SYNC with plugins/adlc-claude-code/hooks/adlc-hook.mjs's copy.
 */
function unquoteGitStatusPath(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[++i];
    if (next === undefined) break; // malformed trailing backslash — drop it
    switch (next) {
      case 'n': bytes.push(0x0a); break;
      case 't': bytes.push(0x09); break;
      case 'r': bytes.push(0x0d); break;
      case '"': bytes.push(0x22); break;
      case '\\': bytes.push(0x5c); break;
      case 'a': bytes.push(0x07); break;
      case 'b': bytes.push(0x08); break;
      case 'f': bytes.push(0x0c); break;
      case 'v': bytes.push(0x0b); break;
      default:
        if (next >= '0' && next <= '7') {
          let oct = next;
          while (oct.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') {
            oct += inner[++i];
          }
          bytes.push(parseInt(oct, 8) & 0xff);
        } else {
          for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
        }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Repo-relative changed paths covering BOTH the working tree (uncommitted
 * modifications + untracked files) and the committed branch diff against the
 * first reachable trunk candidate (or `base`, if given). Best-effort: any git
 * failure yields an empty set rather than throwing — this check is advisory
 * and must never crash or fail closed on a git problem.
 */
function gitChangedPaths(root, { spawnImpl = spawnSync, base } = {}) {
  const paths = new Set();

  const status = run(spawnImpl, 'git', ['status', '--porcelain', '--no-renames'], root);
  if (!status.error && status.status === 0 && status.stdout) {
    for (const line of status.stdout.split('\n')) {
      const p = unquoteGitStatusPath(line.slice(3).trim());
      if (p) paths.add(p);
    }
  }

  const untracked = run(spawnImpl, 'git', ['ls-files', '--others', '--exclude-standard'], root);
  if (!untracked.error && untracked.status === 0 && untracked.stdout) {
    for (const p of untracked.stdout.split('\n')) {
      if (p.trim()) paths.add(p.trim());
    }
  }

  // Same trunk-candidate order AND same retry-on-merge-base-failure behavior
  // as @adlc/core's resolveBase (lib/git.mjs), so this check's notion of "the
  // branch" matches the rest of the toolkit's freeze/diff gates. A candidate
  // can exist as a ref yet share no common history with HEAD (orphan branch,
  // stale ref after a history rewrite, shallow clone) — resolveBase() doesn't
  // stop at the first *existing* ref, it keeps trying candidates until one
  // produces a real merge-base, so this must too or it silently drops the
  // committed-diff contribution to `changed`. Overridable via `base` for a
  // repo with a different trunk.
  const baseCandidates = base ? [base] : ['main', 'master', 'origin/main', 'origin/master'];
  let diffBase = '';
  for (const c of baseCandidates) {
    const exists = run(spawnImpl, 'git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], root);
    if (exists.error || exists.status !== 0) continue;
    // Diff against the MERGE-BASE (fork point of `c` and HEAD), NOT `c`'s live
    // tip — resolveBase() itself resolves to `git merge-base <candidate>
    // HEAD`. Diffing straight against the tip would flag any file trunk
    // changed *after* this branch diverged as "changed" on this branch too,
    // producing false-positive risk-tier matches.
    const mergeBase = run(spawnImpl, 'git', ['merge-base', c, 'HEAD'], root);
    if (!mergeBase.error && mergeBase.status === 0 && mergeBase.stdout.trim()) {
      diffBase = mergeBase.stdout.trim();
      break;
    }
    // candidate exists but shares no history with HEAD — try the next one
  }
  if (diffBase) {
    const diff = run(spawnImpl, 'git', ['diff', '--name-only', diffBase, '--'], root);
    if (!diff.error && diff.status === 0 && diff.stdout) {
      for (const p of diff.stdout.split('\n')) {
        if (p.trim()) paths.add(p.trim());
      }
    }
  }

  return [...paths];
}

/**
 * session.idle check (issue #59): a deterministic (no-LLM) mechanical trigger
 * for ADR-0005/0007's adversarial-review practice. Diffs the working
 * tree/branch against the ADR-0007 §1 risk-tier path patterns
 * (`classifyRiskTier`); if the change is risk-gated and no `adversarial-review`
 * gate-manifest record exists for the active ticket, warns. Advisory only —
 * never throws, never blocks (OpenCode's session.idle has no blocking
 * contract to begin with).
 *
 * Returns { needed, skipped, warning, matches }. `skipped` is true only when
 * the repo is not ADLC-initialized; when `adlc` itself is unreachable (or
 * there is simply no manifest yet), the record is conservatively treated as
 * ABSENT — a risk-gated change with unprovable compliance still warns, on the
 * theory that "can't verify the gate ran" is a stronger signal than "assume it
 * did", matching plugins/adlc-claude-code/hooks/adlc-hook.mjs's `review` mode.
 */
export function auditAdversarialReview(root, { spawnImpl = spawnSync, env = process.env, base } = {}) {
  if (!ticketStoreExists(root, env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null)) {
    return { needed: false, skipped: true, warning: null, matches: [] };
  }

  const changed = gitChangedPaths(root, { spawnImpl, base });
  const { gated, matches } = classifyRiskTier(changed);
  if (!gated) return { needed: false, skipped: false, warning: null, matches: [] };

  const active = resolveActiveTicketId(root, env);
  const ticketId = active.conflict ? null : active.id; // advisory: degrade, never fail closed

  let manifestEntries = [];
  if (existsSync(join(root, '.adlc', 'manifest.jsonl'))) {
    const show = run(spawnImpl, 'adlc', ['gate-manifest', 'show', '--json'], root);
    if (!show.error && show.status === 0 && show.stdout) {
      try {
        const parsed = JSON.parse(show.stdout);
        if (Array.isArray(parsed.entries)) manifestEntries = parsed.entries;
      } catch {
        /* unparseable output — treat as no provable entries */
      }
    }
  }

  const decision = decideAdversarialReviewNotice({ changedPaths: changed, manifestEntries, ticketId });
  if (!decision.needed) return { needed: false, skipped: false, warning: null, matches };

  const tiers = [...new Set(decision.matches.map((m) => m.tier))].join(', ');
  const warning =
    `risk-gated change (${tiers}) with no adversarial-review gate-manifest record` +
    `${ticketId ? ` for ticket ${ticketId}` : ''}. Run \`npx adversarial-review\` and record the verdict ` +
    `via \`adlc gate-manifest record adversarial-review --files '<paths>' ` +
    `--data '{"providers":"<a,b>","verdict":"<approve|needs-attention>","exitReason":"<clean|no-progress|ceiling>"}'\` ` +
    `before merging.`;
  return { needed: true, skipped: false, warning, matches: decision.matches };
}

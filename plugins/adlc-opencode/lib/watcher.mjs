// watcher.mjs — the file.edited backstop (plan Phases 2.4 + 2.5).
//
// OpenCode's `event` hook is observe-only (fire-and-forget, cannot block), so
// everything here is POST-HOC: detect a violation after the write landed and
// respond. Three checks ride the same event:
//
//   2.5 RAIL BACKSTOP (enforcing by default): an edit that lands on a frozen
//       rail — regardless of WHICH tool wrote it, including a co-installed
//       third-party plugin's write tool the name-based guard has never seen —
//       is quarantined and restored from git HEAD.
//   2.4 SUPPRESSION MARKERS (ADVISORY ONLY): newly ADDED type-ignore /
//       lint-disable / test-skip escape hatches not allowed by the active ticket.
//   2.4 SCOPE (ADVISORY ONLY): an edit outside the active ticket's scope.
//
// Only the RAIL backstop auto-restores. Suppression and scope are advisory —
// they warn, they never `git checkout`. A post-hoc surgical revert of just the
// offending lines is not safe, and a wholesale checkout of a working file would
// discard unrelated in-progress edits (P5 finding); a frozen rail, by contrast,
// MUST equal HEAD, so restoring it is correct by definition. This matches the
// design-review guidance: quarantine + user mediation, not blind revert.
//
// Review guardrails (adversarial review) honored here:
//   - PATH NORMALIZATION: the event path is resolved against root before any
//     exemption check, so `.adlc/quarantine/../../rail` can't skip the gate.
//   - QUARANTINE before restore: the offending content is copied to
//     .adlc/quarantine/ first — nothing is ever silently destroyed.
//   - LOOP GUARD: at most MAX_RESTORES restores per file per plugin lifetime;
//     past that we warn loudly instead of fighting a revert war.
//   - ARG-ARRAY git invocations (no string interpolation, no shell).
//
// Suppression markers KEEP IN SYNC with plugins/adlc-pi/index.ts (pi's
// suppression revert predates this module and keeps its own list).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { loadTickets, inScope } from '@adlc/core';
import { resolveRailsInForce, resolveActiveTicketId, railHit, TRUST_ROOT_RAILS } from '../rails-checker.mjs';

// Markers are written as concatenated fragments so this file — which is itself
// scanned by the repo's rails-guard suppression gate — does not trip the gate on
// its own detector list. Runtime values are the exact contiguous markers.
export const SUPPRESSION_MARKERS = [
  '@ts' + '-ignore', '@ts' + '-expect-error', 'eslint' + '-disable',
  '.sk' + 'ip(', '.on' + 'ly(', 'x' + 'fail', '# no' + 'qa', '#[' + 'ignore]',
];

export const MAX_RESTORES_PER_FILE = 3;

/** Ticket-granted suppression allowances (ported from adlc-pi getAllowedSuppressions). */
export function allowedSuppressions(ticket) {
  const allowed = new Set(Array.isArray(ticket?.allowedSuppressions) ? ticket.allowedSuppressions : []);
  for (const line of String(ticket?.body ?? '').split('\n')) {
    const m = line.match(/^\s*allow-suppression:\s*(\S.*)$/);
    if (m) allowed.add(m[1].trim());
  }
  return allowed;
}

function run(exec, bin, args, cwd) {
  try {
    const r = exec(bin, args, { cwd, encoding: 'utf8' });
    return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err) };
  }
}

/** Newly ADDED lines for one file (git diff HEAD, "+" lines only, diff-based like pi). */
function addedLines(root, rel, exec) {
  const diff = run(exec, 'git', ['diff', 'HEAD', '--', rel], root);
  if (diff.status !== 0) return [];
  return diff.stdout
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

/** Quarantine the file's CURRENT content, then restore it from git HEAD. */
function quarantineAndRestore(root, rel, exec, { now = Date.now } = {}) {
  const abs = join(root, rel);
  let quarantined = null;
  try {
    if (existsSync(abs)) {
      const qDir = join(root, '.adlc', 'quarantine');
      mkdirSync(qDir, { recursive: true });
      quarantined = join(qDir, `${now()}-${basename(rel)}`);
      copyFileSync(abs, quarantined);
    }
  } catch { quarantined = null; }
  const restore = run(exec, 'git', ['checkout', 'HEAD', '--', rel], root);
  return { restored: restore.status === 0, quarantined };
}

/** Per-plugin-lifetime restore accounting (the loop guard). */
export function createWatcherState() {
  const restores = new Map();
  return {
    countRestore(rel) {
      const n = (restores.get(rel) ?? 0) + 1;
      restores.set(rel, n);
      return n;
    },
    restoreCount(rel) { return restores.get(rel) ?? 0; },
  };
}

/**
 * Handle one file.edited event. Pure-ish (exec injected); returns
 * { actions: [{check, action, message}] } — the caller toasts each message.
 * Fail-safe: never throws; any internal failure degrades to a warning.
 */
export function handleFileEdited({ file, root, env = process.env, exec = spawnSync, state, now }) {
  const actions = [];
  if (!file || !root) return { actions };
  // Resolve against root FIRST (normalizes any `..`), then relativize — so a
  // non-normalized event path cannot slip past the exemption checks below.
  const abs = isAbsolute(file) ? file : join(root, file);
  const rel = relative(root, abs).split('\\').join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) return { actions }; // outside this project — not ours
  if (rel === '.adlc/quarantine' || rel.startsWith('.adlc/quarantine/')) return { actions }; // our own quarantine writes

  // Restore a specific tracked path from HEAD, quarantining current content
  // first and honoring the per-file loop guard.
  const restorePath = (check, targetRel, why) => {
    const n = state?.countRestore?.(targetRel) ?? 1;
    if (n > MAX_RESTORES_PER_FILE) {
      actions.push({ check, action: 'warned', message: `${why} — restore loop guard tripped (${n - 1} restores already); NOT restoring again. Investigate what keeps rewriting ${targetRel}.` });
      return;
    }
    const { restored, quarantined } = quarantineAndRestore(root, targetRel, exec, now ? { now } : {});
    if (restored) {
      actions.push({ check, action: 'restored', message: `${why} — ${targetRel} restored from HEAD${quarantined ? `; offending content quarantined at ${relative(root, quarantined)}` : ''}` });
    } else {
      actions.push({ check, action: 'warned', message: `${why} — could NOT restore ${targetRel} from HEAD (new/untracked file?)${quarantined ? `; content quarantined at ${relative(root, quarantined)}` : ''}. Review it manually.` });
    }
  };
  const restoreWithGuard = (check, why) => restorePath(check, rel, why);

  const force = resolveRailsInForce(root, env);
  if (!force.active) return { actions };
  if (force.conflict) {
    // A conflicting active-ticket signal fails the rail gate closed — but the
    // trust roots stay frozen regardless. The write that CREATED the conflict
    // (e.g. a spoofed .adlc/current-ticket.json, possibly via a symlink alias)
    // is itself a trust-root mutation the backstop must revert; otherwise
    // corrupting the trust root would be the way to disable this very backstop.
    // Use the symlink-aware railHit (not a lexical string compare) so an alias
    // path resolving to a trust root is still caught, and restore the resolved
    // trust-root file itself.
    const trustHit = railHit(rel, TRUST_ROOT_RAILS, root, { ancestors: false });
    if (trustHit) {
      restorePath('rails', trustHit, `ADLC rails-backstop: frozen trust root "${trustHit}" was written under a conflicting active-ticket signal — restoring from HEAD`);
    }
    return { actions };
  }

  // ---- 2.5 rail backstop: enforcing by default (this IS a rail violation) ----
  // A file.edited event names ONE concrete file — match it exactly, no ancestor
  // detection (a directory delete doesn't arrive as a single file.edited).
  const hit = railHit(rel, force.rails, root, { ancestors: false });
  if (hit) {
    restoreWithGuard('rails', `ADLC rails-backstop: a write landed on frozen rail "${hit}" (active ticket ${force.ticketId}) via a path the in-session guard did not intercept`);
    return { actions }; // restored (or warned) — suppression/scope checks on it are moot
  }

  // Active ticket object for 2.4 checks.
  const active = resolveActiveTicketId(root, env);
  const { tickets } = loadTickets(join(root, '.adlc', 'tickets.json'));
  const ticket = tickets.find((t) => t.id === active.id);
  if (!ticket) return { actions };

  // ---- 2.4 suppression markers (ADVISORY ONLY — never auto-reverts) ----
  const allowed = allowedSuppressions(ticket);
  const added = addedLines(root, rel, exec);
  const found = new Set();
  for (const line of added) {
    for (const marker of SUPPRESSION_MARKERS) {
      if (line.includes(marker) && !allowed.has(marker)) found.add(marker);
    }
  }
  if (found.size > 0) {
    actions.push({
      check: 'suppression',
      action: 'warned',
      message: `ADLC suppression audit: ${rel} adds unapproved suppression marker(s) ${[...found].join(', ')} (ticket ${ticket.id}; grant via ticket allowedSuppressions or an "allow-suppression:" body line, or remove the marker)`,
    });
  }

  // ---- 2.4 scope (ADVISORY ONLY — never auto-reverts) ----
  // .adlc/ runtime writes are always in-scope (gate evidence, manifests) — pi parity.
  const scoped = rel.startsWith('.adlc/') || (ticket.scope ?? []).length === 0 || inScope(ticket, rel);
  if (!scoped) {
    actions.push({
      check: 'scope',
      action: 'warned',
      message: `ADLC scope audit: ${rel} is outside ticket ${ticket.id}'s declared scope [${(ticket.scope ?? []).join(', ')}]`,
    });
  }

  return { actions };
}

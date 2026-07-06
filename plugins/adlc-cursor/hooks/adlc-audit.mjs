#!/usr/bin/env node
// adlc-audit.mjs — the Cursor `afterFileEdit` hook.
//
// Cursor's afterFileEdit fires AFTER an edit is written and CANNOT block it
// (ADR 0006). This hook is therefore purely OBSERVATIONAL: if the edited path is
// a frozen rail, it surfaces a loud post-hoc notice so a slipped edit is visible
// in the session log — but it never denies. It always emits a no-op verdict and
// exits 0; the actual control is the preToolUse guard (best-effort) plus the
// unbypassable CI rail-freeze gate.
//
// T18 piggyback: after the rail audit, a FLAIL check runs over a recent-edits
// window this hook persists under .adlc/ (Cursor hooks receive no transcript,
// so the hook records its own window). The churn heuristic is imported from
// @adlc/flail-detector's lib subpath — no local heuristic copy. Advisory
// stderr notice only; a flail-detector load failure never takes down the rail
// audit (lazy dynamic import, swallowed).

import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRail } from '../rails-checker.mjs';
import { extractFilePaths, resolveOwning } from './adlc-rails-guard.mjs';
import { SESSION_TTL_MS, RECENT_EDITS_FILE } from '../constants.mjs';

/**
 * Observe an afterFileEdit payload. Returns { rail: boolean, reason } and, when a
 * rail was touched, writes a notice to stderr. Never blocks, never throws.
 */
export function audit(payload, { root, env = process.env } = {}) {
  try {
    // afterFileEdit names the file(s) directly; reuse the same extractor so batch
    // shapes (edits[]/files[]) are observed too.
    const paths = extractFilePaths(payload);
    if (!paths.length) {
      const fallback = firstAfterEditPath(payload);
      if (fallback) paths.push(fallback);
    }
    if (!paths.length) return { rail: false };
    for (const filePath of paths) {
      const owned = root != null ? { root, absFile: undefined } : resolveOwning(payload, filePath);
      const verdict = checkRail({ filePath: owned.absFile ?? filePath, tool: 'edit', root: owned.root, env });
      if (verdict.decision === 'deny') {
        process.stderr.write(
          `adlc-audit: POST-EDIT rail touch — ${verdict.reason}. ` +
          `afterFileEdit cannot block; the CI rail-freeze gate catches edits to rails already frozen on ` +
          `the base branch (a rail first declared on this branch is not caught until it lands on base — ` +
          `see ADR-0006 "Known scope limit").\n`,
        );
        return { rail: true, reason: verdict.reason };
      }
    }
    return { rail: false };
  } catch {
    // Observational only: swallow everything.
    return { rail: false };
  }
}

// afterFileEdit payloads carry the path at file_path / path at the top level.
function firstAfterEditPath(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  for (const k of ['file_path', 'filePath', 'path']) {
    if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k];
  }
  return undefined;
}

/**
 * T18 flail piggyback (advisory only): record this edit's path(s) into a
 * TTL-scoped recent-edits window at .adlc/<RECENT_EDITS_FILE> and run the real
 * @adlc/flail-detector churn heuristic over the window. Fires a stderr notice
 * when a path shows edit-churn (>= 3 edits inside the window); silent
 * otherwise. Never throws, never blocks. Skips (and creates nothing) when the
 * repo has no .adlc/ directory.
 *
 * The window file is agent-writable local state — this is an honest-agent
 * nudge, not a control; nothing backstops it.
 *
 * @returns {Promise<{flagged: boolean, skipped?: boolean, churn?: Array<{path: string, count: number}>}>}
 */
export async function flailCheck(payload, {
  root,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
  importModule = (spec) => import(spec),
} = {}) {
  try {
    const paths = extractFilePaths(payload);
    if (!paths.length) {
      const fallback = firstAfterEditPath(payload);
      if (fallback) paths.push(fallback);
    }
    if (!paths.length) return { flagged: false };

    const owningRoot = root ?? resolveOwning(payload, paths[0]).root;
    const adlcDir = join(owningRoot, '.adlc');
    if (!existsSync(adlcDir)) return { flagged: false, skipped: true }; // not an ADLC repo

    // Lazy import so a missing @adlc/flail-detector degrades ONLY this check.
    const { detectEditChurn } = await importModule('@adlc/flail-detector/lib/signals.mjs');

    // Load the persisted window, prune entries older than the TTL, append this
    // edit's paths, and persist back.
    const windowFile = join(adlcDir, RECENT_EDITS_FILE);
    let entries = [];
    try {
      entries = readFileSync(windowFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && typeof e.path === 'string' && typeof e.ts === 'number');
    } catch {
      // Missing/unreadable window → start fresh.
    }
    entries = entries.filter((e) => now - e.ts >= 0 && now - e.ts <= ttlMs);
    for (const p of paths) entries.push({ ts: now, path: p });
    writeFileSync(windowFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

    // Feed the window to the REAL flail churn detector via the tool-log line
    // shape its extractPath() already parses. Use the `"file_path":"<path>"`
    // form (extractPath's second pattern, `[^"]+`) rather than `Editing <path>`
    // (first pattern, `[^\s]+`), so a path CONTAINING SPACES is captured whole
    // instead of truncated at the first space (T18 F4).
    const churn = detectEditChurn(entries.map((e) => `"file_path":"${e.path}"`));
    if (!churn.length) return { flagged: false };

    const summary = churn.map((c) => `${c.path} (${c.count}x)`).join(', ');
    process.stderr.write(
      `adlc-audit: FLAIL signal (advisory) — edit churn inside the last ${Math.round(ttlMs / 60000)} min window: ${summary}. ` +
      `Repeatedly rewriting the same file is a context-rot tell; consider killing the session and regenerating fresh ` +
      `(see @adlc/flail-detector).\n`,
    );
    return { flagged: true, churn };
  } catch {
    // Observational only: swallow everything.
    return { flagged: false };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch { /* observational: ignore */ }
  }
  // audit() resolves the owning workspace root from the payload + edited path.
  audit(payload, { env: process.env });
  // T18: flail piggyback AFTER the rail audit — advisory stderr only.
  await flailCheck(payload);
  // afterFileEdit has no deny channel; emit an empty no-op object.
  process.stdout.write('{}');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

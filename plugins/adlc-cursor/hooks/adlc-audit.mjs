#!/usr/bin/env node
// adlc-audit.mjs — the Cursor `afterFileEdit` hook.
//
// Cursor's afterFileEdit fires AFTER an edit is written and CANNOT block it
// (ADR 0006). This hook is therefore purely OBSERVATIONAL: if the edited path is
// a frozen rail, it surfaces a loud post-hoc notice so a slipped edit is visible
// in the session log — but it never denies. It always emits a no-op verdict and
// exits 0; the actual control is the preToolUse guard (best-effort) plus the
// unbypassable CI rail-freeze gate.

import { fileURLToPath } from 'node:url';
import { checkRail } from '../rails-checker.mjs';
import { extractFilePath, resolveRoot } from './adlc-rails-guard.mjs';

/**
 * Observe an afterFileEdit payload. Returns { rail: boolean, reason } and, when a
 * rail was touched, writes a notice to stderr. Never blocks, never throws.
 */
export function audit(payload, { root, env = process.env } = {}) {
  try {
    // afterFileEdit names the file directly; reuse the same defensive extractor.
    const filePath = extractFilePath(payload) ?? firstAfterEditPath(payload);
    if (!filePath) return { rail: false };
    // Treat the edit as a structured mutation for classification purposes.
    const verdict = checkRail({ filePath, tool: 'edit', root: root ?? resolveRoot(payload, filePath), env });
    if (verdict.decision === 'deny') {
      process.stderr.write(
        `adlc-audit: POST-EDIT rail touch — ${verdict.reason}. ` +
        `afterFileEdit cannot block; the CI rail-freeze gate will reject this change.\n`,
      );
      return { rail: true, reason: verdict.reason };
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
  // afterFileEdit has no deny channel; emit an empty no-op object.
  process.stdout.write('{}');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

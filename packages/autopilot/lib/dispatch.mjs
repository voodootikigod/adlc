// Fleet dispatch (spec §6.4 invocation, §6.10 result, §2.1 resume rule, §7
// budgets, §12.1 deadline) — the one place the autopilot spawns fleet.
//
// Fleet is invoked with cwd = ISSUE_WT, the pinned adlc as argv[0], the
// sanitized base env plus the bound git overlay (never the manifest key), a
// deadline of the remaining wall clock + 5 minutes, and `--json`. The result
// document is parsed strictly: its `reason` is authoritative (§6.10), the
// `fleetRunId` must match a resumed run's record, and `cannot resume` on stderr
// is a refusal — never a silent restart.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { buildFleetArgv, fleetEnv } from './fleet-args.mjs';
import { validateIssueNumber } from './input.mjs';
import { writeAtomicJson } from './records.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['dispatch.keyInFleetEnv', 'dispatch.noDeadline']);

/** Parse fleet's stdout as its result document; null when it is not one. */
export function parseFleetResult(stdout) {
  try {
    const doc = JSON.parse(String(stdout ?? '').trim());
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (typeof doc.fleetRunId !== 'string' && doc.fleetRunId !== null) return null;
    return doc;
  } catch { return null; }
}

/**
 * Spawn fleet. Returns { exitCode, reason, parsed, resumeRefused, resumed, detail, findingsText }.
 */
export async function dispatchFleet({ ctx, issue, argv, cwd, deadlineMs }) {
  const n = validateIssueNumber(issue);
  const env = active('dispatch.keyInFleetEnv') ? { ...fleetEnv({ ctx }), ADLC_MANIFEST_KEY: ctx.key } : childEnv(fleetEnv({ ctx }));
  const res = await ctx.spawn({ argv, cwd, env, deadlineMs: active('dispatch.noDeadline') ? null : (deadlineMs ?? DEADLINES.fleetGraceMs), label: 'fleet run', stdoutCap: 16 * 1024 * 1024 });
  const parsed = parseFleetResult(res.stdout);
  const stderr = String(res.stderr ?? '');
  const resumeRefused = /^cannot resume:/m.test(stderr);
  const resumed = /^resuming run /m.test(stderr);
  const exitCode = res.timedOut ? 2 : (typeof res.status === 'number' ? res.status : 1);
  if (parsed) {
    try { writeAtomicJson(ctx.paths.fleetResult(parsed.fleetRunId ?? `issue-${n}-${ctx.iterationId}`), parsed); } catch { /* evidence is best effort */ }
  }
  const findingsText = parsed?.tickets ? Object.values(parsed.tickets).map((t) => `${t.reason ?? ''}\n${JSON.stringify(t.review ?? {})}`).join('\n') : stderr.slice(-12_000);
  return {
    exitCode: res.timedOut ? 2 : exitCode,
    reason: res.timedOut ? 'wall-clock' : (parsed?.reason ?? null),
    parsed: res.timedOut && !parsed ? { fleetRunId: null, reason: 'wall-clock', tickets: {} } : parsed,
    resumeRefused, resumed,
    detail: resumeRefused ? (stderr.match(/^cannot resume:.*$/m)?.[0] ?? 'cannot resume') : null,
    findingsText,
    stderr,
  };
}

/** Write REDACTED dead-end material for the next round (§6.6); returns the file path. */
export async function writeDeadEnd({ ctx, issue, text }) {
  const n = validateIssueNumber(issue);
  const r = ctx.redactor.redact(String(text ?? ''));
  const path = join(ctx.paths.runDir(n), `dead-end-${ctx.now()}.txt`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, r.text, { mode: 0o600 });
  return path;
}

/** The argv a dry-run prints (§2): the real builder over a placeholder ticket id and untouched budgets. */
export function previewFleetArgv({ ctx, issue, ticketId = 'T-<ULID>', roundsUsed = 0, wallClockUsedMs = 0 }) {
  const cfg = ctx.config?.autopilot ?? { maxRounds: 15, wallClockMinutes: 90 };
  const budget = { strikes: cfg.maxRounds - roundsUsed, wallClockMinutes: Math.floor((cfg.wallClockMinutes * 60_000 - wallClockUsedMs) / 60_000) };
  return buildFleetArgv({ ctx, issue, ticketId, budget, mirror: ctx.paths.mirror(issue), workerDeps: join(ctx.paths.workerDeps(issue), 'node_modules') });
}

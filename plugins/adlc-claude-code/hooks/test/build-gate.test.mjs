// build-gate.test.mjs — the PreToolUse fitness-to-build gate (issue #48) is
// security-critical, so it gets a committed regression test. Drives the real
// hook entrypoint as a subprocess (the hook is a script, not an importable
// module), the same way rails.test.mjs does.
//
// Contract: no .adlc / no tickets.json / no active ticket → allow (no-op).
// A conflicting active-ticket signal, unloadable tickets.json, or unknown
// active ticket → deny (fail closed). Normal-risk active ticket → allow
// regardless of session depth. High-risk active ticket → deny once the
// context-fitness signal (tool-call depth or transcript bytes) is past
// threshold, unless an audited ADLC_BUILD_GATE_BYPASS override is recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { HARD_BYTES, HARD_DEPTH } from '@adlc/context-handoff';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');
const NODE_DIR = dirname(process.execPath);
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin');
const WITH_ADLC = `${REPO_BIN}:${NODE_DIR}:${process.env.PATH ?? ''}`; // recorder reachable

/** Build a transcript file with N tool_use JSONL lines. */
function makeTranscript(dir, name, toolUseCount, { padBytes = 0 } = {}) {
  const line = JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] });
  const lines = Array.from({ length: toolUseCount }, () => line);
  if (padBytes > 0) lines.push('x'.repeat(padBytes));
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n'));
  return p;
}

/**
 * Run the buildgate hook in a throwaway repo.
 * @returns {{ verdict: 'deny'|'allow', out: string, manifest: string, dir: string }}
 */
function runBuildGate({
  tickets,
  activeTicketEnv,
  currentTicketFile,
  transcriptToolCalls,
  transcriptPadBytes,
  transcriptPathOverride,
  env = {},
}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-buildgate-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    if (tickets !== undefined) {
      writeFileSync(join(dir, '.adlc', 'tickets.json'), typeof tickets === 'string' ? tickets : JSON.stringify({ tickets }));
    }
    if (currentTicketFile !== undefined) {
      writeFileSync(join(dir, '.adlc', 'current-ticket.json'), typeof currentTicketFile === 'string' ? currentTicketFile : JSON.stringify(currentTicketFile));
    }
    let transcriptPath;
    if (transcriptToolCalls !== undefined) {
      transcriptPath = makeTranscript(dir, 'transcript.jsonl', transcriptToolCalls, { padBytes: transcriptPadBytes ?? 0 });
    }
    // Lets a test point transcript_path at something that EXISTS (so the
    // hook's existsSync guard passes) but cannot actually be read — a
    // directory, or a chmod'd-unreadable file — to exercise the post-exists
    // read-failure path distinctly from "no transcript_path at all".
    if (transcriptPathOverride !== undefined) {
      transcriptPath = transcriptPathOverride(dir);
    }
    const input = JSON.stringify({
      cwd: dir,
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'src', 'app.mjs') },
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    });
    const hookEnv = { ...process.env, CLAUDE_PROJECT_DIR: '', ...env };
    if (activeTicketEnv !== undefined) hookEnv.ADLC_TICKET = activeTicketEnv;
    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [HOOK, 'buildgate'], { input, encoding: 'utf8', env: hookEnv });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status;
    }
    const mp = join(dir, '.adlc', 'manifest.jsonl');
    const manifest = existsSync(mp) ? readFileSync(mp, 'utf8') : '';
    const verdict = out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow';
    return { verdict, out, manifest, status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- no-op: cannot brick a repo that hasn't opted in ----

test('no tickets file → allow', () => {
  const r = runBuildGate({ tickets: undefined, activeTicketEnv: 'T1' });
  assert.equal(r.verdict, 'allow');
});

test('tickets file exists but NO active ticket resolved → allow', () => {
  const r = runBuildGate({ tickets: [{ id: 'T1', title: 'x', category: 'contract' }] });
  assert.equal(r.verdict, 'allow');
});

test('active ticket resolved but risk tier is normal → allow regardless of depth', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'feature' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'allow');
});

// ---- fail closed: ambiguous/untrustworthy state ----

test('ADLC_TICKET conflicts with .adlc/current-ticket.json → deny', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x' }, { id: 'T2', title: 'y' }],
    activeTicketEnv: 'T1',
    currentTicketFile: { id: 'T2' },
  });
  assert.equal(r.verdict, 'deny');
});

test('unparseable .adlc/current-ticket.json → deny (tamper signal)', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x' }],
    currentTicketFile: 'not json',
  });
  assert.equal(r.verdict, 'deny');
});

test('active ticket id not found in tickets.json → deny', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x' }],
    activeTicketEnv: 'T404',
  });
  assert.equal(r.verdict, 'deny');
});

test('unparseable tickets.json with an active ticket set → deny', () => {
  const r = runBuildGate({ tickets: '{ not json', activeTicketEnv: 'T1' });
  assert.equal(r.verdict, 'deny');
});

test('tickets.json not in the expected shape (bare array) → deny', () => {
  const r = runBuildGate({ tickets: '[]', activeTicketEnv: 'T1' });
  assert.equal(r.verdict, 'deny');
});

test('high-risk active ticket but no transcript_path supplied → deny (cannot verify signal)', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    // transcriptToolCalls omitted → no transcript_path in the payload
  });
  assert.equal(r.verdict, 'deny');
});

// ---- fail closed: transcript_path exists (passes existsSync) but a later
// read fails — TOCTOU / permissions / wrong file type. Must deny, not
// silently treat the unreadable file as "zero bytes, not degraded". ----

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test(
  'high-risk ticket, transcript_path exists but is unreadable (chmod 0) → deny, not silently allow',
  { skip: isRoot ? 'chmod 0o000 has no effect when running as root' : false },
  () => {
    const r = runBuildGate({
      tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
      activeTicketEnv: 'T1',
      transcriptPathOverride: (dir) => {
        const p = makeTranscript(dir, 'unreadable-transcript.jsonl', 500);
        chmodSync(p, 0o000);
        return p;
      },
    });
    assert.equal(r.verdict, 'deny');
  }
);

test('high-risk ticket, transcript_path exists but is a directory (EISDIR on read) → deny', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptPathOverride: (dir) => {
      const p = join(dir, 'transcript-is-a-dir.jsonl');
      mkdirSync(p);
      return p;
    },
  });
  assert.equal(r.verdict, 'deny');
});

// ---- enforcement: high risk + degraded session ----

test('high-risk ticket (category: contract), shallow session → allow', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 2,
  });
  assert.equal(r.verdict, 'allow');
});

test('high-risk ticket (category: architecture), deep session (tool-call depth) → deny', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'architecture' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'deny');
});

test('high-risk ticket, deep session by BYTES (large transcript, low tool-call count) → deny', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 1,
    transcriptPadBytes: 9 * 1024 * 1024, // > the recalibrated 8 MiB threshold
  });
  assert.equal(r.verdict, 'deny');
});

test('high-risk ticket, a routine fresh-session-sized transcript (well over the OLD 256 KiB threshold) is NOT treated as degraded (Round-5 regression pin)', () => {
  // The exact reported bug this recalibration fixes: system-prompt/schema
  // overhead alone can push a fresh session's transcript well past 256 KiB
  // with zero real tool-call depth.
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 1,
    transcriptPadBytes: 400_000,
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('high-risk ticket, deep tool-call history EARLY in a transcript, pushed out of the old 256 KiB window by later padding, is still denied (Round-9 regression)', () => {
  // Round-9 review: BUILD_GATE_BYTES_THRESHOLD was recalibrated to 8 MiB, but
  // if the depth-counting SCAN WINDOW had stayed at the old 256 KiB, a
  // transcript sized between 256 KiB and 8 MiB with its real tool-call depth
  // EARLY in the file (pushed out of a 256 KiB tail window by later
  // non-tool-call padding) would be undercounted to a false "shallow" depth,
  // AND no longer trip the (now much higher) byte threshold either — the two
  // signals would stop jointly covering that size range. makeTranscript
  // appends padBytes AFTER the tool-call lines, so the tool calls sit early
  // and the padding dominates the tail — exactly this scenario.
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 50,
    transcriptPadBytes: 500 * 1024,
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('high-risk ticket via declared risk:"high" (not category) → deny once deep', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', risk: 'high' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'deny');
});

test('declared risk:"normal" cannot downgrade a derived-high signal → still deny once deep', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', risk: 'normal', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'deny');
});

// ---- fail closed on malformed ticket data (not a silent allow) ----

test('non-array scope field on the active ticket → fails closed to high risk, deny once deep', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', scope: 42 }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'deny');
});

test('non-array rails field on the active ticket → fails closed to high risk, deny once deep', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', rails: { foo: 'bar' } }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'deny');
});

test('.adlc/current-ticket.json alone (no env var) resolves the active ticket and gates it', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T9', title: 'x', category: 'contract' }],
    currentTicketFile: { id: 'T9' },
    transcriptToolCalls: 500,
  });
  assert.equal(r.verdict, 'deny');
});

// ---- audited override ----

test('bypass on a degraded high-risk build WITH a working recorder → allow + audited manifest entry', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T9', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T9',
    transcriptToolCalls: 500,
    env: { ADLC_BUILD_GATE_BYPASS: '1', PATH: WITH_ADLC },
  });
  assert.equal(r.verdict, 'allow');
  assert.match(r.manifest, /build-gate-bypass/);
  assert.match(r.manifest, /T9/);
});

test('bypass with the recorder UNAVAILABLE → deny (an unaudited override is refused)', () => {
  const noAdlcDir = mkdtempSync(join(tmpdir(), 'adlc-no-recorder-'));
  try {
    const r = runBuildGate({
      tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
      activeTicketEnv: 'T1',
      transcriptToolCalls: 500,
      env: { ADLC_BUILD_GATE_BYPASS: '1', PATH: noAdlcDir },
    });
    assert.equal(r.verdict, 'deny');
  } finally {
    rmSync(noAdlcDir, { recursive: true, force: true });
  }
});

test('bypass flag is ignored (no manifest write) when the session is NOT degraded', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: 1,
    env: { ADLC_BUILD_GATE_BYPASS: '1', PATH: WITH_ADLC },
  });
  assert.equal(r.verdict, 'allow');
  assert.equal(r.manifest.includes('build-gate-bypass'), false);
});

// ---- fail closed on unreadable/malformed input ----

test('malformed stdin in buildgate mode → fail closed (deny)', () => {
  let status = 0;
  try {
    execFileSync(process.execPath, [HOOK, 'buildgate'], { input: 'not json at all', encoding: 'utf8' });
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 2);
});

// ---- the buildgate matcher is wired into hooks.json ----

test('the PreToolUse matcher includes a buildgate hook entry (excludes Bash)', () => {
  const hooksJson = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks.json'), 'utf8')
  );
  const entry = hooksJson.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => h.command.includes('adlc-hook-run.mjs') && h.command.includes('buildgate'))
  );
  assert.ok(entry, 'a PreToolUse buildgate hook entry exists');
  assert.equal(/\bBash\b/.test(entry.matcher), false);
});

test('KEEP-IN-SYNC: BUILD_GATE_DEPTH_THRESHOLD tracks HARD_DEPTH; BUILD_GATE_BYTES_THRESHOLD is the deliberately recalibrated 8 MiB (Round-5)', () => {
  const src = readFileSync(HOOK, 'utf8');
  const depth = src.match(/const BUILD_GATE_DEPTH_THRESHOLD = (\d+);/);
  const bytes = src.match(/const BUILD_GATE_BYTES_THRESHOLD = ([^;]+);/);
  assert.ok(depth, 'depth constant present');
  assert.ok(bytes, 'bytes constant present');
  assert.equal(Number(depth[1]), HARD_DEPTH);
  // Deliberately NOT HARD_BYTES (256 KiB) — see BUILD_GATE_BYTES_THRESHOLD's
  // own comment: that would reproduce the exact false-lockout bug this
  // recalibration fixes. Pinned to the new, independently-chosen 8 MiB value
  // instead of context-handoff's own MAX_ACTIVE_CONTEXT_BYTES export so this
  // test still catches an accidental revert to HARD_BYTES.
  assert.equal(Function(`"use strict"; return (${bytes[1]});`)(), 8 * 1024 * 1024);
  assert.notEqual(Function(`"use strict"; return (${bytes[1]});`)(), HARD_BYTES);
  assert.match(src, /depth >= BUILD_GATE_DEPTH_THRESHOLD/);
  assert.match(src, /sessionBytes >= BUILD_GATE_BYTES_THRESHOLD/);
});

test('BUILD_GATE_SCAN_BYTES is exactly 8 MiB, matching BUILD_GATE_BYTES_THRESHOLD (Round-9)', () => {
  // BUILD_GATE_SCAN_BYTES must be AT LEAST BUILD_GATE_BYTES_THRESHOLD (see its
  // own comment) — pinning it below the threshold, or silently letting it drift
  // above without anyone noticing, both defeat the purpose of a documented
  // "deliberately separate but synchronized" constant. Pin the exact value so an
  // off-by-one (or any other) drift is caught here rather than by a much harder
  // to diagnose depth-undercounting bug at some untested boundary size.
  const src = readFileSync(HOOK, 'utf8');
  const scan = src.match(/const BUILD_GATE_SCAN_BYTES = ([^;]+);/);
  assert.ok(scan, 'scan-window constant present');
  const scanBytes = Function(`"use strict"; return (${scan[1]});`)();
  assert.equal(scanBytes, 8 * 1024 * 1024);
  const bytes = src.match(/const BUILD_GATE_BYTES_THRESHOLD = ([^;]+);/);
  const thresholdBytes = Function(`"use strict"; return (${bytes[1]});`)();
  assert.ok(scanBytes >= thresholdBytes, 'scan window must be at least the byte threshold');
});

test('high-risk ticket at exact HARD_DEPTH is denied (inclusive edge)', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: HARD_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
});

test('high-risk ticket just under HARD_DEPTH is allowed', () => {
  const r = runBuildGate({
    tickets: [{ id: 'T1', title: 'x', category: 'contract' }],
    activeTicketEnv: 'T1',
    transcriptToolCalls: HARD_DEPTH - 1,
  });
  assert.equal(r.verdict, 'allow');
});

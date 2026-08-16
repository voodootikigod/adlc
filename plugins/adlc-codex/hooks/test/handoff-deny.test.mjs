// handoff-deny.test.mjs — Codex PreToolUse context-handoff (slice 5).
// Drives the real hook script as a subprocess (same pattern as
// build-gate.test.mjs), never a re-implementation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  ensureDenyMarker,
  writeDenyRecord,
  writeResumeAuth,
  HANDOFF_DEPTH,
  RECOVERY_CLI_PATH,
} from '@adlc/context-handoff';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(HOOKS_DIR, 'adlc-handoff-gate.mjs');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

const REAL_NODE = realpathSync(process.execPath);
const REAL_RECOVERY_CLI = realpathSync(RECOVERY_CLI_PATH);

/** Build a transcript file with N tool_use JSONL lines. */
function makeTranscript(dir, name, toolUseCount) {
  const line = JSON.stringify({
    type: 'assistant',
    content: [{ type: 'tool_use', name: 'apply_patch' }],
  });
  const p = join(dir, name);
  writeFileSync(p, Array.from({ length: toolUseCount }, () => line).join('\n'));
  return p;
}

function runHandoff({
  sessionId = 'sess-a',
  omitSessionId = false,
  toolName = 'apply_patch',
  payloadExtra,
  transcriptToolCalls,
  transcriptName,
  seedDeny,
  rawInput,
  makeAdlcDir = true,
  env: extraEnv = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-codex-handoff-'));
  try {
    if (makeAdlcDir) mkdirSync(join(dir, '.adlc'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');

    if (typeof seedDeny === 'function') seedDeny(dir);

    let transcriptPath;
    if (transcriptToolCalls !== undefined) {
      transcriptPath = makeTranscript(
        dir,
        transcriptName ?? `${sessionId}.jsonl`,
        transcriptToolCalls,
      );
    }

    const payload = {
      tool_name: toolName,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      ...(payloadExtra ?? { file_path: join(dir, 'src', 'app.mjs') }),
    };
    if (!omitSessionId) payload.session_id = sessionId;

    const input = rawInput ?? JSON.stringify(payload);

    let out = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [HOOK], {
        input,
        encoding: 'utf8',
        cwd: dir,
        env: {
          ...process.env,
          NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH]
            .filter(Boolean)
            .join(':'),
          ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = e.stderr ?? '';
      status = e.status ?? 1;
    }

    const resolvedId = omitSessionId
      ? transcriptName
        ? transcriptName.replace(/\.jsonl$/, '')
        : null
      : sessionId;
    const markerPath = resolvedId
      ? join(dir, '.adlc', 'handoffs', 'denies', `${resolvedId}.json`)
      : null;

    return {
      verdict: status === 2 ? 'deny' : status === 0 ? 'allow' : 'error',
      status,
      out,
      markerExists: markerPath ? existsSync(markerPath) : false,
      marker: markerPath && existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed an open deny record owned by another session. */
function seedForeignDeny(name) {
  return (root) => {
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: name,
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
  };
}

test('clean ADLC repo without deny/handoff → allow apply_patch', () => {
  const r = runHandoff({ transcriptToolCalls: 5 });
  assert.equal(r.verdict, 'allow', r.out);
  assert.equal(r.markerExists, false);
});

test('a directory that is not an ADLC repo is left alone', () => {
  const r = runHandoff({ makeAdlcDir: false, transcriptToolCalls: 5 });
  assert.equal(r.verdict, 'allow', r.out);
});

test('open deny for another session without resume-auth → deny apply_patch', () => {
  const r = runHandoff({
    sessionId: 'consumer-1',
    seedDeny: seedForeignDeny('denier-1'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-1/);
});

test('apply_patch envelope paths are seen (not just file_path)', () => {
  const r = runHandoff({
    sessionId: 'consumer-1b',
    payloadExtra: {
      input: '*** Update File: src/app.mjs\n@@\n-export {}\n+export const x = 1\n',
    },
    seedDeny: seedForeignDeny('denier-1b'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-1b/);
});

test('shell is fail-closed-all under the deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-2',
    toolName: 'exec_command',
    payloadExtra: { command: 'ls' },
    seedDeny: seedForeignDeny('denier-2'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
});

test('under deny-set, shell `adlc handoff repair` is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-3',
    toolName: 'exec_command',
    payloadExtra: { command: 'adlc handoff repair --write' },
    seedDeny: seedForeignDeny('denier-3'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('under deny-set, a subshell handoff write is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-3b',
    toolName: 'bash',
    payloadExtra: { command: 'echo $(adlc handoff write --write)' },
    seedDeny: seedForeignDeny('denier-3b'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('shell is allowed when no deny-set is active', () => {
  const r = runHandoff({
    sessionId: 'sess-shell',
    toolName: 'exec_command',
    payloadExtra: { command: 'adlc handoff repair --write' },
    transcriptToolCalls: 2,
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('denier session stays denied after consume (D2 sticky)', () => {
  const r = runHandoff({
    sessionId: 'denier-sticky',
    seedDeny: (root) => {
      seedForeignDeny('denier-sticky')(root);
      writeDenyRecord(root, {
        session_id: 'denier-sticky',
        ticket_id: 'T1',
        content_hash: 'abc',
        status: 'consumed',
        since: new Date().toISOString(),
        host: 'test',
        schema: 1,
      });
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D2:denier_session/);
});

test('handoff band ensures a deny marker for the current session', () => {
  const r = runHandoff({
    sessionId: 'deep-sess',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true, 'ensureDenyMarker must write denies/<session>.json');
  assert.match(r.marker, /"status": "open"/);
  assert.match(r.marker, /"host": "codex"/);
});

test('transcript_path stem supplies the session id when the payload omits one', () => {
  const r = runHandoff({
    omitSessionId: true,
    transcriptName: 'stem-sess.jsonl',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true, 'the stem must become the marker filename');
});

test('no usable session id under deny-store pressure → fail closed', () => {
  const r = runHandoff({
    omitSessionId: true,
    seedDeny: seedForeignDeny('denier-4'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D0:invalid_session_id/);
});

test('no usable session id on a clean repo still allows', () => {
  const r = runHandoff({ omitSessionId: true, transcriptToolCalls: 3 });
  assert.equal(r.verdict, 'allow', r.out);
});

test('writing a handoff trust-root path is denied even with a cold store', () => {
  const r = runHandoff({
    sessionId: 'sneaky',
    payloadExtra: { file_path: '.adlc/handoffs/denies/sneaky.json' },
    transcriptToolCalls: 2,
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /path_protected/);
});

test('resume-auth / model-ok / lock artifacts are protected too', () => {
  for (const rel of [
    '.adlc/handoffs/sess-a.resume-auth.json',
    '.adlc/handoffs/sess-a.model-ok',
    '.adlc/handoffs/sess-a.lock',
    '.adlc/.deny-store',
  ]) {
    const r = runHandoff({
      sessionId: 'sneaky',
      payloadExtra: { file_path: rel },
      transcriptToolCalls: 2,
    });
    assert.equal(r.verdict, 'deny', `${rel} must be protected`);
    assert.match(r.out, /path_protected/);
  }
});

test('the hook never hands the manifest key to project-resolved code', () => {
  // handoff-resolve.mjs deliberately resolves @adlc/context-handoff from the
  // PROJECT's node_modules, so the imported module is project-controlled. If
  // the hook passed ADLC_MANIFEST_KEY into it, any repository shipping a
  // package by that name could exfiltrate the manifest trust anchor. The
  // observable contract: even WITH a key in the environment and a validly
  // signed resume-auth on disk, this hook cannot verify it — and says so.
  const key = 'a'.repeat(64);
  const seed = (root) => {
    seedForeignDeny('denier-resume')(root);
    assert.equal(
      writeResumeAuth(
        root,
        'consumer-resume',
        { ticketId: 'T1', contentHash: 'abc', denySessionId: 'denier-resume' },
        { key },
      ).ok,
      true,
    );
  };

  for (const envKey of ['', key]) {
    const r = runHandoff({
      sessionId: 'consumer-resume',
      seedDeny: seed,
      env: { ADLC_MANIFEST_KEY: envKey },
    });
    assert.equal(r.verdict, 'deny', `key=${envKey ? 'set' : 'unset'} must still deny`);
    assert.match(r.out, /resume_auth_unverifiable:no_manifest_key/);
  }

  const source = readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(
    source,
    /manifestKey:\s*process\.env/,
    'the key must not be threaded into the dynamically resolved module',
  );
});

test('the direct-execution guard survives a path containing a space', () => {
  // `file://${argv[1]}` does not match import.meta.url for a percent-encoded
  // path, so main() would never run and the hook would exit 0 — read as ALLOW.
  // realpathSync: macOS tmpdir() is itself a symlink, and import.meta.url is
  // always the RESOLVED path — without this the two would differ for a reason
  // that has nothing to do with the space this test is about.
  const spaced = realpathSync(mkdtempSync(join(tmpdir(), 'adlc codex hook ')));
  try {
    const copyDir = join(spaced, 'hooks');
    mkdirSync(copyDir, { recursive: true });
    for (const f of [
      'adlc-handoff-gate.mjs',
      'handoff-resolve.mjs',
      'adlc-build-gate.mjs',
      'generated-active-ticket.mjs',
      'generated-ticket-reader.mjs',
      'generated-glob-match.mjs',
    ]) {
      copyFileSync(join(HOOKS_DIR, f), join(copyDir, f));
    }
    // Let the resolver find the package by walking up from the spaced hooks
    // dir, so this asserts the real deny rather than the fail-closed path.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(spaced, 'node_modules'), 'dir');
    const repo = mkdtempSync(join(tmpdir(), 'adlc-codex-spaced-'));
    try {
      mkdirSync(join(repo, '.adlc'), { recursive: true });
      seedForeignDeny('denier-spaced')(repo);
      let status = 0;
      let out = '';
      try {
        execFileSync(process.execPath, [join(copyDir, 'adlc-handoff-gate.mjs')], {
          input: JSON.stringify({
            session_id: 'consumer-spaced',
            tool_name: 'apply_patch',
            file_path: 'src/app.mjs',
          }),
          encoding: 'utf8',
          cwd: repo,
          env: {
            ...process.env,
            NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH]
              .filter(Boolean)
              .join(':'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        out = e.stderr ?? '';
        status = e.status ?? 1;
      }
      assert.equal(status, 2, `the hook must still enforce from a spaced path: ${out}`);
      assert.match(out, /D3:unauthorized_open:denier-spaced/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});

test('a supplied but missing transcript fails closed; an absent one does not', () => {
  // Absent field → no signal → a harness without telemetry stays usable.
  const absent = runHandoff({ sessionId: 'sess-absent' });
  assert.equal(absent.verdict, 'allow', absent.out);

  // Supplied but unreachable → a FAILED read of a real signal, not the absence
  // of one. A rotated or deleted transcript must not read as "no pressure".
  const missing = runHandoff({
    sessionId: 'sess-missing',
    payloadExtra: { file_path: 'src/app.mjs', transcript_path: '/nonexistent/rotated.jsonl' },
  });
  assert.equal(missing.verdict, 'deny', missing.out);
});

test('malformed stdin fails closed', () => {
  const r = runHandoff({ rawInput: '{not json' });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /malformed hook payload JSON/);
});

test('hooks.json wires the handoff hook on the PreToolUse mutation matcher', () => {
  const wiring = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const pre = wiring.hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length > 0);
  const entry = pre.find((group) =>
    group.hooks.some((h) => h.command.includes('adlc-handoff-gate.mjs')),
  );
  assert.ok(entry, 'PreToolUse must run adlc-handoff-gate.mjs');
  // The matcher must cover both structured edits and the shell, or the
  // fail-closed-all rule has a hole the deny-set cannot see.
  for (const tool of ['apply_patch', 'write', 'Edit', 'Bash', 'exec_command', 'write_stdin']) {
    assert.match(tool, new RegExp(entry.matcher), `matcher must cover ${tool}`);
  }
});

test('the plugin ships the new hook and its resolver', () => {
  const pkg = JSON.parse(readFileSync(join(HOOKS_DIR, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('hooks/*.mjs'), 'files must ship hooks/*.mjs');
  assert.ok(existsSync(join(HOOKS_DIR, 'handoff-resolve.mjs')));
  // Track the workspace version rather than pinning a literal: a release bump
  // must not turn into a rebase conflict in an enforcement contract test.
  const corePkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'context-handoff', 'package.json'), 'utf8'),
  );
  assert.equal(pkg.dependencies['@adlc/context-handoff'], corePkg.version);
});

test('a nested shell call inside a parallel envelope is scanned for protected paths', () => {
  // multi_tool_use.parallel is in this hook's PreToolUse matcher, but the outer
  // envelope is not itself a shell tool. Reading only the outer name left the
  // nested command unscanned, so this deletion was allowed on a cold deny-set
  // while the same command sent directly was denied.
  const r = runHandoff({
    sessionId: 'parallel-1',
    toolName: 'multi_tool_use.parallel',
    transcriptToolCalls: 5,
    payloadExtra: {
      tool_uses: [
        {
          recipient_name: 'functions.exec_command',
          parameters: { command: 'rm -rf .adlc/handoffs .adlc/.deny-store' },
        },
      ],
    },
  });
  assert.equal(r.verdict, 'deny', r.out);
  assert.match(r.out, /path_protected_shell/);
});

test('a parallel envelope carrying only ordinary work is still allowed', () => {
  const r = runHandoff({
    sessionId: 'parallel-2',
    toolName: 'multi_tool_use.parallel',
    transcriptToolCalls: 5,
    payloadExtra: {
      tool_uses: [
        { recipient_name: 'functions.exec_command', parameters: { command: 'cat ./src/app.mjs' } },
        { recipient_name: 'functions.apply_patch', parameters: { path: 'src/app.mjs' } },
      ],
    },
  });
  assert.equal(r.verdict, 'allow', r.out);
});

// --- Recovery Exception & Inspection Bash Exception (spec §1.3, AC0) -------
//
// The production incident this ticket exists to fix denied EVERY shell
// invocation on a hard-degraded session — including `pwd` and the operator's
// own recovery CLI. Both MUST now be allowed unconditionally, regardless of
// band state, evaluated before any other Hard-Degraded/deny check.

test('Inspection Bash Exception: bare pwd is allowed even under an open deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-pwd',
    toolName: 'exec_command',
    payloadExtra: { command: 'pwd' },
    seedDeny: seedForeignDeny('denier-pwd'),
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('Inspection Bash Exception: pwd with an argument or shell chaining is NOT exempt', () => {
  for (const decoy of ['pwd -L', 'pwd; ls', 'pwd && rm -rf /']) {
    const r = runHandoff({
      sessionId: 'consumer-pwd-decoy',
      toolName: 'exec_command',
      payloadExtra: { command: decoy },
      seedDeny: seedForeignDeny('denier-pwd-decoy'),
    });
    assert.equal(r.verdict, 'deny', `decoy should still deny: ${decoy}`);
  }
});

test('Recovery Exception: write_stdin carrying the literal text "pwd" is NOT the Inspection Exception', () => {
  // write_stdin delivers input to an EXISTING process, not a standalone
  // command — the same literal text means something entirely different.
  const r = runHandoff({
    sessionId: 'consumer-write-stdin',
    toolName: 'write_stdin',
    payloadExtra: { chars: 'pwd' },
    seedDeny: seedForeignDeny('denier-write-stdin'),
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('Recovery Exception: evil.exec_command (attacker prefix before the dot) is NOT eligible', () => {
  const r = runHandoff({
    sessionId: 'consumer-evil',
    toolName: 'evil.exec_command',
    payloadExtra: { command: 'pwd' },
    seedDeny: seedForeignDeny('denier-evil'),
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('Recovery Exception: the real bypass command is allowed even under an open deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery',
    toolName: 'exec_command',
    payloadExtra: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-recovery --write` },
    seedDeny: seedForeignDeny('denier-recovery'),
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('Recovery Exception: functions.exec_command via recipient_name/cmd field also matches', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery-alias',
    rawInput: JSON.stringify({
      recipient_name: 'functions.exec_command',
      session_id: 'consumer-recovery-alias',
      tool_input: { cmd: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-recovery-alias --write` },
    }),
    seedDeny: seedForeignDeny('denier-recovery-alias'),
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('Recovery Exception: a decoy that merely resembles the recovery command is still denied', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery-decoy',
    toolName: 'exec_command',
    payloadExtra: {
      command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-recovery-decoy --write; rm -rf /`,
    },
    seedDeny: seedForeignDeny('denier-recovery-decoy'),
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('Recovery Exception: --session naming a DIFFERENT session than this one is denied', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery-other',
    toolName: 'exec_command',
    payloadExtra: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session some-other-session --write` },
    seedDeny: seedForeignDeny('denier-recovery-other'),
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('a multi_tool_use.parallel envelope carrying an eligible nested exec is NOT the Recovery Exception at the top level', () => {
  const r = runHandoff({
    sessionId: 'consumer-parallel-recovery',
    toolName: 'multi_tool_use.parallel',
    payloadExtra: {
      tool_uses: [
        {
          recipient_name: 'functions.exec_command',
          parameters: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-parallel-recovery --write` },
        },
      ],
    },
    seedDeny: seedForeignDeny('denier-parallel-recovery'),
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('deny diagnostic includes the literal, copy-pasteable recovery command for the resolved session', () => {
  const r = runHandoff({
    sessionId: 'consumer-diag',
    seedDeny: seedForeignDeny('denier-diag'),
  });
  assert.equal(r.verdict, 'deny');
  assert.ok(r.out.includes(REAL_NODE), r.out);
  assert.ok(r.out.includes(REAL_RECOVERY_CLI), r.out);
  assert.match(r.out, /bypass --session consumer-diag --write/);
});

test('an incomplete transcript scan restricts an ordinary mutation but never pwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-codex-handoff-truncated-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    const line = JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'apply_patch' }] });
    const transcriptPath = join(dir, 'oversized.jsonl');
    // 9 MiB of padding pushes the file past MAX_ACTIVE_CONTEXT_BYTES (8 MiB).
    writeFileSync(transcriptPath, `${line}\n${line}\n${'x'.repeat(9 * 1024 * 1024)}`);

    const applyPatchEnv = {
      ...process.env,
      NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
    };

    const applyPatchPayload = JSON.stringify({
      tool_name: 'apply_patch',
      session_id: 'consumer-truncated-apply',
      transcript_path: transcriptPath,
      input: '*** Update File: src/app.mjs\n@@\n-export {}\n+export const x = 1\n',
    });
    let applyOut = '';
    let applyStatus = 0;
    try {
      execFileSync(process.execPath, [HOOK], { input: applyPatchPayload, encoding: 'utf8', cwd: dir, env: applyPatchEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      applyOut = e.stderr ?? '';
      applyStatus = e.status ?? 1;
    }
    assert.equal(applyStatus, 2, applyOut);
    assert.match(applyOut, /incomplete_scan_lower_bound/);

    const pwdPayload = JSON.stringify({
      tool_name: 'exec_command',
      session_id: 'consumer-truncated-pwd',
      transcript_path: transcriptPath,
      command: 'pwd',
    });
    let pwdStatus = 0;
    try {
      execFileSync(process.execPath, [HOOK], { input: pwdPayload, encoding: 'utf8', cwd: dir, env: applyPatchEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      pwdStatus = e.status ?? 1;
    }
    assert.equal(pwdStatus, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh session under the old 256 KiB MAX_SCAN_BYTES ceiling now allows ordinary mutations', () => {
  // Deliberately sized between the OLD 256 KiB ceiling and the new 8 MiB one —
  // this is the exact regression the hotfix exists to close (AC0 bullet 2).
  const dir = mkdtempSync(join(tmpdir(), 'adlc-codex-handoff-largebaseline-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    const line = JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'apply_patch' }] });
    const transcriptPath = join(dir, 'large.jsonl');
    writeFileSync(transcriptPath, `${line}\n${line}\n${'x'.repeat(400 * 1024)}`);

    const payload = JSON.stringify({
      tool_name: 'apply_patch',
      session_id: 'consumer-large-baseline',
      transcript_path: transcriptPath,
      input: '*** Update File: src/app.mjs\n@@\n-export {}\n+export const x = 1\n',
    });
    let status = 0;
    let out = '';
    try {
      execFileSync(process.execPath, [HOOK], {
        input: payload,
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = e.stderr ?? '';
      status = e.status ?? 1;
    }
    assert.equal(status, 0, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Recovery Exception check happens BEFORE package load, not after (source order pin)', () => {
  // Same regression class as the Claude Code hook's own pin: a
  // broken/incompatible/hostile @adlc/context-handoff must never be able to
  // deny pwd or the recovery CLI before this check even runs.
  const source = readFileSync(HOOK, 'utf8');
  const mainStart = source.indexOf('async function main()');
  assert.ok(mainStart >= 0, 'main() not found');
  const body = source.slice(mainStart);
  const pwdCheckIdx = body.indexOf('isBareInspectionPwd(candidateCommand)');
  const loadIdx = body.indexOf('await loadContextHandoff(');
  assert.ok(pwdCheckIdx >= 0, 'isBareInspectionPwd check not found in main()');
  assert.ok(loadIdx >= 0, 'loadContextHandoff call not found in main()');
  assert.ok(pwdCheckIdx < loadIdx, 'isBareInspectionPwd must be checked BEFORE loadContextHandoff');
});

// --- recoveryDiagnostic: independent of the dynamically-loaded package -----
// (Round-4 Finding 6 + Round-5 Finding 4)

test('recoveryDiagnostic prints a real, absolute, session-bound recovery command — built entirely from trusted local code, no api parameter', async () => {
  // Round-5 review: the OLD implementation formatted via api.formatRecoveryCommand
  // / api.RECOVERY_CLI_PATH — the same dynamically-loaded, project-resolved
  // package whose failure to load or export what's expected is exactly what
  // every early fail() in main() is reporting when it appends this
  // diagnostic. recoveryDiagnostic no longer takes an api parameter at all —
  // it resolves the CLI path via the same trusted, execution-free
  // resolveContextHandoffEntry the allow-path exception uses, and formats
  // via this file's own trusted local twins.
  const { recoveryDiagnostic } = await import('../adlc-handoff-gate.mjs');
  const out = recoveryDiagnostic('sess-a');
  assert.match(out, /bypass --session sess-a --write/);
  assert.doesNotMatch(out, /Recovery command unavailable/);
});

test('recoveryDiagnostic degrades to the no-safe-session-id message when sessionId is null', async () => {
  const { recoveryDiagnostic } = await import('../adlc-handoff-gate.mjs');
  const out = recoveryDiagnostic(null);
  assert.match(out, /No session id could be resolved/);
  assert.match(out, /pwd/);
});

test('the top-level crash handler appends recoveryDiagnostic(lastKnownSessionId), not a bare error message (Round-5 Finding 4, source pin)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-handoff-gate.mjs'), 'utf8');
  assert.match(source, /let lastKnownSessionId = null;/);
  assert.match(source, /lastKnownSessionId = sessionId;/);
  assert.match(
    source,
    /fail\(`handoff hook errored \(\$\{err\?\.message \?\? 'unknown'\}\) — failing closed\\n\\n\$\{recoveryDiagnostic\(lastKnownSessionId\)\}`\);/,
  );
});

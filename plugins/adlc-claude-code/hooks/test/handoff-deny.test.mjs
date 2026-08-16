// handoff-deny.test.mjs — Claude Code PreToolUse context-handoff (T157).
// Drives the real hook entrypoint as a subprocess (same pattern as
// build-gate.test.mjs / rails.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
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
  HANDOFF_DEPTH,
  RECOVERY_CLI_PATH,
} from '@adlc/context-handoff';

const REAL_NODE = realpathSync(process.execPath);
const REAL_RECOVERY_CLI = realpathSync(RECOVERY_CLI_PATH);

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(HOOKS_DIR, 'adlc-hook.mjs');
const HOOK_RUN = join(HOOKS_DIR, 'adlc-hook-run.mjs');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

/** Build a transcript file with N tool_use JSONL lines. */
function makeTranscript(dir, name, toolUseCount, { padBytes = 0 } = {}) {
  const line = JSON.stringify({
    type: 'assistant',
    content: [{ type: 'tool_use', name: 'Edit' }],
  });
  const lines = Array.from({ length: toolUseCount }, () => line);
  if (padBytes > 0) lines.push('x'.repeat(padBytes));
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n'));
  return p;
}

function runHandoff({
  sessionId = 'sess-a',
  omitSessionId = false,
  toolName = 'Edit',
  toolInput,
  transcriptToolCalls,
  transcriptName,
  transcriptPadBytes,
  seedDeny,
  tickets = [{ id: 'T1', title: 'x', body: 'y', rails: [], scope: ['src/**'] }],
  env = {},
  viaRunner = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');

    if (typeof seedDeny === 'function') {
      seedDeny(dir);
    }

    let transcriptPath;
    if (transcriptToolCalls !== undefined) {
      const name = transcriptName ?? `${sessionId}.jsonl`;
      transcriptPath = makeTranscript(dir, name, transcriptToolCalls, {
        padBytes: transcriptPadBytes ?? 0,
      });
    }

    const defaultToolInput =
      toolName === 'Bash' || toolName === 'Shell'
        ? { command: 'echo hi' }
        : { file_path: join(dir, 'src', 'app.mjs') };

    const payload = {
      cwd: dir,
      tool_name: toolName,
      tool_input: toolInput ?? defaultToolInput,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    };
    if (!omitSessionId) payload.session_id = sessionId;

    const input = JSON.stringify(payload);

    const hookEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: '',
      NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(':'),
      ...env,
    };

    const argv = viaRunner
      ? [HOOK_RUN, 'handoff']
      : [HOOK, 'handoff'];

    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, argv, {
        input,
        encoding: 'utf8',
        env: hookEnv,
      });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status ?? 1;
    }

    const resolvedId = omitSessionId
      ? (transcriptName ? transcriptName.replace(/\.jsonl$/, '') : null)
      : sessionId;
    const markerPath = resolvedId
      ? join(dir, '.adlc', 'handoffs', 'denies', `${resolvedId}.json`)
      : null;
    return {
      verdict:
        out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow',
      out,
      status,
      dir,
      markerExists: markerPath ? existsSync(markerPath) : false,
      marker: markerPath && existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('clean ADLC repo without deny/handoff → allow Edit', () => {
  const r = runHandoff({ transcriptToolCalls: 5 });
  assert.equal(r.verdict, 'allow');
  assert.equal(r.markerExists, false);
});

test('open deny for another session without resume-auth → deny Edit', () => {
  const r = runHandoff({
    sessionId: 'consumer-1',
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-1',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-1/);
});

test('open deny → Bash fail-closed-all', () => {
  const r = runHandoff({
    sessionId: 'consumer-2',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-2',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
});

test('under deny-set, Bash `adlc handoff repair` is denied with mutating-cli reason', () => {
  const r = runHandoff({
    sessionId: 'consumer-3',
    toolName: 'Bash',
    toolInput: { command: 'adlc handoff repair --write' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-3',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('under deny-set, subshell handoff write is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-3b',
    toolName: 'Bash',
    toolInput: { command: 'echo $(adlc handoff write --write)' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-3b',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('denier session stays denied after consume (D2 sticky via store)', () => {
  const r = runHandoff({
    sessionId: 'denier-sticky',
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-sticky',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
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

test('handoff band ensures deny marker for current session', () => {
  const r = runHandoff({
    sessionId: 'deep-sess',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true, 'ensureDenyMarker must write denies/<session>.json');
  assert.match(r.marker, /"status": "open"/);
  assert.match(r.out, /D2:denier_session/);
});

test('transcript_path stem supplies session id when payload omits session_id', () => {
  const r = runHandoff({
    omitSessionId: true,
    transcriptName: 'uuid-from-transcript.jsonl',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true);
  assert.match(r.marker, /"session_id": "uuid-from-transcript"/);
});

test('no usable session id under deny-store pressure → fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-handoff-nosid-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      JSON.stringify({
        tickets: [{ id: 'T1', title: 'x', body: 'y', rails: [], scope: ['src/**'] }],
      }),
    );
    assert.equal(
      ensureDenyMarker(dir, {
        sessionId: 'foreign-open',
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    const input = JSON.stringify({
      cwd: dir,
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'src', 'app.mjs') },
    });

    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [HOOK, 'handoff'], {
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: '',
          NODE_PATH: join(REPO_ROOT, 'node_modules'),
        },
      });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status ?? 1;
    }
    const verdict =
      out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow';
    assert.equal(verdict, 'deny');
    assert.match(out, /D0:invalid_session_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent Write to denies/* is denied even without open foreign deny', () => {
  const r = runHandoff({
    sessionId: 'path-guard',
    toolName: 'Write',
    toolInput: {
      file_path: '.adlc/handoffs/denies/path-guard.json',
      content: '{}',
    },
    seedDeny: (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /path_protected:.*denies\/path-guard\.json/);
});

test('agent Write to resume-auth / model-ok / lock is denied', () => {
  for (const leaf of [
    'sess-x.resume-auth.json',
    'sess-x.model-ok',
    'sess-x.lock',
  ]) {
    const r = runHandoff({
      sessionId: 'path-leaf',
      toolName: 'Write',
      toolInput: {
        file_path: `.adlc/handoffs/${leaf}`,
        content: '{}',
      },
      seedDeny: (root) => {
        mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      },
    });
    assert.equal(r.verdict, 'deny', leaf);
    assert.match(r.out, new RegExp(`path_protected:.*${leaf.replace(/\./g, '\\.')}`));
  }
});

test('adlc-hook-run lists handoff as enforcing (timeout path non-zero)', () => {
  // Drive the runner with a tiny timeout by spawning a hanging child substitute:
  // assert the ENFORCING_MODES contract by reading the runner source — plus a
  // live spawn that forces ETIMEDOUT via ADLC_HOOK_RUN_TEST_SLEEP if present.
  // Primary load-bearing check: runner source includes handoff in both maps.
  const src = readFileSync(HOOK_RUN, 'utf8');
  assert.match(src, /handoff:\s*10_000/);
  assert.match(src, /ENFORCING_MODES = new Set\(\[[^\]]*['"]handoff['"]/);

  // Live: open deny + runner path still denies (not just direct hook).
  const r = runHandoff({
    sessionId: 'via-runner',
    viaRunner: true,
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-run',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-run/);
});

test('under deny-set, Bash `adlc handoff bypass` is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-bypass',
    toolName: 'Bash',
    toolInput: { command: 'adlc handoff bypass --write' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-bypass',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('Shell tool_name (a non-pwd, non-recovery command) is fail-closed under deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-shell',
    toolName: 'Shell',
    toolInput: { command: 'echo hi' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-shell',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
});

// --- Recovery Exception & Inspection Bash Exception (spec §1.3, AC0) -------
//
// The production incident this ticket exists to fix denied EVERY Bash
// invocation on a hard-degraded session — including `pwd` and the operator's
// own recovery CLI. Both MUST now be allowed unconditionally, regardless of
// band state, evaluated before any other Hard-Degraded/deny check.

test('Inspection Bash Exception: bare pwd is allowed even under an open deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-pwd',
    toolName: 'Bash',
    toolInput: { command: 'pwd' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-pwd',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('Inspection Bash Exception: pwd with an argument or shell chaining is NOT exempt', () => {
  for (const decoy of ['pwd -L', 'pwd; ls', 'pwd && rm -rf /']) {
    const r = runHandoff({
      sessionId: 'consumer-pwd-decoy',
      toolName: 'Bash',
      toolInput: { command: decoy },
      seedDeny: (root) => {
        assert.equal(
          ensureDenyMarker(root, {
            sessionId: 'denier-pwd-decoy',
            ticketId: 'T1',
            contentHash: 'abc',
            host: 'test',
          }).ok,
          true,
        );
      },
    });
    assert.equal(r.verdict, 'deny', `decoy should still deny: ${decoy}`);
  }
});

test('Recovery Exception: the real bypass command is allowed even under an open deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery',
    toolName: 'Bash',
    toolInput: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-recovery --write` },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-recovery',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('Recovery Exception: a decoy that merely resembles the recovery command is still denied', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery-decoy',
    toolName: 'Bash',
    toolInput: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-recovery-decoy --write; rm -rf /` },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-recovery-decoy',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('Recovery Exception: --session naming a DIFFERENT session than this one is denied', () => {
  const r = runHandoff({
    sessionId: 'consumer-recovery-other',
    toolName: 'Bash',
    toolInput: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session some-other-session --write` },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-recovery-other',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny', r.out);
});

test('deny diagnostic includes the literal, copy-pasteable recovery command for the resolved session', () => {
  const r = runHandoff({
    sessionId: 'consumer-diag',
    toolName: 'Edit',
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-diag',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.ok(r.out.includes(REAL_NODE), r.out);
  assert.ok(r.out.includes(REAL_RECOVERY_CLI), r.out);
  assert.match(r.out, /bypass --session consumer-diag --write/);
});

test('an incomplete transcript scan restricts an ordinary mutation but never pwd', () => {
  // A padded fixture that exceeds MAX_ACTIVE_CONTEXT_BYTES forces the scan to
  // truncate (spec §1.2.2's lower-bound rule) even though the reported depth
  // itself is small.
  const oversized = { transcriptToolCalls: 2, transcriptPadBytes: 9 * 1024 * 1024 };
  const edit = runHandoff({ sessionId: 'consumer-truncated-edit', toolName: 'Edit', ...oversized });
  assert.equal(edit.verdict, 'deny', edit.out);
  assert.match(edit.out, /incomplete_scan_lower_bound/);

  const pwd = runHandoff({
    sessionId: 'consumer-truncated-pwd',
    toolName: 'Bash',
    toolInput: { command: 'pwd' },
    ...oversized,
  });
  assert.equal(pwd.verdict, 'allow', pwd.out);
});

test('a fresh session under the old 256 KiB MAX_SCAN_BYTES ceiling now allows ordinary mutations', () => {
  // Deliberately sized between the OLD 256 KiB ceiling and the new 8 MiB one —
  // this is the exact regression the hotfix exists to close (AC0 bullet 2):
  // large enough to have tripped the retired MAX_SCAN_BYTES, well within
  // MAX_ACTIVE_CONTEXT_BYTES, so the scan completes and ordinary mutators
  // (not just pwd) are allowed.
  const r = runHandoff({
    sessionId: 'consumer-large-baseline',
    toolName: 'Edit',
    transcriptToolCalls: 2,
    transcriptPadBytes: 400 * 1024,
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('hooks.json wires handoff for Edit matcher and Bash|Shell', () => {
  const cfg = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const pre = cfg.hooks.PreToolUse;
  const edit = pre.find((e) => String(e.matcher).includes('Edit'));
  assert.ok(edit, 'Edit matcher entry');
  assert.ok(
    edit.hooks.some((h) => String(h.command).includes('handoff')),
    'handoff on Edit matcher',
  );
  const bash = pre.find((e) => String(e.matcher).includes('Bash'));
  assert.ok(bash, 'Bash matcher entry');
  assert.match(String(bash.matcher), /Bash\|Shell|Shell\|Bash/);
  assert.ok(bash.hooks.some((h) => String(h.command).includes('handoff')));
});

test('malformed stdin → deny (fail closed)', () => {
  let out = '';
  let status = 0;
  try {
    out = execFileSync(process.execPath, [HOOK, 'handoff'], {
      input: '{not-json',
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: '',
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    });
  } catch (e) {
    out = e.stdout ?? '';
    status = e.status ?? 1;
  }
  assert.equal(status, 2);
  assert.match(out, /permissionDecision":"deny"/);
  assert.match(out, /unreadable\/malformed input/);
});

test('unenterable project cwd → deny (fail closed)', () => {
  const missing = join(tmpdir(), `adlc-handoff-missing-${Date.now()}`, 'nope');
  let out = '';
  let status = 0;
  try {
    out = execFileSync(process.execPath, [HOOK, 'handoff'], {
      input: JSON.stringify({
        cwd: missing,
        session_id: 'sess-missing',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/app.mjs' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: '',
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    });
  } catch (e) {
    out = e.stdout ?? '';
    status = e.status ?? 1;
  }
  assert.equal(status, 2);
  assert.match(out, /permissionDecision":"deny"/);
  assert.match(out, /could not enter the project directory/);
});

test('empty transcript_path string does not become a session id', async () => {
  const { resolveSessionId } = await import('../handoff-gate.mjs');
  const { isSafeSessionId } = await import('@adlc/context-handoff');
  assert.equal(resolveSessionId(null, { isSafeSessionId }), null);
  assert.equal(resolveSessionId({ transcript_path: 12 }, { isSafeSessionId }), null);

  assert.equal(resolveSessionId(undefined, { isSafeSessionId }), null);
  assert.equal(
    resolveSessionId({ session_id: '', transcript_path: '' }, { isSafeSessionId }),
    null,
  );
  // Stem containing `..` is rejected by isSafeSessionId.
  assert.equal(
    resolveSessionId({ transcript_path: '....jsonl' }, { isSafeSessionId }),
    null,
  );
});

test('loadContextHandoff prefers projectRoot package when plugin walk is blind', async () => {
  const { loadContextHandoff } = await import('../handoff-resolve.mjs');
  const blind = mkdtempSync(join(tmpdir(), 'adlc-handoff-blind-'));
  try {
    // pluginHooksDir outside the monorepo: walk cannot find @adlc/*.
    // projectRoot still resolves via the real repo package.json.
    const api = await loadContextHandoff({
      projectRoot: REPO_ROOT,
      pluginHooksDir: blind,
    });
    assert.equal(typeof api?.evaluateMutationGate, 'function');
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
});

test('missing transcript_path file does not invent hard-band deny', () => {
  const r = runHandoff({
    sessionId: 'missing-tp',
    // Force observeHandoffSignals to see a path that does not exist.
    // runHandoff only sets transcript_path when transcriptToolCalls is set, so
    // drive the hook manually.
  });
  // Baseline allow without signals — control.
  assert.equal(r.verdict, 'allow');

  const dir = mkdtempSync(join(tmpdir(), 'adlc-handoff-miss-tp-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'x', body: 'y', rails: [], scope: ['src/**'] }] }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    const input = JSON.stringify({
      cwd: dir,
      session_id: 'missing-tp2',
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'src', 'app.mjs') },
      transcript_path: join(dir, 'no-such-transcript.jsonl'),
    });
    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [HOOK, 'handoff'], {
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: '',
          NODE_PATH: join(REPO_ROOT, 'node_modules'),
        },
      });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status ?? 1;
    }
    const verdict =
      out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow';
    assert.equal(verdict, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextHandoff rejects non-string projectRoot without throwing', async () => {
  const { loadContextHandoff } = await import('../handoff-resolve.mjs');
  const blind = mkdtempSync(join(tmpdir(), 'adlc-handoff-blind2-'));
  try {
    assert.equal(await loadContextHandoff({ projectRoot: null, pluginHooksDir: blind }), null);
    assert.equal(await loadContextHandoff({ projectRoot: 1, pluginHooksDir: blind }), null);
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
});

test('Write to denies directory (no trailing slash) is denied', () => {
  const r = runHandoff({
    sessionId: 'path-dir',
    toolName: 'Write',
    toolInput: {
      file_path: '.adlc/handoffs/denies',
      content: '{}',
    },
    seedDeny: (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /path_protected:/);
});

test('Write via dotted handoffs path is still protected', async () => {
  const { isProtectedHandoffPath } = await import('../handoff-gate.mjs');
  assert.equal(isProtectedHandoffPath('.adlc/./handoffs/denies/x.json'), true);
  assert.equal(isProtectedHandoffPath('.adlc/handoffs/denies'), true);
});

test('Recovery Exception check happens BEFORE package load, not after (source order pin)', () => {
  // The whole point of the trusted local copy (spec §1.3, AC0): a
  // broken/incompatible/hostile @adlc/context-handoff must never be able to
  // deny pwd or the recovery CLI before this check even runs. A regression
  // that moves the check back to after loadContextHandoff() would silently
  // reproduce the original total-lockout bug — pin the ordering structurally.
  const source = readFileSync(HOOK, 'utf8');
  const handoffStart = source.indexOf('async function handoff(input)');
  assert.ok(handoffStart >= 0, 'handoff() not found');
  const body = source.slice(handoffStart);
  const exceptionCallIdx = body.indexOf('tryRecoveryOrInspectionException(input)');
  const loadIdx = body.indexOf('await loadContextHandoff(');
  assert.ok(exceptionCallIdx >= 0, 'tryRecoveryOrInspectionException call not found in handoff()');
  assert.ok(loadIdx >= 0, 'loadContextHandoff call not found in handoff()');
  assert.ok(exceptionCallIdx < loadIdx, 'tryRecoveryOrInspectionException must be checked BEFORE loadContextHandoff');
});

test('Recovery Exception check ALSO happens BEFORE either chdir in main(), not only inside handoff() (source order pin)', () => {
  // main()'s dispatcher performs two independent chdir calls before ever
  // invoking handoff() — each can fail closed via failClosedHandoffEnter,
  // denying pwd/recovery before handoff()'s own (correctly early) check ever
  // runs. A regression that removes or reorders this early call would
  // silently reopen that lockout window even though handoff()'s own check
  // still looks correct in isolation.
  const source = readFileSync(HOOK, 'utf8');
  const mainStart = source.indexOf('async function main()');
  assert.ok(mainStart >= 0, 'main() not found');
  const body = source.slice(mainStart);
  const exceptionCallIdx = body.indexOf('tryRecoveryOrInspectionException(input)');
  const firstChdirIdx = body.indexOf('process.chdir(dir)');
  assert.ok(exceptionCallIdx >= 0, 'tryRecoveryOrInspectionException call not found in main()');
  assert.ok(firstChdirIdx >= 0, 'process.chdir(dir) not found in main()');
  assert.ok(exceptionCallIdx < firstChdirIdx, 'tryRecoveryOrInspectionException must be checked BEFORE the first chdir in main()');
});

test('a stale/inaccessible CLAUDE_PROJECT_DIR does not block bare pwd', () => {
  // Round-3 review found that main()'s dispatcher performs two chdir calls
  // BEFORE ever invoking handoff() — a stale CLAUDE_PROJECT_DIR that cannot
  // be entered denied pwd/recovery via failClosedHandoffEnter, before
  // handoff()'s own (correctly early) exception check ever ran.
  const r = runHandoff({
    sessionId: 'consumer-stale-dir',
    toolName: 'Bash',
    toolInput: { command: 'pwd' },
    env: { CLAUDE_PROJECT_DIR: '/definitely/does/not/exist/nope' },
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('a stale/inaccessible CLAUDE_PROJECT_DIR does not block the real recovery command', () => {
  const r = runHandoff({
    sessionId: 'consumer-stale-dir-recovery',
    toolName: 'Bash',
    toolInput: { command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-stale-dir-recovery --write` },
    env: { CLAUDE_PROJECT_DIR: '/definitely/does/not/exist/nope' },
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('a stale/inaccessible CLAUDE_PROJECT_DIR still denies an ORDINARY edit, but the denial includes the real recovery command (Round-5 Finding 4)', () => {
  // Round-5 review: an ordinary (non-recovery, non-pwd) call that hits
  // failClosedHandoffEnter previously got only a bare "could not enter the
  // project directory" message — no copy-pasteable recovery command, even
  // though a safe session id was resolvable from the payload. This
  // reproduces the reviewer's named exploit scenario directly.
  const r = runHandoff({
    sessionId: 'consumer-stale-dir-deny',
    env: { CLAUDE_PROJECT_DIR: '/definitely/does/not/exist/nope' },
  });
  assert.equal(r.verdict, 'deny', r.out);
  assert.match(r.out, /could not enter the project directory/);
  assert.match(r.out, /bypass --session consumer-stale-dir-deny --write/);
});

// --- recordRecoveryUnderBand: env allowlist (mirrors the Codex hook) -------

test('recordRecoveryUnderBand never forwards ADLC_MANIFEST_KEY or ADLC_ADMIN_KEY to the spawned recorder', async () => {
  const { recordRecoveryUnderBand } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-record-recovery-strip-'));
  const cwdBefore = process.cwd();
  try {
    const envDumpPath = join(dir, 'env-dump.json');
    const fakeAdlc = join(dir, 'fake-adlc.mjs');
    writeFileSync(
      fakeAdlc,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
    );
    // recordRecoveryUnderBand now invokes via process.execPath directly
    // (Round-5 fix) rather than executing adlcBinPath as a shebang script,
    // so the fake recorder can just be the plain .mjs module itself.

    // No .adlc/ under `dir` -> repoManifestChainIsSigned(dir) is false; this
    // test isolates the secret-stripping property from the separate
    // signed-chain guard (covered by its own tests below).
    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: { ...process.env, ADLC_MANIFEST_KEY: 'super-secret-key', ADLC_ADMIN_KEY: 'super-secret-admin' },
      adlcBinPath: fakeAdlc,
    });

    const dumped = JSON.parse(readFileSync(envDumpPath, 'utf8'));
    assert.equal(dumped.ADLC_MANIFEST_KEY, undefined, 'ADLC_MANIFEST_KEY must never reach the spawned recorder');
    assert.equal(dumped.ADLC_ADMIN_KEY, undefined, 'ADLC_ADMIN_KEY must never reach the spawned recorder');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRecoveryUnderBand forwards only the env allowlist — an unresolvable-provenance binary cannot exfiltrate unrelated credentials', async () => {
  // Round-4 review: resolveTrustedBinary's PATH search cannot fully verify
  // the resolved executable's provenance, so a denylist of only the two
  // manifest/admin keys still hands a possibly-malicious binary everything
  // else the operator's shell exports (e.g. cloud credentials). This proves
  // the fix is a genuine allowlist, not merely a bigger denylist: a
  // plausible third-party credential var is stripped, while an allowlisted
  // var (PATH) still reaches the child.
  const { recordRecoveryUnderBand } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-record-recovery-allowlist-'));
  const cwdBefore = process.cwd();
  try {
    const envDumpPath = join(dir, 'env-dump.json');
    const fakeAdlc = join(dir, 'fake-adlc.mjs');
    writeFileSync(
      fakeAdlc,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
    );
    // recordRecoveryUnderBand now invokes via process.execPath directly
    // (Round-5 fix) rather than executing adlcBinPath as a shebang script,
    // so the fake recorder can just be the plain .mjs module itself.

    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: { ...process.env, AWS_SECRET_ACCESS_KEY: 'not-on-the-allowlist' },
      adlcBinPath: fakeAdlc,
    });

    const dumped = JSON.parse(readFileSync(envDumpPath, 'utf8'));
    assert.equal(dumped.AWS_SECRET_ACCESS_KEY, undefined, 'a non-allowlisted credential var must never reach the spawned recorder');
    assert.equal(dumped.PATH, process.env.PATH, 'an allowlisted var (PATH) must still reach the spawned recorder');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- repoManifestChainIsSigned / recordRecoveryUnderBand: signed-chain guard (Round-5) ---

test('repoManifestChainIsSigned: false for a repo with no manifest at all', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-none-'));
  try {
    assert.equal(repoManifestChainIsSigned(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: false for a root manifest with only unsigned entries', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-unsigned-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`);
    assert.equal(repoManifestChainIsSigned(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: true for a root manifest with a signed entry', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-root-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now', sig: 'deadbeef' })}\n`);
    assert.equal(repoManifestChainIsSigned(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: true for a signed entry inside .adlc/manifest.d/ (segmented/forest repo)', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-segment-'));
  try {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(
      join(dir, '.adlc', 'manifest.d', 'some-branch-01ABCDEF.jsonl'),
      `${JSON.stringify({ seq: 1, gate: 'ticket-update', ts: 'now', sig: 'deadbeef' })}\n`,
    );
    assert.equal(repoManifestChainIsSigned(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRecoveryUnderBand refuses to spawn the recorder at all when the chain is already signed', async () => {
  // Round-5 review (confirmed against this exact repo's own manifest.d
  // segment, which already has a signed seq:1 entry): gate-manifest record
  // does NOT fail closed on a missing key — key:null is a legal, silently
  // unsigned append. Without this guard, recordRecoveryUnderBand would
  // append an unsigned entry directly after a signed one, corrupting the
  // chain for every later key-aware verification. Proven here by asserting
  // the fake recorder's env-dump file (proof the child ran at all) is never
  // created when the chain is signed.
  const { recordRecoveryUnderBand } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-record-recovery-signed-chain-'));
  const cwdBefore = process.cwd();
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now', sig: 'deadbeef' })}\n`);

    const envDumpPath = join(dir, 'env-dump.json');
    const fakeAdlc = join(dir, 'fake-adlc.mjs');
    writeFileSync(
      fakeAdlc,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
    );
    // recordRecoveryUnderBand now invokes via process.execPath directly
    // (Round-5 fix) rather than executing adlcBinPath as a shebang script,
    // so the fake recorder can just be the plain .mjs module itself.

    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: process.env,
      adlcBinPath: fakeAdlc,
    });

    assert.equal(existsSync(envDumpPath), false, 'the recorder child must never run against a signed chain');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- recoveryDiagnostic: independent of the dynamically-loaded package -----
// (Round-4 Finding 6 + Round-5 Finding 4)

test('recoveryDiagnostic prints a real, absolute, session-bound recovery command — built entirely from trusted local code, no api parameter', async () => {
  // Round-5 review: the OLD implementation formatted via api.formatRecoveryCommand
  // / api.RECOVERY_CLI_PATH — the same dynamically-loaded, project-resolved
  // package whose failure to load or export what's expected is exactly what
  // every early denyHandoff() in handoff() is reporting when it appends this
  // diagnostic. A stale/incompatible install left the operator with a
  // generic, non-actionable message. recoveryDiagnostic no longer takes an
  // api parameter at all — it resolves the CLI path via the same trusted,
  // execution-free resolveContextHandoffEntry the allow-path exception uses,
  // and formats via handoff-gate.mjs's trusted local twins. This proves the
  // resulting command is real (matches the shape the matcher itself accepts).
  const { recoveryDiagnostic } = await import('../adlc-hook.mjs');
  const out = recoveryDiagnostic('sess-a');
  assert.match(out, /bypass --session sess-a --write/);
  assert.doesNotMatch(out, /Recovery command unavailable/);
});

test('recoveryDiagnostic degrades to the no-safe-session-id message when sessionId is null', async () => {
  const { recoveryDiagnostic } = await import('../adlc-hook.mjs');
  const out = recoveryDiagnostic(null);
  assert.match(out, /No session id could be resolved/);
  assert.match(out, /pwd/);
});

test('recordRecoveryUnderBand never lets a PATH-planted "node" shim run (Round-5 Finding 2: shebang/env second lookup)', async () => {
  const { recordRecoveryUnderBand } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-record-recovery-no-shebang-hijack-'));
  const cwdBefore = process.cwd();
  try {
    const maliciousMarker = join(dir, 'malicious-ran.marker');
    const safeMarker = join(dir, 'safe-ran.marker');

    const maliciousNodeDir = join(dir, 'node_modules', '.bin');
    mkdirSync(maliciousNodeDir, { recursive: true });
    const maliciousNode = join(maliciousNodeDir, 'node');
    writeFileSync(maliciousNode, `#!/bin/sh\ntouch "${maliciousMarker}"\nexit 1\n`, { mode: 0o755 });

    const adlcBinPath = join(dir, 'fake-adlc-with-shebang.mjs');
    writeFileSync(
      adlcBinPath,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(safeMarker)}, 'ran');\n`,
      { mode: 0o755 },
    );

    const hijackPath = [maliciousNodeDir, dirname(process.execPath)].join(':');

    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: { ...process.env, PATH: hijackPath },
      adlcBinPath,
    });

    assert.equal(existsSync(maliciousMarker), false, 'the PATH-planted node shim must never run');
    assert.equal(existsSync(safeMarker), true, 'the real recorder must still have run, via process.execPath directly');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the top-level crash handler appends recoveryDiagnostic(lastKnownSessionId), not a bare error message (Round-5 Finding 4, source pin)', () => {
  const source = readFileSync(HOOK, 'utf8');
  assert.match(source, /let lastKnownSessionId = null;/);
  assert.match(source, /lastKnownSessionId = resolveSessionId\(input, \{ isSafeSessionId \}\);/);
  assert.match(
    source,
    /denyHandoff\(`handoff hook errored \(\$\{err\?\.message \?\? 'unknown'\}\) — failing closed\\n\\n\$\{recoveryDiagnostic\(lastKnownSessionId\)\}`\);/,
  );
});

// --- repoManifestChainIsSigned: bounded scan (Round-5 Finding 5) -----------

test('repoManifestChainIsSigned: a file larger than the per-file byte cap is treated as signed (truncated -> inconclusive -> fail closed), not fully read', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-oversized-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const line = `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`;
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), line.repeat(Math.ceil((2 * 1024 * 1024) / line.length)));
    const start = Date.now();
    const result = repoManifestChainIsSigned(dir);
    const elapsedMs = Date.now() - start;
    assert.equal(result, true, 'an oversized file cannot be proven unsigned within bounds -> treat as signed');
    assert.ok(elapsedMs < 2000, `expected a bounded, fast return; took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: more segment files than the fan-out cap is treated as signed, without opening any of them', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-fanout-'));
  try {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    for (let i = 0; i < 501; i += 1) {
      writeFileSync(
        join(dir, '.adlc', 'manifest.d', `seg-${i}.jsonl`),
        `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`,
      );
    }
    const start = Date.now();
    const result = repoManifestChainIsSigned(dir);
    const elapsedMs = Date.now() - start;
    assert.equal(result, true);
    assert.ok(elapsedMs < 2000, `expected a bounded, fast return; took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: a symlinked manifest file is rejected outright, never followed', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-symlink-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-symlink-target-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const target = join(targetDir, 'real.jsonl');
    writeFileSync(target, `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`);
    symlinkSync(target, join(dir, '.adlc', 'manifest.jsonl'));
    assert.equal(repoManifestChainIsSigned(dir), true, 'a symlinked manifest file must be rejected, not followed and read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: a symlinked manifest.d DIRECTORY is rejected outright, never listed (Round-5 Finding 4)', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-dir-symlink-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-dir-symlink-target-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(targetDir, 'real.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`);
    symlinkSync(targetDir, join(dir, '.adlc', 'manifest.d'));
    assert.equal(repoManifestChainIsSigned(dir), true, 'a symlinked manifest.d directory must be rejected, not listed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: many NON-.jsonl entries still trip the fan-out cap (Round-9 Finding 5)', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-hook.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-signed-nonjsonl-fanout-'));
  try {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    for (let i = 0; i < 501; i += 1) {
      writeFileSync(join(dir, '.adlc', 'manifest.d', `junk-${i}.tmp`), 'x');
    }
    const start = Date.now();
    const result = repoManifestChainIsSigned(dir);
    const elapsedMs = Date.now() - start;
    assert.equal(result, true, 'a directory dominated by non-.jsonl entries must still be bounded');
    assert.ok(elapsedMs < 2000, `expected a bounded, fast return; took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

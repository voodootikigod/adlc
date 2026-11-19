import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAILS_HOOK = join(HOOKS_DIR, 'adlc-rails-guard.mjs');
const BUILD_GATE_HOOK = join(HOOKS_DIR, 'adlc-build-gate.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

test('Copilot rails-guard and build-gate resolve subdirectory payload.cwd inside nested linked worktrees', (t) => {
  const primary = tmp(t, 'copilot-wt-primary-');
  const outsideCwd = tmp(t, 'copilot-outside-cwd-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-COPILOT',
          title: 'Copilot WT',
          category: 'architecture',
          rails: ['packages/sub/frozen.mjs'],
        },
      ],
    })
  );
  mkdirSync(join(primary, 'packages', 'sub'), { recursive: true });
  writeFileSync(join(primary, 'packages', 'sub', 'frozen.mjs'), 'export const x = 1;\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-a');
  git(primary, 'worktree', 'add', '-b', 'lane-a', lane);
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-COPILOT' }));

  const subDir = join(lane, 'packages', 'sub');

  // Relative file_path from subdirectory payload.cwd inside nested worktree hits frozen rail
  const editRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      toolName: 'edit',
      toolArgs: JSON.stringify({ file_path: 'frozen.mjs' }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(editRes.status, 0);
  assert.match(editRes.stdout, /blocked rail edit/);

  // Shell tool run_terminal_cmd with Cwd targeting frozen rail is denied
  const shellRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm frozen.mjs', Cwd: subDir }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellRes.status, 0);
  assert.match(shellRes.stdout, /blocked rail edit/);

  // Outer payload.cwd must NOT conflict with a single inner Cwd on an allowed write
  const allowedSubdirShell = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm ok.mjs', Cwd: subDir }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(allowedSubdirShell.status, 0);
  assert.equal(allowedSubdirShell.stdout.trim(), '');

  // Conflicting shell workdirs fail closed
  const conflictRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm ok.mjs', Cwd: '.', dir_path: subDir }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(conflictRes.status, 0);
  assert.match(conflictRes.stdout, /conflicting working directories/);

  // Editing nested worktree frozen rail from outer primary payload.cwd blocks
  const crossWtRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: primary,
      toolName: 'edit',
      toolArgs: JSON.stringify({ file_path: '.worktrees/lane-a/packages/sub/frozen.mjs' }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(crossWtRes.status, 0);
  assert.match(crossWtRes.stdout, /blocked rail edit/);

  // Shell command without workdir targeting nested worktree frozen rail from outer primary payload.cwd blocks
  const shellCrossWtRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: primary,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm .worktrees/lane-a/packages/sub/frozen.mjs' }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellCrossWtRes.status, 0);
  assert.match(shellCrossWtRes.stdout, /blocked rail edit/);

  // Build-gate resolves enclosing worktree root when payload.cwd is a subdirectory and fails closed on corrupt store
  writeFileSync(join(lane, '.adlc', 'tickets.json'), '{not-json');
  const bgRes = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      toolName: 'edit',
    }),
    encoding: 'utf8',
  });
  assert.equal(bgRes.status, 0);
  assert.match(bgRes.stdout, /cannot read the ticket store/);
});

test('Copilot rails-guard and build-gate enforce foreign/sibling checkouts outside payload.cwd', (t) => {
  const outer = tmp(t, 'copilot-outer-repo-');
  const foreign = tmp(t, 'copilot-foreign-repo-');
  const outsideCwd = tmp(t, 'copilot-plain-outside-');

  git(outer, 'init', '-b', 'main');
  mkdirSync(join(outer, '.adlc'), { recursive: true });
  writeFileSync(
    join(outer, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [{ id: 'T-OUTER', title: 'Outer normal', scope: ['outer/**'], rails: ['outer/frozen.mjs'] }],
    })
  );
  writeFileSync(join(outer, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-OUTER' }));
  mkdirSync(join(outer, 'outer'), { recursive: true });
  writeFileSync(join(outer, 'outer', 'frozen.mjs'), 'export const o = 1;\n');
  git(outer, 'add', '-A');
  git(outer, 'commit', '-m', 'init outer');

  git(foreign, 'init', '-b', 'main');
  mkdirSync(join(foreign, '.adlc'), { recursive: true });
  writeFileSync(
    join(foreign, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-FOREIGN',
          title: 'Foreign high risk',
          category: 'architecture',
          scope: ['src/**'],
          rails: ['src/frozen.mjs'],
        },
      ],
    })
  );
  writeFileSync(join(foreign, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-FOREIGN' }));
  mkdirSync(join(foreign, 'src'), { recursive: true });
  writeFileSync(join(foreign, 'src', 'frozen.mjs'), 'export const f = 1;\n');
  const line = JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'edit' }] });
  const transcriptPath = join(foreign, 'oversized.jsonl');
  writeFileSync(transcriptPath, `${line}\n`.repeat(50));
  git(foreign, 'add', '-A');
  git(foreign, 'commit', '-m', 'init foreign');

  // 1. payload.cwd = outer + shell workdir = foreign targeting foreign's rail MUST deny (exit 0 + JSON reason)
  const foreignShellDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm src/frozen.mjs', Cwd: foreign }),
    }),
    encoding: 'utf8',
  });
  assert.equal(foreignShellDeny.status, 0);
  assert.match(foreignShellDeny.stdout, /blocked rail edit for T-FOREIGN/);

  // 2. payload.cwd = outsideCwd (non-ADLC) + shell workdir = foreign targeting foreign's rail MUST deny
  const outsideToForeignDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm src/frozen.mjs', Cwd: foreign }),
    }),
    encoding: 'utf8',
  });
  assert.equal(outsideToForeignDeny.status, 0);
  assert.match(outsideToForeignDeny.stdout, /blocked rail edit for T-FOREIGN/);

  // 3. Conflicting workdirs where the first points outside any ADLC repo and the second points to foreign MUST fail closed
  const splitConflictDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm src/ok.mjs', Cwd: outsideCwd, workdir: foreign }),
    }),
    encoding: 'utf8',
  });
  assert.equal(splitConflictDeny.status, 0);
  assert.match(splitConflictDeny.stdout, /conflicting working directories/);

  // 4. Non-rail write inside active foreign checkout is allowed, while relative shell write via plain outside workdir is denied
  const foreignNonRailAllow = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm src/ok.mjs', Cwd: foreign }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(foreignNonRailAllow.status, 0);
  assert.equal(foreignNonRailAllow.stdout.trim(), '');

  const plainEscapeDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'run_terminal_cmd',
      toolArgs: JSON.stringify({ command: 'rm escaped.mjs', Cwd: outsideCwd }),
    }),
    encoding: 'utf8',
  });
  assert.equal(plainEscapeDeny.status, 0);
  assert.match(plainEscapeDeny.stdout, /blocked rail edit for T-OUTER/);

  // 5. Build-gate: payload.cwd = outsideCwd (non-ADLC) + workdir = foreign (high-risk degraded) MUST deny
  const bgOutsideToForeign = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      toolName: 'run_terminal_cmd',
      transcriptPath,
      toolArgs: JSON.stringify({ command: 'rm src/ok.mjs', workdir: foreign }),
    }),
    encoding: 'utf8',
  });
  assert.equal(bgOutsideToForeign.status, 0);
  assert.match(bgOutsideToForeign.stdout, /high-risk/);

  // 6. Build-gate: payload.cwd = outer (normal risk) + paths / patch targeting foreign (high-risk degraded) MUST deny
  const bgLowToHighPaths = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'edit',
      transcriptPath,
      toolArgs: JSON.stringify({ paths: [join(foreign, 'src', 'ok.mjs')] }),
    }),
    encoding: 'utf8',
  });
  assert.equal(bgLowToHighPaths.status, 0);
  assert.match(bgLowToHighPaths.stdout, /high-risk/);

  const bgLowToHighPatch = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'apply_patch',
      transcriptPath,
      toolArgs: JSON.stringify({ patch: `*** Update File: ${join(foreign, 'src', 'ok.mjs')}\n@@\n` }),
    }),
    encoding: 'utf8',
  });
  assert.equal(bgLowToHighPatch.status, 0);
  assert.match(bgLowToHighPatch.stdout, /high-risk/);

  // 7. Build-gate: payload.cwd = foreign (high-risk degraded) + workdir = outsideCwd MUST STILL gate foreign
  const bgHighToOutside = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: foreign,
      toolName: 'run_terminal_cmd',
      transcriptPath,
      toolArgs: JSON.stringify({ command: 'rm x.mjs', workdir: outsideCwd }),
    }),
    encoding: 'utf8',
  });
  assert.equal(bgHighToOutside.status, 0);
  assert.match(bgHighToOutside.stdout, /high-risk/);

  // 8. Structured apply_patch with nested toolArgs.cwd targeting foreign checkout rail MUST deny even when ADLC_TICKET / ADLC_TICKET_STORE point at outer
  const structuredForeignCwdDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'apply_patch',
      toolArgs: JSON.stringify({
        cwd: foreign,
        input: '*** Update File: src/frozen.mjs\n@@\n',
      }),
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADLC_P4_ENFORCEMENT: '1',
      ADLC_TICKET: 'T-OUTER',
      ADLC_TICKET_STORE: join(outer, '.adlc', 'tickets.json'),
    },
  });
  assert.equal(structuredForeignCwdDeny.status, 0);
  assert.match(structuredForeignCwdDeny.stdout, /blocked rail edit for T-FOREIGN/);

  // 9. Structured apply_patch with conflicting toolArgs workdirs MUST fail closed
  const structuredConflictDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'apply_patch',
      toolArgs: JSON.stringify({
        cwd: outer,
        workdir: foreign,
        input: '*** Update File: src/ok.mjs\n@@\n',
      }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(structuredConflictDeny.status, 0);
  assert.match(structuredConflictDeny.stdout, /conflicting working directories/);

  // 10. Secondary build-gate ignores outer ADLC_TICKET_STORE=/tmp/outer.json when nested worktree owns a high-risk local store
  const extLowStore = join(outsideCwd, 'outer-low.json');
  writeFileSync(extLowStore, JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Low', scope: ['src/**'] }] }));
  const nestedBgLane = join(outer, '.worktrees', 'bg-lane');
  git(outer, 'worktree', 'add', '-b', 'bg-lane', nestedBgLane);
  writeFileSync(
    join(nestedBgLane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'High', category: 'architecture', scope: ['src/**'] }] })
  );
  writeFileSync(join(nestedBgLane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-SHARED' }));
  const bgNestedSanitized = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'edit',
      transcriptPath,
      toolArgs: JSON.stringify({ file_path: '.worktrees/bg-lane/src/app.mjs' }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_TICKET_STORE: extLowStore, ADLC_TICKET: 'T-SHARED' },
  });
  assert.equal(bgNestedSanitized.status, 0);
  assert.match(bgNestedSanitized.stdout, /high-risk/);

  // 11. Structured patchText string child inherits toolArgs.cwd
  const patchTextRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      toolName: 'apply_patch',
      toolArgs: JSON.stringify({
        cwd: foreign,
        patchText: '*** Update File: src/frozen.mjs\n@@\n+x\n',
      }),
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(patchTextRes.status, 0);
  assert.match(patchTextRes.stdout, /blocked rail edit for T-FOREIGN/);
});

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

test('Codex rails-guard and build-gate resolve payload.cwd subdirectories and nested linked worktrees when process.cwd() is outside', (t) => {
  const primary = tmp(t, 'codex-wt-primary-');
  const outsideCwd = tmp(t, 'codex-outside-cwd-');
  git(primary, 'init', '-b', 'main');
  mkdirSync(join(primary, '.adlc'), { recursive: true });
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-CODEX',
          title: 'Codex WT',
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
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-CODEX' }));

  const subDir = join(lane, 'packages', 'sub');

  // Structured edit from subdirectory payload.cwd inside nested worktree hits frozen rail (exit 2)
  const editRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      tool_name: 'edit',
      tool_input: { file_path: 'frozen.mjs' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(editRes.status, 2, editRes.stderr);
  assert.match(editRes.stderr, /blocked rail edit/);

  // Shell tool run_shell_command with dir_path targeting frozen rail is denied (exit 2)
  const shellRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      tool_name: 'run_shell_command',
      tool_input: { command: 'rm frozen.mjs', dir_path: subDir },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellRes.status, 2, shellRes.stderr);

  // Outer payload.cwd must NOT conflict with a single inner dir_path on an allowed write
  const allowedSubdirShell = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      tool_name: 'run_shell_command',
      tool_input: { command: 'rm ok.mjs', dir_path: subDir },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(allowedSubdirShell.status, 0, allowedSubdirShell.stderr);

  // Build-gate resolves high-risk ticket from subdirectory payload.cwd inside nested worktree and fails closed without transcript (exit 2)
  const bgRes = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      tool_name: 'edit',
    }),
    encoding: 'utf8',
  });
  assert.equal(bgRes.status, 2, bgRes.stderr);
  assert.match(bgRes.stderr, /high-risk/);

  // Envelope using { cwd, tool, args } must NOT double-join payload.cwd as shell workdir
  const toolEnvelopeRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: subDir,
      tool: 'bash',
      args: { cmd: 'rm frozen.mjs' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(toolEnvelopeRes.status, 2, toolEnvelopeRes.stderr);
  assert.match(toolEnvelopeRes.stderr, /blocked rail edit/);

  // Conflicting shell workdirs fail closed
  const conflictRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      tool_name: 'bash',
      tool_input: { command: 'rm ok.mjs', Cwd: '.', dir_path: subDir },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(conflictRes.status, 2, conflictRes.stderr);
  assert.match(conflictRes.stderr, /conflicting working directories/);

  // Editing a nested worktree's frozen rail from outer primary payload.cwd (even with no ticket active in primary) blocks
  const crossWtRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: primary,
      tool_name: 'edit',
      tool_input: { file_path: '.worktrees/lane-a/packages/sub/frozen.mjs' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(crossWtRes.status, 2, crossWtRes.stderr);
  assert.match(crossWtRes.stderr, /blocked rail edit/);

  // Shell command without workdir targeting a nested worktree's frozen rail from outer primary payload.cwd blocks
  const shellCrossWtRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: primary,
      tool_name: 'bash',
      tool_input: { command: 'rm .worktrees/lane-a/packages/sub/frozen.mjs' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(shellCrossWtRes.status, 2, shellCrossWtRes.stderr);
  assert.match(shellCrossWtRes.stderr, /blocked rail edit/);

  // multi_tool_use.parallel envelope with conflicting workdir keys in parameters fails closed
  const parallelConflictRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: lane,
      tool_name: 'multi_tool_use.parallel',
      tool_input: {
        tool_uses: [
          {
            recipient_name: 'functions.exec_command',
            parameters: { cmd: 'rm frozen.mjs', Cwd: '.', workdir: subDir },
          },
        ],
      },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(parallelConflictRes.status, 2, parallelConflictRes.stderr);
  assert.match(parallelConflictRes.stderr, /conflicting working directories/);
});

test('Codex rails-guard and build-gate enforce foreign/sibling checkouts outside payload.cwd', (t) => {
  const outer = tmp(t, 'codex-outer-repo-');
  const foreign = tmp(t, 'codex-foreign-repo-');
  const outsideCwd = tmp(t, 'codex-plain-outside-');

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
  git(foreign, 'add', '-A');
  git(foreign, 'commit', '-m', 'init foreign');

  // 1. payload.cwd = outer + shell workdir = foreign targeting foreign's rail MUST deny (T-FOREIGN)
  const foreignShellDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm src/frozen.mjs', workdir: foreign },
    }),
    encoding: 'utf8',
  });
  assert.equal(foreignShellDeny.status, 2, foreignShellDeny.stderr);
  assert.match(foreignShellDeny.stderr, /blocked rail edit for T-FOREIGN/);

  // 2. payload.cwd = outsideCwd (non-ADLC) + shell workdir = foreign targeting foreign's rail MUST deny
  const outsideToForeignDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm src/frozen.mjs', workdir: foreign },
    }),
    encoding: 'utf8',
  });
  assert.equal(outsideToForeignDeny.status, 2, outsideToForeignDeny.stderr);
  assert.match(outsideToForeignDeny.stderr, /blocked rail edit for T-FOREIGN/);

  // 3. Flat shell payload (no tool_input wrapper) with workdir = foreign still preserves workdir and denies
  const flatForeignDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'exec_command',
      cmd: 'rm src/frozen.mjs',
      workdir: foreign,
    }),
    encoding: 'utf8',
  });
  assert.equal(flatForeignDeny.status, 2, flatForeignDeny.stderr);
  assert.match(flatForeignDeny.stderr, /blocked rail edit for T-FOREIGN/);

  // 4. Conflicting workdirs where the first points outside any ADLC repo and the second points to foreign MUST fail closed
  const splitConflictDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm src/ok.mjs', Cwd: outsideCwd, workdir: foreign },
    }),
    encoding: 'utf8',
  });
  assert.equal(splitConflictDeny.status, 2, splitConflictDeny.stderr);
  assert.match(splitConflictDeny.stderr, /conflicting working directories/);

  // 5. Non-rail write inside active foreign checkout is allowed, while relative shell write via plain outside workdir is denied
  const foreignNonRailAllow = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm src/ok.mjs', workdir: foreign },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(foreignNonRailAllow.status, 0, foreignNonRailAllow.stderr);

  const plainEscapeDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm escaped.mjs', workdir: outsideCwd },
    }),
    encoding: 'utf8',
  });
  assert.equal(plainEscapeDeny.status, 2, plainEscapeDeny.stderr);
  assert.match(plainEscapeDeny.stderr, /blocked rail edit for T-OUTER/);

  // 6. Build-gate: payload.cwd = outsideCwd (non-ADLC) + workdir = foreign (high-risk) MUST fail closed
  const bgOutsideToForeign = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm src/ok.mjs', workdir: foreign },
    }),
    encoding: 'utf8',
  });
  assert.equal(bgOutsideToForeign.status, 2, bgOutsideToForeign.stderr);
  assert.match(bgOutsideToForeign.stderr, /high-risk/);

  // 7. Build-gate: payload.cwd = outer (normal risk) + paths / patch targeting foreign (high-risk) MUST fail closed
  const bgLowToHighPaths = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'edit',
      tool_input: { paths: [join(foreign, 'src', 'ok.mjs')] },
    }),
    encoding: 'utf8',
  });
  assert.equal(bgLowToHighPaths.status, 2, bgLowToHighPaths.stderr);
  assert.match(bgLowToHighPaths.stderr, /high-risk/);

  const bgLowToHighPatch = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'apply_patch',
      tool_input: { input: `*** Update File: ${join(foreign, 'src', 'ok.mjs')}\n@@\n` },
    }),
    encoding: 'utf8',
  });
  assert.equal(bgLowToHighPatch.status, 2, bgLowToHighPatch.stderr);
  assert.match(bgLowToHighPatch.stderr, /high-risk/);

  // 8. Build-gate: payload.cwd = foreign (high-risk) + workdir = outsideCwd MUST STILL gate foreign
  const bgHighToOutside = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: foreign,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm x.mjs', workdir: outsideCwd },
    }),
    encoding: 'utf8',
  });
  assert.equal(bgHighToOutside.status, 2, bgHighToOutside.stderr);
  assert.match(bgHighToOutside.stderr, /high-risk/);

  // 9. Bare inspection pwd remains unconditionally allowed even when targeting high-risk foreign workdir
  const bgPwdAllow = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      tool_name: 'exec_command',
      tool_input: { cmd: 'pwd', workdir: foreign },
    }),
    encoding: 'utf8',
  });
  assert.equal(bgPwdAllow.status, 0, bgPwdAllow.stderr);

  // 10. Structured apply_patch with nested tool_input.cwd targeting foreign checkout rail MUST deny even when ADLC_TICKET / ADLC_TICKET_STORE point at outer
  const structuredForeignCwdDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'apply_patch',
      tool_input: {
        cwd: foreign,
        input: '*** Update File: src/frozen.mjs\n@@\n',
      },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADLC_P4_ENFORCEMENT: '1',
      ADLC_TICKET: 'T-OUTER',
      ADLC_TICKET_STORE: join(outer, '.adlc', 'tickets.json'),
    },
  });
  assert.equal(structuredForeignCwdDeny.status, 2, structuredForeignCwdDeny.stderr);
  assert.match(structuredForeignCwdDeny.stderr, /blocked rail edit for T-FOREIGN/);

  // 11. Structured apply_patch with conflicting tool_input workdirs MUST fail closed
  const structuredConflictDeny = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'apply_patch',
      tool_input: {
        cwd: outer,
        workdir: foreign,
        input: '*** Update File: src/ok.mjs\n@@\n',
      },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(structuredConflictDeny.status, 2, structuredConflictDeny.stderr);
  assert.match(structuredConflictDeny.stderr, /conflicting working directories/);

  // 12. Secondary build-gate ignores outer ADLC_TICKET_STORE=/tmp/outer.json when nested worktree owns a high-risk local store
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
      tool_name: 'edit',
      tool_input: { file_path: '.worktrees/bg-lane/src/app.mjs' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_TICKET_STORE: extLowStore, ADLC_TICKET: 'T-SHARED' },
  });
  assert.equal(bgNestedSanitized.status, 2, bgNestedSanitized.stderr);
  assert.match(bgNestedSanitized.stderr, /high-risk/);

  // 13. Relative traversal ADLC_TICKET_STORE=../../.adlc/tickets.json MUST NOT escape nested worktree into outer low-risk store
  const bgRelativeTraversal = spawnHook([BUILD_GATE_HOOK], {
    cwd: outer,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'edit',
      tool_input: { file_path: '.worktrees/bg-lane/src/app.mjs' },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADLC_TICKET_STORE: '../../.adlc/tickets.json',
      ADLC_TICKET: 'T-OUTER',
    },
  });
  assert.equal(bgRelativeTraversal.status, 2, bgRelativeTraversal.stderr);
  assert.match(bgRelativeTraversal.stderr, /high-risk/);

  // 14. Direct launch FROM nested worktree (and subdirectory inside nested worktree) with ADLC_TICKET_STORE=../../.adlc/tickets.json MUST enforce lane's own frozen rails
  writeFileSync(
    join(outer, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Outer', rails: [] }] })
  );
  writeFileSync(
    join(nestedBgLane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'Lane', rails: ['src/frozen.mjs'] }] })
  );
  mkdirSync(join(nestedBgLane, 'packages', 'sub'), { recursive: true });
  for (const launchDir of [nestedBgLane, join(nestedBgLane, 'packages', 'sub')]) {
    for (const badOverride of ['../../.adlc/tickets.json', join(outer, '.adlc', 'tickets.json')]) {
      const directLaneRails = spawnHook([RAILS_HOOK], {
        cwd: launchDir,
        input: JSON.stringify({
          cwd: launchDir,
          tool_name: 'edit',
          tool_input: { file_path: join(nestedBgLane, 'src', 'frozen.mjs') },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ADLC_P4_ENFORCEMENT: '1',
          ADLC_TICKET: 'T-SHARED',
          ADLC_TICKET_STORE: badOverride,
        },
      });
      assert.equal(directLaneRails.status, 2, `expected deny for ${launchDir} / ${badOverride}: ${directLaneRails.stderr}`);
      assert.match(directLaneRails.stderr, /src\/frozen\.mjs/);
    }
  }

  // 15. Structured patchText string child inherits tool_input.cwd, and build-gate collectPatchHeaderPaths extracts "*** Move to: "
  writeFileSync(
    join(outer, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-OUTER', title: 'Outer', rails: ['src/outer-frozen.mjs'] }] })
  );
  const patchTextRes = spawnHook([RAILS_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outer,
      tool_name: 'apply_patch',
      tool_input: {
        cwd: foreign,
        patchText: '*** Update File: src/frozen.mjs\n@@\n+x\n',
      },
    }),
    encoding: 'utf8',
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(patchTextRes.status, 2, patchTextRes.stderr);
  assert.match(patchTextRes.stderr, /T-FOREIGN/);

  writeFileSync(
    join(nestedBgLane, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-SHARED', title: 'High', category: 'architecture', scope: ['src/**'] }] })
  );
  const bgMoveToRes = spawnHook([BUILD_GATE_HOOK], {
    cwd: outsideCwd,
    input: JSON.stringify({
      cwd: outsideCwd,
      tool_name: 'apply_patch',
      tool_input: {
        patch: `*** Update File: ${join(outsideCwd, 'src.mjs')}\n*** Move to: ${join(nestedBgLane, 'src', 'moved.mjs')}\n@@\n`,
      },
    }),
    encoding: 'utf8',
  });
  assert.equal(bgMoveToRes.status, 2, bgMoveToRes.stderr);
  assert.match(bgMoveToRes.stderr, /high-risk/);
});

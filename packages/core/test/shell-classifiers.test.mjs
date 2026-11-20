import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyShellCommand,
  shellHasOpaqueMutation,
  shellHasWriteOption,
  shellIsPositivelyReadOnly,
} from '../lib/shell.mjs';
import * as copilotShell from '../../../plugins/adlc-copilot/hooks/generated-shell.mjs';
import * as codexShell from '../../../plugins/adlc-codex/hooks/generated-shell.mjs';

test('shellHasOpaqueMutation flags subshells, dot-source, and inline interpreters while allowing ./script.sh', () => {
  // Subshells
  assert.equal(shellHasOpaqueMutation('bash -c "rm -rf foo"'), true);
  assert.equal(shellHasOpaqueMutation('sh -c "echo bar"'), true);
  assert.equal(shellHasOpaqueMutation('dash -c "something"'), true);
  assert.equal(shellHasOpaqueMutation('zsh -c "abc"'), true);
  assert.equal(shellHasOpaqueMutation('ksh -c "xyz"'), true);

  // Eval, exec, source
  assert.equal(shellHasOpaqueMutation('eval "dangerous"'), true);
  assert.equal(shellHasOpaqueMutation('exec python3 evil.py'), true);
  assert.equal(shellHasOpaqueMutation('source evil.sh'), true);
  assert.equal(shellHasOpaqueMutation('echo ok && source /tmp/run.sh'), true);

  // POSIX dot-source strictly anchored to command position
  assert.equal(shellHasOpaqueMutation('. ./script.sh'), true);
  assert.equal(shellHasOpaqueMutation('. /path/to/env'), true);
  assert.equal(shellHasOpaqueMutation('echo hi; . /path/to/env'), true);
  assert.equal(shellHasOpaqueMutation('( . bar )'), true);

  // Module and interpreter flags
  assert.equal(shellHasOpaqueMutation('node -r evil.js index.mjs'), true);
  assert.equal(shellHasOpaqueMutation('node --require ./evil.js index.mjs'), true);
  assert.equal(shellHasOpaqueMutation('node --import ./evil.js index.mjs'), true);
  assert.equal(shellHasOpaqueMutation('node --loader ./evil.js index.mjs'), true);
  assert.equal(shellHasOpaqueMutation('perl -e "unlink \'foo\'"'), true);
  assert.equal(shellHasOpaqueMutation('perl -i -ne "print" f'), true);
  assert.equal(shellHasOpaqueMutation('lua -e \'os.execute("rm foo")\''), true);
  assert.equal(shellHasOpaqueMutation('php -r \'unlink("foo");\''), true);
  assert.equal(shellHasOpaqueMutation('deno eval \'Deno.remove("foo")\''), true);
  assert.equal(shellHasOpaqueMutation('bun -e \'console.log(1)\''), true);

  // Inline interpreters without transparent write
  assert.equal(shellHasOpaqueMutation("node -e 'process.exit(1)'"), true);
  assert.equal(shellHasOpaqueMutation("node -p '1+1'"), true);
  assert.equal(shellHasOpaqueMutation("node --eval 'console.log(1)'"), true);
  assert.equal(shellHasOpaqueMutation("python3 -c 'import sys; sys.exit(0)'"), true);
  assert.equal(shellHasOpaqueMutation("ruby -e 'puts 1'"), true);

  // Single literal interpreter writes are path-transparent; compound or dynamic writes fail closed as opaque
  assert.equal(shellHasOpaqueMutation('python3 -c "open(\'test/a.test.mjs\', \'w\').write(\'x\')"'), false);
  assert.equal(shellHasOpaqueMutation('python3 -c \'open("test/a.test.mjs", "w").write("x")\''), false);
  assert.equal(shellHasOpaqueMutation('node -e "require(\'fs\').writeFileSync(\'test/a.test.mjs\', \'x\')"'), false);
  assert.equal(shellHasOpaqueMutation('node -e \'require("fs").writeFileSync("test/a.test.mjs", "x")\''), false);
  assert.equal(shellHasOpaqueMutation('ruby -e "File.write(\'test/a.test.mjs\', \'x\')"'), false);
  assert.equal(shellHasOpaqueMutation('ruby -e \'File.write("test/a.test.mjs", "x")\''), false);
  assert.deepEqual(
    classifyShellCommand('node -e "require(\'fs\').writeFileSync(\'package.json\', \'{}\')"').paths.includes('package.json'),
    true,
  );
  assert.deepEqual(
    copilotShell.classifyShellCommand('node -e "require(\'fs\').writeFileSync(\'package.json\', \'{}\')"'),
    classifyShellCommand('node -e "require(\'fs\').writeFileSync(\'package.json\', \'{}\')"'),
  );
  assert.equal(
    shellHasOpaqueMutation('node -e "require(\'fs\').writeFileSync(\'src/allowed.txt\',\'x\'),require(\'fs\').writeFileSync(require(\'path\').join(\'.adlc\',\'tickets\',\'T.json\'),\'evil\')"'),
    true,
  );
  assert.equal(
    shellHasOpaqueMutation('node -e "require(\'fs\').writeFileSync(\'src/a.txt\',\'x\');require(\'fs\').writeFileSync(\'package.json\',\'{}\')"'),
    true,
  );
  assert.equal(
    shellHasOpaqueMutation('python3 -c "open(\'src/a.txt\',\'w\').write(\'x\'); open(\'.adlc/tickets.json\',\'w\').write(\'y\')"'),
    true,
  );
  assert.equal(
    shellHasOpaqueMutation('ruby -e "File.write(\'src/a.txt\',\'x\'); File.write(File.join(\'.adlc\',\'tickets.json\'),\'y\')"'),
    true,
  );

  // Commands that must be allowed (return false)
  assert.equal(shellHasOpaqueMutation('./script.sh'), false);
  assert.equal(shellHasOpaqueMutation('../bin/x'), false);
  assert.equal(shellHasOpaqueMutation('find . -type f -delete'), false);
  assert.equal(shellHasOpaqueMutation('git status'), false);
  assert.equal(shellHasOpaqueMutation('cat foo.txt'), false);
});

test('shellHasWriteOption flags ripgrep --pre and --pre-glob', () => {
  assert.equal(shellHasWriteOption('rg --pre evil.sh pattern file'), true);
  assert.equal(shellHasWriteOption('rg --pre-glob "*.txt" pattern file'), true);
  assert.equal(shellHasWriteOption('rg "--pre=evil.sh" pattern file'), true);
  assert.equal(shellHasWriteOption('rg "--pre-glob=*.txt" pattern file'), true);

  assert.equal(shellHasWriteOption('tool --out-file out.txt'), true);
  assert.equal(shellHasWriteOption('tool --save state.json'), true);
  assert.equal(shellHasWriteOption('tool --write target.txt'), true);
  assert.equal(shellHasWriteOption('tool --in-place file.txt'), true);
  assert.equal(shellHasWriteOption('git diff --output=out.txt'), true);
  assert.equal(shellHasWriteOption('node --test --test-reporter-destination=out.txt'), true);

  assert.equal(shellHasWriteOption('rg pattern file'), false);
  assert.equal(shellHasWriteOption('git diff'), false);
  assert.equal(shellHasWriteOption('node --test'), false);
});

test('shellIsPositivelyReadOnly rejects GIT_EXTERNAL_DIFF and mutating/creating git branch forms while allowing read-only listing forms and node --test', () => {
  // GIT_EXTERNAL_DIFF and git --ext-diff / --textconv rejected
  assert.equal(shellIsPositivelyReadOnly('GIT_EXTERNAL_DIFF=evil git diff'), false);
  assert.equal(shellIsPositivelyReadOnly('git diff && GIT_EXTERNAL_DIFF=evil git log'), false);
  assert.equal(shellIsPositivelyReadOnly('GIT_EXTERNAL_DIFF=/bin/rm git status'), false);
  assert.equal(shellIsPositivelyReadOnly('git diff --ext-diff'), false);
  assert.equal(shellIsPositivelyReadOnly('git diff --ext-diff HEAD'), false);
  assert.equal(shellIsPositivelyReadOnly('git show "--ext-diff" HEAD'), false);
  assert.equal(shellIsPositivelyReadOnly('git log -p --textconv'), false);
  assert.equal(shellIsPositivelyReadOnly('git diff --textconv HEAD'), false);
  assert.equal(shellIsPositivelyReadOnly('git diff --no-ext-diff HEAD'), true);
  assert.equal(shellIsPositivelyReadOnly('git diff --no-textconv HEAD'), true);

  // Mutating / creating git branch rejected
  assert.equal(shellIsPositivelyReadOnly('git branch new-feature'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -d old-branch'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -D old-branch'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --delete old-branch'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -m old new'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -M old new'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --move old new'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -c old new'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -C old new'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --copy old new'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -f feature HEAD'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --force feature HEAD'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch -u origin/main'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --set-upstream-to origin/main'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --set-upstream-to=origin/main'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --unset-upstream'), false);
  assert.equal(shellIsPositivelyReadOnly('git branch --edit-description'), false);

  // Read-only listing git branch allowed
  assert.equal(shellIsPositivelyReadOnly('git branch'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch -a'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --all'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch -r'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --remotes'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch -v'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch -vv'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --verbose'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --show-current'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --color'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --no-color'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch -l "feature/*"'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --list "feature/*"'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --contains HEAD'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --no-contains HEAD'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --merged main'), true);
  assert.equal(shellIsPositivelyReadOnly('git branch --no-merged main'), true);

  // node --check and test-target-only node --test allowed; arbitrary scripts and loader/eval flags rejected across core and generated copies
  for (const checkFn of [
    shellIsPositivelyReadOnly,
    codexShell.shellIsPositivelyReadOnly,
    copilotShell.shellIsPositivelyReadOnly,
  ]) {
    assert.equal(checkFn('node --test'), true);
    assert.equal(checkFn('node --test test/a.test.mjs'), true);
    assert.equal(checkFn('node --test --test-name-pattern foo packages/runner/test/runner.test.mjs'), true);
    assert.equal(checkFn('node --test --test-name-pattern foo attacker.mjs'), false);
    assert.equal(checkFn('node --test --test-only test/a.test.mjs'), true);
    assert.equal(checkFn('node --test attacker.mjs'), false);
    assert.equal(checkFn('node --test test/a.test.mjs attacker.mjs'), false);
    assert.equal(checkFn('node --test src/script.mjs'), false);
    assert.equal(checkFn('node --test --import ./evil.mjs test/a.test.mjs'), false);
    assert.equal(checkFn('node --test test/a.test.mjs -r ./evil.cjs'), false);
    assert.equal(checkFn('node --test -e "process.exit(0)"'), false);
    assert.equal(checkFn('node attacker.mjs'), false);
    assert.equal(checkFn('python3 --test'), false);
    assert.equal(checkFn('node --check index.mjs'), true);
  }
});

test('active Codex rail hook rejects mixed visible + dynamic .adlc/tickets inline interpreter writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-rail-hook-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.adlc', 'tickets'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"t"}\n');
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 't', scope: ['src/**'], rails: ['package.json'], edges: [] }],
    }));
    const hook = resolve(fileURLToPath(import.meta.url), '../../../../plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const env = { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

    const mixedDynamic = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: 'node -e "require(\'fs\').writeFileSync(\'src/allowed.txt\',\'x\'),require(\'fs\').writeFileSync(require(\'path\').join(\'.adlc\',\'tickets\',\'T.json\'),\'evil\')"',
        },
      }),
      encoding: 'utf8',
    });
    assert.equal(mixedDynamic.status, 2, mixedDynamic.stderr);
    assert.match(mixedDynamic.stderr, /opaque command/);

    const rootRail = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: 'node -e "require(\'fs\').writeFileSync(\'package.json\', \'{}\')"',
        },
      }),
      encoding: 'utf8',
    });
    assert.equal(rootRail.status, 2, rootRail.stderr);
    assert.match(rootRail.stderr, /blocked rail edit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

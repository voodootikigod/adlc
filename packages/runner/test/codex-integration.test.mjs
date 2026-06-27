import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRevision, sha256 } from '@adlc/core';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);

describe('codex plugin smoke script', () => {
  it('validates marketplace, manifest, and skill sentinels offline', () => {
    const out = execFileSync(process.execPath, [join(repoRoot, 'scripts/codex-install-smoke.mjs'), repoRoot], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skills, 5);
  });

  it('fails if isolated install mutates real Codex plugin data', () => {
    const home = mkdtempSync(join(tmpdir(), 'adlc-real-home-'));
    try {
      mkdirSync(join(home, '.codex/plugins/data'), { recursive: true });
      const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/codex-install-smoke.mjs'), repoRoot], {
        env: { ...process.env, HOME: home, ADLC_CODEX_SMOKE_MUTATE_REAL_PLUGIN_DATA: '1' },
        encoding: 'utf8',
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /mutated the caller real HOME\/XDG Codex state/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('codex integration docs flow', () => {
  it('runs the documented P5 to P6 auto-revision commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-docs-flow-'));
    try {
      const g = (...args) => execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.co');
      g('config', 'user.name', 'tester');
      g('config', 'commit.gpgsign', 'false');
      writeFileSync(join(dir, 'src.txt'), 'base\n');
      g('add', '-A');
      g('commit', '-qm', 'base');

      mkdirSync(join(dir, '.adlc'), { recursive: true });
      writeFileSync(join(dir, '.adlc/tickets.json'), JSON.stringify({
        tickets: [{ id: 'T1', title: 'Docs flow ticket', scope: ['src/**'], rails: ['test/**'], edges: [] }],
      }));
      const transcriptPath = join(dir, '.adlc/p5-review.txt');
      const passes = JSON.parse(readFileSync(join(repoRoot, 'docs/examples/p5-passes.json'), 'utf8'));
      passes.provenance.transcript = '.adlc/p5-review.txt';
      const revision = resolveRevision({ cwd: dir, ignorePaths: [transcriptPath] });
      writeFileSync(transcriptPath, [
        'ticket: T1',
        `reviewed revision: ${revision}`,
        'security finding killed; correctness dry; tests dry; behavior dry',
        'review transcript fixture with enough detail to be accepted as evidence',
      ].join('\n'));
      const promptPath = join(dir, '.adlc/p5-prompt.txt');
      const inputsPath = join(dir, '.adlc/p5-inputs.txt');
      writeFileSync(promptPath, `review prompt for ${revision}\n`);
      writeFileSync(inputsPath, `reviewed input packet for ${revision}\n`);
      passes.review_packet = {
        prompt: '.adlc/p5-prompt.txt',
        prompt_hash: sha256(readFileSync(promptPath)),
        inputs: '.adlc/p5-inputs.txt',
        inputs_hash: sha256(readFileSync(inputsPath)),
        clean_worktree: revision,
      };
      writeFileSync(join(dir, '.adlc/p5-passes.json'), JSON.stringify(passes));

      const prosecute = join(repoRoot, 'packages/prosecute/bin/adlc-prosecute.mjs');
      const runner = join(repoRoot, 'packages/runner/bin/adlc.mjs');
      const common = { cwd: dir, encoding: 'utf8' };

      const p5Record = execFileSync(process.execPath, [
        prosecute,
        '--input',
        '.adlc/p5-passes.json',
        '--ticket',
        'T1',
        '--dir',
        '.adlc',
        '--json',
      ], common);
      assert.equal(JSON.parse(p5Record).exitCode, 0);

      const p5Run = execFileSync(process.execPath, [
        runner,
        'run',
        'p5',
        '--ticket',
        'T1',
        '--dir',
        '.adlc',
        '--json',
      ], common);
      assert.equal(JSON.parse(p5Run).ok, true);

      writeFileSync(join(dir, '.adlc/before.json'), '{"before":true}\n');
      writeFileSync(join(dir, '.adlc/after.json'), '{"after":true}\n');
      writeFileSync(join(dir, '.adlc/packet.json'), JSON.stringify({ behaviorDiff: 'accepted' }));
      const accepted = execFileSync(process.execPath, [
        runner,
        'accept',
        '--ticket',
        'T1',
        '--packet',
        '.adlc/packet.json',
        '--before',
        '.adlc/before.json',
        '--after',
        '.adlc/after.json',
        '--dir',
        '.adlc',
        '--json',
      ], common);
      assert.equal(JSON.parse(accepted).ok, true);

      const p6Run = execFileSync(process.execPath, [
        runner,
        'run',
        'p6',
        '--ticket',
        'T1',
        '--dir',
        '.adlc',
        '--json',
      ], common);
      assert.equal(JSON.parse(p6Run).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adlc rails hook', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-hook-'));
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc/tickets.json'), JSON.stringify({
      tickets: [
        { id: 'T1', title: 't', rails: ['test/**'], scope: ['src/**'], edges: [] },
      ],
    }));
    return dir;
  }

  it('is inactive unless ADLC_P4_ENFORCEMENT=1', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      input: JSON.stringify({ path: 'test/a.test.mjs' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /inactive/);
  });

  it('blocks rail edits when active', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ path: 'test/a.test.mjs' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks absolute rail paths after project-relative normalization', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ path: join(dir, 'test/a.test.mjs') }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks dot-prefixed rail paths after normalization', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ path: './test/./a.test.mjs' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('allows non-rail edits from Codex apply_patch hook payloads', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.mjs',
      '@@',
      '+export const value = 1;',
      '*** End Patch',
    ].join('\n');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'apply_patch',
        tool_input: { command: patch },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
  });

  it('blocks rail edits from Codex apply_patch hook payloads', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const patch = [
      '*** Begin Patch',
      '*** Update File: test/a.test.mjs',
      '@@',
      '+test("rail", () => {});',
      '*** End Patch',
    ].join('\n');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'apply_patch',
        tool_input: { command: patch },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks rail edits from fully-qualified Codex apply_patch hook payloads', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const patch = [
      '*** Begin Patch',
      '*** Update File: test/a.test.mjs',
      '@@',
      '+test("rail", () => {});',
      '*** End Patch',
    ].join('\n');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'functions.apply_patch',
        tool_input: { command: patch },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks edits to the ticket trust root while rails are active', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const patch = [
      '*** Begin Patch',
      '*** Update File: .adlc/tickets.json',
      '@@',
      '-{"tickets":[]}',
      '+{"tickets":[]}',
      '*** End Patch',
    ].join('\n');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'apply_patch',
        tool_input: { command: patch },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks nested edits from Codex multi_tool_use wrapper payloads', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const patch = [
      '*** Begin Patch',
      '*** Update File: test/a.test.mjs',
      '@@',
      '+test("rail", () => {});',
      '*** End Patch',
    ].join('\n');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'multi_tool_use.parallel',
        tool_uses: [
          {
            recipient_name: 'functions.apply_patch',
            parameters: { command: patch },
          },
        ],
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks nested shell writes from Codex multi_tool_use wrapper payloads', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'test'), { recursive: true });
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'multi_tool_use.parallel',
        tool_uses: [
          {
            recipient_name: 'functions.exec_command',
            parameters: {
              cmd: 'cat > a.test.mjs <<EOF\nchanged\nEOF',
              workdir: join(dir, 'test'),
            },
          },
        ],
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks shell-based writes to rail paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'cat > test/a.test.mjs <<EOF\nchanged\nEOF' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks shell writes relative to a Codex command workdir', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'test'), { recursive: true });
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'functions.exec_command',
        tool_input: {
          command: 'cat > a.test.mjs <<EOF\nchanged\nEOF',
          workdir: join(dir, 'test'),
        },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('fails closed on non-empty interactive shell stdin during active P4', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'functions.write_stdin',
        tool_input: { chars: 'cat > test/a.test.mjs <<EOF\nchanged\nEOF\n' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /interactive shell stdin/);
  });

  it('allows empty interactive shell stdin polling during active P4', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'functions.write_stdin',
        tool_input: { chars: '' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
  });

  it('blocks Python interpreter writes to rail paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'python3 -c "open(\'test/a.test.mjs\', \'w\').write(\'x\')"' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks Node interpreter writes to rail paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'node -e "require(\'fs\').writeFileSync(\'test/a.test.mjs\', \'x\')"' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks Ruby interpreter writes to rail paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ruby -e "File.write(\'test/a.test.mjs\', \'x\')"' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('fails closed on cwd-changing shell writes', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'cd test && cat > a.test.mjs <<EOF\nchanged\nEOF' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /changes cwd/);
  });

  it('fails closed on variable-expanded shell writes', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'p=test/a.test.mjs; cat > "$p" <<EOF\nchanged\nEOF' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /shell expansion/);
  });

  it('fails closed on variable-expanded tee writes', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'p=test/a.test.mjs; printf changed | tee "$p"' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /shell expansion/);
  });

  it('blocks dd key-value shell writes to rails', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'dd if=/dev/null of=test/a.test.mjs count=0' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks unlisted shell writers with literal rail targets', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    for (const command of [
      'truncate -s 0 test/a.test.mjs',
      'cp src/a.mjs test',
      'rsync src/a.mjs test/a.test.mjs',
      'awk -i inplace \'{ print }\' test/a.test.mjs',
    ]) {
      const result = spawnSync(process.execPath, [hook], {
        cwd: dir,
        env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /blocked rail edit/, command);
    }
  });

  it('fails closed on destructive find commands without literal file targets', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'find test -type f -delete' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('blocks project-root destructive shell targets because they overlap every rail', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    for (const command of [
      'find . -type f -delete',
      'find .. -type f -delete',
      'rm -rf .',
    ]) {
      const result = spawnSync(process.execPath, [hook], {
        cwd: dir,
        env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /blocked rail edit/, command);
    }
  });

  it('fails closed on opaque shell mutators even when they mention a patch file', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'functions.exec_command',
        tool_input: { command: 'git apply /tmp/rail.patch' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /opaque command/);
  });

  it('blocks sed write scripts to rail paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: "sed -n 'w test/a.test.mjs' src/a.mjs" },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked rail edit/);
  });

  it('fails closed on unknown pathless shell commands', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'make generated' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /known read-only command nor a path-transparent mutation/);
  });

  it('allows read-only shell commands with no editable paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
  });

  it('fails closed when allowlisted read-only shell commands use output options', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    for (const command of [
      'git diff --output=test/a.test.mjs',
      'node --test --test-reporter-destination=test/a.test.mjs',
    ]) {
      const result = spawnSync(process.execPath, [hook], {
        cwd: dir,
        env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /output option/, command);
    }
  });

  it('allows required P4 gate and test commands with no editable paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    for (const command of [
      'npm test',
      'node --test packages/runner/test/runner.test.mjs',
      'adlc hollow-test --test-cmd "npm test"',
      'adlc rails-guard --ticket T1 --record --json',
      'adlc flail-detector build.log --json',
      'adlc run p4 --ticket T1 --dir .adlc --json',
    ]) {
      const result = spawnSync(process.execPath, [hook], {
        cwd: dir,
        env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, command);
    }
  });

  it('fails closed on malformed active hook payloads', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: '{bad',
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /malformed hook payload JSON/);
  });

  it('fails closed when active payload contains no editable paths', () => {
    const dir = fixture();
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ tool: 'edit' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /did not include any editable paths/);
  });

  it('allows non-rail edits when active from current-ticket.json', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.adlc/current-ticket.json'), JSON.stringify({ id: 'T1' }));
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' },
      input: JSON.stringify({ path: 'src/a.mjs' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
  });

  it('fails closed on conflicting active ticket sources', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.adlc/current-ticket.json'), JSON.stringify({ id: 'T2' }));
    const hook = join(repoRoot, 'plugins/adlc-codex/hooks/adlc-rails-guard.mjs');
    const result = spawnSync(process.execPath, [hook], {
      cwd: dir,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ path: 'src/a.mjs' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /conflicts/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_AGENT_TEMPLATES, scaffold } from '../index.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/adlc-init.mjs');

function fixture(fn) {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-init-'));
  const root = join(parent, 'repo');
  try {
    return fn(root, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('fresh scaffold creates ADLC config, ignores, and current Codex agent files', () => {
  fixture((root) => {
    const result = scaffold({ root });
    assert.equal(result.root, realpathSync(root));
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json')));
    assert.equal(cfg.securityMode, 'unsigned-fallback');
    assert.equal(cfg.harnesses.codex.railEnforcement, 'auto');
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /!\.adlc\/specs\//);
    for (const name of Object.keys(CODEX_AGENT_TEMPLATES)) {
      const content = readFileSync(join(root, '.codex/agents', name), 'utf8');
      assert.match(content, /^name = "adlc-/);
      assert.match(content, /developer_instructions/);
    }
  });
});

test('scaffold is idempotent and preserves existing project-owned files', () => {
  fixture((root) => {
    scaffold({ root });
    writeFileSync(join(root, '.adlc/config.json'), '{"owned":true}\n');
    writeFileSync(join(root, '.codex/agents/adlc-reviewer.toml'), 'name = "team-reviewer"\n');
    const beforeIgnore = readFileSync(join(root, '.gitignore'), 'utf8');
    const result = scaffold({ root });
    assert.equal(readFileSync(join(root, '.adlc/config.json'), 'utf8'), '{"owned":true}\n');
    assert.equal(readFileSync(join(root, '.codex/agents/adlc-reviewer.toml'), 'utf8'), 'name = "team-reviewer"\n');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), beforeIgnore);
    assert.equal(result.updated.length, 0);
  });
});

test('CLI confines writes to --root and returns machine-readable results', () => {
  fixture((root, parent) => {
    const sentinel = join(parent, 'sentinel');
    writeFileSync(sentinel, 'unchanged');
    const result = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--json'], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(result.root, realpathSync(root));
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  });
});

test('scaffold refuses repository symlinks that would escape the supplied root', () => {
  fixture((root, parent) => {
    const outside = join(parent, 'outside');
    const target = join(outside, 'adlc');
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, '.adlc'), 'dir');
    assert.throws(() => scaffold({ root }), /refusing to follow symlink/);
    assert.equal(existsSync(join(target, 'specs')), false);
  });
});

for (const relativePath of ['.gitignore', '.adlc', '.codex']) {
  test(`scaffold refuses a dangling ${relativePath} symlink`, () => {
    fixture((root, parent) => {
      const outside = join(parent, `outside-${relativePath.replace('.', '')}`);
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, relativePath));
      assert.throws(() => scaffold({ root }), /refusing to follow symlink/);
      assert.equal(existsSync(outside), false);
    });
  });
}

test('scaffold repairs a whole-directory ADLC ignore so committed state can be re-included', () => {
  fixture((root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.adlc/\n');
    scaffold({ root, codexAgents: false });
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.doesNotMatch(ignore, /^\.adlc\/$/m);
    assert.match(ignore, /^\.adlc\/\*$/m);
    assert.match(ignore, /^!\.adlc\/config\.json$/m);
    assert.match(ignore, /^!\.adlc\/specs\/$/m);
  });
});

test('scaffold --harness cursor writes cursor harness config and skips Codex agents', () => {
  fixture((root) => {
    const result = scaffold({ root, harness: 'cursor' });
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.securityMode, 'unsigned-fallback');
    assert.equal(cfg.harnesses.cursor.railEnforcement, 'auto');
    assert.equal(cfg.harnesses.codex, undefined);
    assert.equal(cfg.acknowledgedNewRailBypass, undefined);
    assert.equal(existsSync(join(root, '.codex')), false);
    assert.ok(result.created.includes('.adlc/config.json'));
  });
});

test('CLI --harness cursor implies no Codex agents', () => {
  fixture((root) => {
    const result = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--harness', 'cursor', '--json'], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(root, '.codex')), false);
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.harnesses.cursor.railEnforcement, 'auto');
  });
});

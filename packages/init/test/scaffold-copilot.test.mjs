import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../lib/scaffold.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc-init.mjs');

function fresh(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-init-copilot-'));
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('scaffold --harness copilot records the copilot harness and skips Codex agents', () => {
  fresh((root) => {
    scaffold({ root, harness: 'copilot' });
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.harnesses.copilot.railEnforcement, 'auto');
    assert.equal(cfg.harnesses.codex, undefined);
    assert.equal(cfg.harnesses.cursor, undefined);
    assert.equal(existsSync(join(root, '.codex/agents')), false, 'no Codex agents for copilot');
  });
});

test('scaffold --harness copilot writes the .github instructions + setup-steps snippet', () => {
  fresh((root) => {
    const result = scaffold({ root, harness: 'copilot' });
    assert.ok(result.created.includes('.github/copilot-instructions.md'));
    assert.ok(result.created.includes('.github/workflows/copilot-setup-steps.yml'));
    const instr = readFileSync(join(root, '.github/copilot-instructions.md'), 'utf8');
    assert.match(instr, /copilot plugin install adlc-copilot@adlc/);
    assert.match(instr, /fails open/i, 'honest about the in-session hook posture');
    const steps = readFileSync(join(root, '.github/workflows/copilot-setup-steps.yml'), 'utf8');
    assert.match(steps, /npm i -g @adlc\/cli/);
  });
});

test('CLI --harness copilot is accepted and is idempotent', () => {
  fresh((root) => {
    execFileSync(process.execPath, [BIN, '--root', root, '--harness', 'copilot', '--json'], { encoding: 'utf8' });
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.harnesses.copilot.railEnforcement, 'auto');
    // Re-run: instructions already present → reported unchanged, not created again.
    const again = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--harness', 'copilot', '--json'], { encoding: 'utf8' }));
    assert.ok(again.unchanged.includes('.github/copilot-instructions.md'));
  });
});

test('CLI rejects an unknown harness', () => {
  fresh((root) => {
    assert.throws(
      () => execFileSync(process.execPath, [BIN, '--root', root, '--harness', 'bogus', '--json'], { encoding: 'utf8', stdio: 'pipe' }),
      /must be codex, cursor, or copilot/,
    );
  });
});

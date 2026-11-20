import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAcceptancePacket } from '../lib/acceptance.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNNER_BIN = join(REPO_ROOT, 'packages/runner/bin/adlc.mjs');

describe('T-P10: runner P6 packet hardening and CLI subcommands', () => {
  it('rejects symlinked acceptance packet and empty {} JSON packet', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-runner-p6-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const outside = mkdtempSync(join(tmpdir(), 'adlc-runner-out-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(dir, '.adlc', 'evidence'), { recursive: true });

    const target = join(outside, 'packet.json');
    writeFileSync(target, JSON.stringify({ summary: 'ok' }));
    const linkPacket = join(dir, '.adlc', 'evidence', 'link-packet.json');
    symlinkSync(target, linkPacket);

    const symlinkRes = recordAcceptancePacket({
      cwd: dir,
      dir: '.adlc',
      ticket: 'T1',
      packet: '.adlc/evidence/link-packet.json',
      revision: 'rev-1',
    });
    assert.equal(symlinkRes.ok, false);
    assert.ok(symlinkRes.errors.some((e) => /symlink/i.test(e)), `expected symlink error, got: ${symlinkRes.errors.join('; ')}`);

    const emptyObjPacket = join(dir, '.adlc', 'evidence', 'empty.json');
    writeFileSync(emptyObjPacket, '{}');
    const emptyRes = recordAcceptancePacket({
      cwd: dir,
      dir: '.adlc',
      ticket: 'T1',
      packet: '.adlc/evidence/empty.json',
      revision: 'rev-1',
    });
    assert.equal(emptyRes.ok, false);
    assert.ok(emptyRes.errors.some((e) => /empty/i.test(e)), `expected empty JSON error, got: ${emptyRes.errors.join('; ')}`);
  });

  it('supports --version, record --help, and upgrade --help', () => {
    const ver = spawnSync(process.execPath, [RUNNER_BIN, '--version'], { encoding: 'utf8' });
    assert.equal(ver.status, 0, ver.stderr);
    assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+/);

    const rec = spawnSync(process.execPath, [RUNNER_BIN, 'record', '--help'], { encoding: 'utf8' });
    assert.equal(rec.status, 0, rec.stderr);
    assert.match(rec.stdout, /record/i);

    const upg = spawnSync(process.execPath, [RUNNER_BIN, 'upgrade', '--help'], { encoding: 'utf8' });
    assert.equal(upg.status, 0, upg.stderr);
    assert.match(upg.stdout, /upgrade/i);
  });
});

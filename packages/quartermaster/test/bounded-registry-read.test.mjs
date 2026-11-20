import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REGISTRY_BYTES, readBoundedRegularRegistryFile, loadRegistry } from '../lib/load.mjs';

describe('T-P10: quartermaster bounded O_NOFOLLOW registry read', () => {
  it('rejects a symlinked registry file via O_NOFOLLOW', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-qm-sym-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const realReg = join(dir, 'real.json');
    const linkReg = join(dir, 'link.json');
    writeFileSync(realReg, JSON.stringify({ channels: {} }));
    symlinkSync(realReg, linkReg);

    assert.throws(() => readBoundedRegularRegistryFile(linkReg));
    assert.throws(
      () => loadRegistry({ env: { ADLC_QUARTERMASTER_REGISTRY: linkReg }, repoDir: join(dir, 'repo') }),
      /cannot read registry/,
    );
  });

  it('rejects a registry exceeding MAX_REGISTRY_BYTES', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-qm-big-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bigReg = join(dir, 'big.json');
    writeFileSync(bigReg, 'x'.repeat(1024));
    assert.throws(
      () => readBoundedRegularRegistryFile(bigReg, 512),
      /exceeds max size/,
    );
    assert.equal(typeof MAX_REGISTRY_BYTES, 'number');
    assert.ok(MAX_REGISTRY_BYTES > 0);
  });
});

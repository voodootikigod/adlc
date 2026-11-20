import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_API_HOSTS, assertSafeApiUrl } from '../lib/adapters/jev.mjs';
import { loadPack } from '../lib/pack.mjs';
import { appendRecord, recordPath } from '../lib/record.mjs';

describe('T-P10: decision-layer Jev host allowlist, pack realpath containment, and locked/redacted record append', () => {
  it('assertSafeApiUrl accepts allowlisted api.typesafe.ai and rejects non-allowlisted https hosts', () => {
    assert.ok(ALLOWED_API_HOSTS.includes('api.typesafe.ai'));
    assert.equal(assertSafeApiUrl('https://api.typesafe.ai/v1/systemone'), 'https://api.typesafe.ai/v1/systemone');
    assert.throws(
      () => assertSafeApiUrl('https://attacker.example.com/v1/systemone'),
      /not in the allowlist/,
    );
    assert.equal(
      assertSafeApiUrl('https://staging.typesafe.ai/v1/systemone', { allowedHosts: ['staging.typesafe.ai'] }),
      'https://staging.typesafe.ai/v1/systemone',
    );
  });

  it('loadPack refuses a project pack symlinked outside .adlc/decision-packs', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'adlc-dl-pack-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outside = mkdtempSync(join(tmpdir(), 'adlc-dl-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const packDir = join(root, '.adlc', 'decision-packs', 'custom-pack');
    mkdirSync(packDir, { recursive: true });
    const outsideFile = join(outside, 'pack.json');
    writeFileSync(outsideFile, JSON.stringify({ id: 'custom-pack' }));
    symlinkSync(outsideFile, join(packDir, 'pack.json'));

    assert.throws(
      () => loadPack('custom-pack', { projectRoot: root }),
      /resolves outside its pack directory/,
    );
  });

  it('appendRecord writes cleanly with lock cleanup and redacts raw mainRoot in RecordError messages', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'adlc-dl-rec-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    appendRecord(root, { schemaVersion: 1, ok: true });
    const content = readFileSync(recordPath(root), 'utf8').trim();
    assert.equal(JSON.parse(content).ok, true);

    // Plant a symlinked runs.jsonl to trigger RecordError and assert raw root path is redacted
    const badRoot = mkdtempSync(join(tmpdir(), 'adlc-dl-rec-bad-'));
    t.after(() => rmSync(badRoot, { recursive: true, force: true }));
    mkdirSync(join(badRoot, '.adlc', 'decisions'), { recursive: true });
    symlinkSync(join(root, 'target.txt'), recordPath(badRoot));
    assert.throws(
      () => appendRecord(badRoot, { schemaVersion: 1 }),
      (err) => {
        assert.equal(err.name, 'RecordError');
        assert.ok(!err.message.includes(badRoot), `RecordError must redact mainRoot, got: ${err.message}`);
        return true;
      },
    );
  });
});

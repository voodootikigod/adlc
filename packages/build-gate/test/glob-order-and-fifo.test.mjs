import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeRiskTier, deriveRiskSignals, MANIFEST_PATHS } from '../lib/risk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '../bin/build-gate.mjs');

describe('build-gate T-P18: symmetric touchesAny, manifest.d/**, and O_NOFOLLOW/FIFO transcript guard', () => {
  it('flags segmented .adlc/manifest.d/** paths and concrete ticket paths via symmetric touchesAny', () => {
    assert.ok(MANIFEST_PATHS.includes('.adlc/manifest.d/**'));

    const segManifest = deriveRiskSignals({ id: 'T1', scope: ['.adlc/manifest.d/feat-branch.jsonl'] });
    assert.ok(segManifest.includes('mutates-manifest'));

    const concreteTicket = deriveRiskSignals({ id: 'T2', scope: ['.adlc/tickets/t-123.json'] });
    assert.ok(concreteTicket.includes('touches-trust-root'));

    const wildcardManifest = deriveRiskSignals({ id: 'T3', scope: ['.adlc/**'] });
    assert.ok(wildcardManifest.includes('mutates-manifest'));
    assert.ok(wildcardManifest.includes('touches-trust-root'));

    const normal = computeRiskTier({ id: 'T4', scope: ['src/app.mjs'] });
    assert.equal(normal.tier, 'normal');
    assert.deepEqual(normal.signals, []);
  });

  it('refuses symlink and FIFO transcripts without hanging and reads regular transcripts via fd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-fifo-'));
    try {
      mkdirSync(join(dir, '.adlc'), { recursive: true });
      const ticketsFile = join(dir, '.adlc', 'tickets.json');
      writeFileSync(
        ticketsFile,
        JSON.stringify({
          tickets: [{ id: 'T1', title: 'high risk', body: 'test', risk: 'high', scope: ['src/**'], rails: [], edges: [] }],
        }),
      );

      // Regular file transcript with 1 tool_use passes
      const realTranscript = join(dir, 'transcript.jsonl');
      writeFileSync(realTranscript, JSON.stringify({ type: 'tool_use', name: 'Read', input: {} }) + '\n');
      const okRes = spawnSync(
        process.execPath,
        [BIN, 'T1', '--tickets', ticketsFile, '--transcript', realTranscript, '--json'],
        { cwd: dir, encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(okRes.status, 0, `stderr=${okRes.stderr} stdout=${okRes.stdout}`);

      if (process.platform !== 'win32') {
        // Symlink transcript refused via O_NOFOLLOW
        const linkPath = join(dir, 'link.jsonl');
        symlinkSync(realTranscript, linkPath);
        const linkRes = spawnSync(
          process.execPath,
          [BIN, 'T1', '--tickets', ticketsFile, '--transcript', linkPath],
          { cwd: dir, encoding: 'utf8', timeout: 10_000 },
        );
        assert.equal(linkRes.status, 1);
        assert.match(linkRes.stderr, /could not read transcript/);

        // FIFO transcript refused immediately via O_NONBLOCK + !stat.isFile()
        const fifoPath = join(dir, 'pipe.jsonl');
        const mk = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
        if (mk.status === 0) {
          const fifoRes = spawnSync(
            process.execPath,
            [BIN, 'T1', '--tickets', ticketsFile, '--transcript', fifoPath],
            { cwd: dir, encoding: 'utf8', timeout: 5_000 },
          );
          assert.equal(fifoRes.status, 1);
          assert.match(fifoRes.stderr, /regular file/);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

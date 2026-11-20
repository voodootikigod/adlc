import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callTool, callToolAsync, scrubbedChildEnv } from '../lib/mcp-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, '..', 'lib', 'mcp-server.mjs');

test('mcp-server scrubs ADLC_MANIFEST_KEY from child env and rejects --lint-command, --typecheck-command, and --test-command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-env-scrub-'));
  const prevBin = process.env.ADLC_CLI_BIN;
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  try {
    // Module load deletes the ambient key.
    const loaded = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(MCP_SERVER)}); console.log(JSON.stringify(process.env.ADLC_MANIFEST_KEY ?? null));`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, ADLC_MANIFEST_KEY: 'ambient-secret' } },
    );
    assert.equal(JSON.parse(loaded.trim()), null);

    // Helper returns a shallow copy without the key.
    const source = { ADLC_MANIFEST_KEY: 'k', KEEP: 'v' };
    const scrubbed = scrubbedChildEnv(source);
    assert.deepEqual(scrubbed, { KEEP: 'v' });
    assert.equal(source.ADLC_MANIFEST_KEY, 'k');

    // Child processes never see the key, sync or async.
    const fake = join(dir, 'fake-cli.mjs');
    writeFileSync(fake, 'console.log(JSON.stringify({ key: process.env.ADLC_MANIFEST_KEY ?? null }));\n');
    process.env.ADLC_CLI_BIN = fake;
    process.env.ADLC_MANIFEST_KEY = 'ambient-secret';
    const syncResult = callTool('adlc_gate', { gate: 'spec-lint' });
    assert.equal(syncResult.isError, false);
    assert.equal(JSON.parse(JSON.parse(syncResult.content[0].text).stdout).key, null);
    const asyncResult = await callToolAsync('adlc_gate', { gate: 'spec-lint' });
    assert.equal(asyncResult.isError, false);
    assert.equal(JSON.parse(JSON.parse(asyncResult.content[0].text).stdout).key, null);

    // Nested-command flags are rejected, in both forms.
    for (const flag of ['--lint-command', '--typecheck-command', '--test-command']) {
      for (const arg of [flag, `${flag}=echo`]) {
        const args = [arg];
        assert.throws(
          () => callTool('adlc_gate', { gate: 'spec-lint', args }),
          (err) => err.code === -32602 && err.message.includes(flag),
        );
        await assert.rejects(
          () => callToolAsync('adlc_gate', { gate: 'spec-lint', args }),
          (err) => err.code === -32602 && err.message.includes(flag),
        );
      }
    }
  } finally {
    if (prevBin === undefined) delete process.env.ADLC_CLI_BIN;
    else process.env.ADLC_CLI_BIN = prevBin;
    if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = prevKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

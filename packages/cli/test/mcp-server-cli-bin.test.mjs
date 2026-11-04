import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCliBin, callTool } from '../lib/mcp-server.mjs';
import { renderHelp } from '../lib/help.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = join(HERE, '..', 'bin', 'adlc.mjs');

test('#592: resolveCliBin returns default CLI_BIN when ADLC_CLI_BIN is unset or empty', () => {
  assert.equal(resolveCliBin(undefined), DEFAULT_BIN);
  assert.equal(resolveCliBin(''), DEFAULT_BIN);
});

test('#592: resolveCliBin accepts an absolute path to an existing regular file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cli-bin-'));
  try {
    const fake = join(dir, 'fake-adlc.mjs');
    writeFileSync(fake, 'console.log("ok");\n');
    assert.equal(resolveCliBin(fake), fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#592: resolveCliBin rejects relative paths, missing files, directories, and control chars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cli-bin-bad-'));
  try {
    assert.throws(() => resolveCliBin('relative/adlc.mjs'), /ADLC_CLI_BIN must be an absolute path/);
    assert.throws(() => resolveCliBin('./adlc.mjs'), /ADLC_CLI_BIN must be an absolute path/);
    assert.throws(() => resolveCliBin(join(dir, 'does-not-exist.mjs')), /ADLC_CLI_BIN must point to an existing regular file/);
    assert.throws(() => resolveCliBin(dir), /ADLC_CLI_BIN must point to an existing regular file/);
    assert.throws(() => resolveCliBin('/tmp/bad\nadlc.mjs'), /ADLC_CLI_BIN contains a control character/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#592: callTool rejects an invalid ADLC_CLI_BIN from process.env before spawning', () => {
  const prev = process.env.ADLC_CLI_BIN;
  try {
    process.env.ADLC_CLI_BIN = 'relative/evil.mjs';
    assert.throws(
      () => callTool('adlc_gate', { gate: 'spec-lint', args: ['--help'] }),
      (err) => err.code === -32602 && /ADLC_CLI_BIN must be an absolute path/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.ADLC_CLI_BIN;
    else process.env.ADLC_CLI_BIN = prev;
  }
});

test('#592 & #875: renderHelp documents ADLC_CLI_BIN and pinned adversarial-review version range', () => {
  const help = renderHelp('1.0.0');
  assert.match(help, /ADLC_CLI_BIN/);
  assert.match(help, /adversarial-review@\^2\.6\.0/);
});

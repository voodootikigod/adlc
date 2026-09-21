import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../index.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/adlc-init.mjs');

test('CLI fails with exit code 1 and warns when .adlc/config.json is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-unparseable-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc/config.json'), '');
    const proc = spawnSync(process.execPath, [BIN, '--root', dir, '--json'], { encoding: 'utf8' });
    assert.equal(proc.status, 1);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(
      parsed.warnings.some((w) => w.includes('.adlc/config.json exists but is not readable JSON:')),
      `expected readable JSON warning in ${JSON.stringify(parsed.warnings)}`,
    );
    assert.equal(readFileSync(join(dir, '.adlc/config.json'), 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails with exit code 1 and warns when .adlc/config.json is malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-unparseable-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const malformed = '{ not valid json ';
    writeFileSync(join(dir, '.adlc/config.json'), malformed);
    const proc = spawnSync(process.execPath, [BIN, '--root', dir], { encoding: 'utf8' });
    assert.equal(proc.status, 1);
    const output = `${proc.stdout}\n${proc.stderr}`;
    assert.match(output, /warning: \.adlc\/config\.json exists but is not readable JSON:/);
    assert.equal(readFileSync(join(dir, '.adlc/config.json'), 'utf8'), malformed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails with exit code 1 and warns when .adlc/config.json is JSON but not an object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-unparseable-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc/config.json'), '[1, 2, 3]\n');
    const proc = spawnSync(process.execPath, [BIN, '--root', dir, '--json'], { encoding: 'utf8' });
    assert.equal(proc.status, 1);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(
      parsed.warnings.some((w) => w.includes('.adlc/config.json exists but is not readable JSON:')),
      `expected readable JSON warning in ${JSON.stringify(parsed.warnings)}`,
    );
    assert.equal(readFileSync(join(dir, '.adlc/config.json'), 'utf8'), '[1, 2, 3]\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold() records warning and leaves config.json untouched when unparseable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-unparseable-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc/config.json'), '{"invalid": syntax error}');
    const result = scaffold({ root: dir });
    assert.ok(
      result.warnings.some((w) => w.includes('.adlc/config.json exists but is not readable JSON:')),
      `expected readable JSON warning in ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.unchanged.includes('.adlc/config.json'));
    assert.ok(!result.created.includes('.adlc/config.json'));
    assert.ok(!result.updated.includes('.adlc/config.json'));
    assert.equal(readFileSync(join(dir, '.adlc/config.json'), 'utf8'), '{"invalid": syntax error}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 0 and records config.json as unchanged when config.json is valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-unparseable-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const valid = JSON.stringify({ version: 1, customField: 'preserved' }, null, 2) + '\n';
    writeFileSync(join(dir, '.adlc/config.json'), valid);
    const proc = spawnSync(process.execPath, [BIN, '--root', dir, '--json'], { encoding: 'utf8' });
    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.unchanged.includes('.adlc/config.json'));
    assert.ok(!parsed.warnings.some((w) => w.includes('.adlc/config.json exists but is not readable JSON:')));
    assert.equal(readFileSync(join(dir, '.adlc/config.json'), 'utf8'), valid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

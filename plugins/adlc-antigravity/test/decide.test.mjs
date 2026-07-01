import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../hooks/adlc-rails-guard.mjs';

const ENF = { ADLC_P4_ENFORCEMENT: '1' };

function adlcRepo({ rails = [], id = 'T1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-dec-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id, title: 't', body: 'b', scope: ['src/**'], rails }] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}
const call = (name, args, env = ENF, extra = {}) => decide({ toolCall: { name, args }, ...extra }, { env });

test('G1: non-file tool (search_web) allowed under enforcement', () => {
  assert.equal(call('search_web', { query: 'x' }).allow_tool, true);
});
test('read-only tool (view_file) allowed under enforcement', () => {
  assert.equal(call('view_file', { AbsolutePath: '/anything/a.js' }).allow_tool, true);
});
test('shell tool (run_command) allowed in-session', () => {
  assert.equal(call('run_command', { CommandLine: 'echo hi > /x' }).allow_tool, true);
});
test('G2: write with ABSOLUTE path in non-ADLC repo allowed under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-noadlc-'));
  assert.equal(call('write_to_file', { TargetFile: join(root, 'a.js') }).allow_tool, true);
});
test('rail hit: mutating write to a frozen rail denied', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  const v = call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') });
  assert.equal(v.allow_tool, false);
  assert.match(v.deny_reason, /frozen rail/i);
});
test('non-rail write in ADLC repo allowed', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src', 'ok.js') }).allow_tool, true);
});
test('H1/H3: relative path + empty workspacePaths (headless) denied under enforcement', () => {
  const v = call('write_to_file', { TargetFile: 'src/frozen.js' }, ENF, { workspacePaths: [] });
  assert.equal(v.allow_tool, false);
});
test('H2: name-mutating tool with unknown path key (no path) denied under enforcement', () => {
  const v = call('write_to_file', { DirectoryPath: '/repo/src' }); // key not in PATH_KEYS
  assert.equal(v.allow_tool, false);
});
test('enforcement OFF is a no-op allow even on a rail', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') }, {}).allow_tool, true);
});

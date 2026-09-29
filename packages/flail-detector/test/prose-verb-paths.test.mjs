// A verb only introduces a path at the start of a log line, optionally after
// timestamp or bracketed level prefixes and indentation. Mid-sentence prose —
// including Claude Code's own "File created successfully at: <path>" tool
// result — must not be read as a write target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { extractPath } from '../lib/signals.mjs';

const CLI = fileURLToPath(new URL('../bin/flail-detector.mjs', import.meta.url));

test('extractPath ignores verbs that appear mid-sentence', () => {
  for (const line of [
    'File created successfully at: /repo/src/f1.mjs',
    'I am now editing the parser to fix the bug',
    '// This helper was created for issue #12',
    'The file is Writing lib/x.mjs',
    'Info Writing src/a.js',
  ]) {
    assert.equal(extractPath(line), null, line);
  }
});

test('extractPath does not cross a newline to find a verb', () => {
  assert.equal(extractPath('some file body\nCreated lib/x.mjs'), null);
});

test('extractPath still reads timestamp, level and indentation prefixes', () => {
  assert.equal(extractPath('[INFO] [2026-09-21] Writing src/a.js'), 'src/a.js');
  assert.equal(extractPath('INFO: Writing src/a.js'), 'src/a.js');
  assert.equal(extractPath('WARN 12:00:01 EDITING src/c.js'), 'src/c.js');
  assert.equal(extractPath('2026-09-21 12:00:00,123 Editing src/b.js'), 'src/b.js');
  assert.equal(extractPath('\t12:03:01 Created /etc/passwd'), '/etc/passwd');
});

test('a transcript of three healthy Write calls is not flagged', (t) => {
  const dir = tmp(t, 'flail-prose-');
  const events = [];
  for (const n of [1, 2, 3]) {
    const path = `/repo/src/f${n}.mjs`;
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path, content: `export const v${n} = ${n};\n` } }] } });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', content: `File created successfully at: ${path}` }] } });
  }
  const log = join(dir, 'transcript.jsonl');
  writeFileSync(log, events.map((e) => JSON.stringify(e)).join('\n'));
  const result = spawnSync(process.execPath, [CLI, log, '--scope', '/repo/src/**', '--json'], { cwd: dir, encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.signals, [], result.stdout);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

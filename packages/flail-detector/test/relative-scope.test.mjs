import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseLog } from '../lib/parse-log.mjs';
import { normalizeScopePath, detectScopeViolations, detectEditChurn } from '../lib/signals.mjs';
import { analyze } from '../lib/analyze.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '../bin/flail-detector.mjs');

describe('flail-detector T-P18: tool-name classification, JSON arrays, and repo-relative scope paths', () => {
  it('excludes read-only tools (Read/Grep/Glob/LS) from synthetic Writing lines while keeping Write/Edit', () => {
    const jsonl = [
      JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: 'outside/secret.mjs' } }),
      JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: 'outside/secret.mjs' } }),
      JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: 'outside/secret.mjs' } }),
      JSON.stringify({ type: 'tool_use', tool_name: 'grep_search', input: { file_path: 'outside/grep.mjs' } }),
      JSON.stringify({ type: 'tool_use', tool: 'Glob', input: { file_path: 'outside/glob.mjs' } }),
      JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file_path: 'src/in-scope.mjs' } }),
    ].join('\n');

    const { lines } = parseLog(jsonl);
    assert.ok(!lines.some((l) => l.includes('outside/secret.mjs')));
    assert.ok(!lines.some((l) => l.includes('outside/grep.mjs')));
    assert.ok(!lines.some((l) => l.includes('outside/glob.mjs')));
    assert.ok(lines.includes('Writing src/in-scope.mjs'));
    assert.deepEqual(detectEditChurn(lines), []);
    assert.deepEqual(detectScopeViolations(lines, ['src/**']), []);
  });

  it('splits top-level JSON array transcripts into individual events', () => {
    const jsonArray = JSON.stringify([
      { type: 'tool_use', name: 'Write', input: { file_path: 'src/a.mjs' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'other/ignored.mjs' } },
      { message: 'TypeError: boom' },
      'plain string event',
    ], null, 2);

    const { lines } = parseLog(jsonArray);
    assert.ok(lines.includes('Writing src/a.mjs'));
    assert.ok(!lines.some((l) => l.includes('other/ignored.mjs')));
    assert.ok(lines.includes('TypeError: boom'));
    assert.ok(lines.includes('plain string event'));
  });

  it('normalizes absolute paths inside cwd to repo-relative POSIX paths for scope and churn checks', () => {
    const cwd = '/workspace/my-repo';
    assert.equal(normalizeScopePath('/workspace/my-repo/src/auth.mjs', cwd), 'src/auth.mjs');
    assert.equal(normalizeScopePath('./src/auth.mjs', cwd), 'src/auth.mjs');
    assert.equal(normalizeScopePath('/other/repo/file.mjs', cwd), '/other/repo/file.mjs');

    const lines = [
      'Writing /workspace/my-repo/src/auth.mjs',
      'Editing ./src/auth.mjs',
      'Writing src/auth.mjs',
    ];
    assert.deepEqual(detectScopeViolations(lines, ['src/**'], { cwd }), []);
    const churn = detectEditChurn(lines, { cwd });
    assert.deepEqual(churn, [{ path: 'src/auth.mjs', count: 3 }]);

    const res = analyze({ lines, bytes: 100, scopes: ['src/**'], maxRepeat: 2, maxBytes: null, cwd });
    assert.equal(res.verdict, 'flail');
    assert.ok(res.signals.some((s) => s.type === 'edit-churn'));
    assert.ok(!res.signals.some((s) => s.type === 'scope-violation'));
  });

  it('CLI normalizes absolute paths relative to cwd and passes clean on in-scope edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flail-rel-'));
    try {
      const logPath = join(dir, 'session.jsonl');
      writeFileSync(
        logPath,
        [
          JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'other/readme.md') } }),
          JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'src/ok.mjs') } }),
        ].join('\n') + '\n',
      );
      const res = spawnSync(process.execPath, [BIN, logPath, '--scope', 'src/**', '--json'], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `stderr=${res.stderr} stdout=${res.stdout}`);
      const out = JSON.parse(res.stdout);
      assert.equal(out.verdict, 'clean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

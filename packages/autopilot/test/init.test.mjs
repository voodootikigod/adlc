import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureExcludeEntries } from '../lib/init.mjs';
import { EXCLUDE_ENTRIES } from '../lib/paths.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-init-'));

export function ac9_ensureExcludeEntriesIdempotent() {
  const root = scratch();
  try {
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    // Nothing exists yet: dry-run reports what WOULD be added, writes nothing.
    const dry = ensureExcludeEntries(root, { write: false });
    assert.deepEqual(dry.added, EXCLUDE_ENTRIES);
    assert.ok(!existsSync(join(gitDir, 'info', 'exclude')));
    // Write: the file is created with exactly the entries.
    const first = ensureExcludeEntries(root, { write: true });
    assert.deepEqual(first.added, EXCLUDE_ENTRIES);
    const path = join(gitDir, 'info', 'exclude');
    const text1 = readFileSync(path, 'utf8');
    for (const e of EXCLUDE_ENTRIES) assert.ok(text1.includes(e));
    // A SECOND run over EXISTING content: this is what the ternary-swap mutant breaks — it
    // would read '' instead of the real content, reporting every entry as missing and
    // duplicating them on write (2026-08-31: ensureExcludeEntries had zero test coverage).
    const second = ensureExcludeEntries(root, { write: true });
    assert.deepEqual(second.added, [], 'nothing missing the second time — the existing content was actually read');
    assert.deepEqual(second.present, EXCLUDE_ENTRIES);
    const text2 = readFileSync(path, 'utf8');
    assert.equal(text2, text1, 'idempotent: re-running never duplicates entries');
    // A file that pre-exists with UNRELATED content (never touched by this tool before): the
    // real content must be preserved, not discarded.
    const root2 = scratch();
    const gitDir2 = join(root2, '.git', 'info');
    mkdirSync(gitDir2, { recursive: true });
    writeFileSync(join(gitDir2, 'exclude'), 'my-own-entry\n');
    const third = ensureExcludeEntries(root2, { write: true });
    assert.deepEqual(third.added, EXCLUDE_ENTRIES);
    const text3 = readFileSync(join(gitDir2, 'exclude'), 'utf8');
    assert.ok(text3.startsWith('my-own-entry'), 'pre-existing unrelated content survives (never replaced with empty string)');
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC9: init writes/re-runs the .git/info/exclude entries idempotently, preserving any pre-existing content', ac9_ensureExcludeEntriesIdempotent);

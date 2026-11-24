import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { walkSourceFiles } from '../lib/walk.mjs';
import { isFindingLine, parseFindingLine, parseFindingsFromOutput } from '../lib/run-review.mjs';

describe('model-ratchet T-P19: walkSourceFiles and URL-safe finding parser', () => {
  it('walkSourceFiles skips .worktrees and does not follow directory symlinks (lstatSync)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mr-walk-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, '.worktrees/lane/src'), { recursive: true });
      mkdirSync(join(root, '__pycache__'), { recursive: true });
      writeFileSync(join(root, 'src/real.mjs'), 'export const a = 1;\n');
      writeFileSync(join(root, '.worktrees/lane/src/dup.mjs'), 'export const b = 2;\n');
      writeFileSync(join(root, '__pycache__/cached.py'), 'x = 1\n');
      // Symlink loop pointing back to root — statSync would recurse infinitely
      symlinkSync(root, join(root, 'src/loop-link'));

      const files = walkSourceFiles(root);
      assert.deepEqual(files, ['src/real.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes http:// and https:// URL schemes from finding-line detection and location parsing', () => {
    assert.equal(isFindingLine('See https://example.com:8443/docs for details'), false);
    assert.equal(isFindingLine('http://localhost:3000: server listening'), false);
    assert.equal(isFindingLine('HTTPS://api.example.com:443/v1'), false);

    // Real file:line alongside a URL still parses the real location
    assert.equal(isFindingLine('src/foo.mjs:42: check https://example.com:8443/docs'), true);
    const parsed = parseFindingLine('src/foo.mjs:42: check https://example.com:8443/docs', 'src/foo.mjs');
    assert.equal(parsed.location, 'src/foo.mjs:42');
    assert.equal(parsed.parsedLine, 42);

    // Bullet containing a URL keeps location: null instead of capturing the URL
    assert.equal(isFindingLine('- see https://example.com:8443/docs'), true);
    const bullet = parseFindingLine('- see https://example.com:8443/docs', 'src/foo.mjs');
    assert.equal(bullet.location, null);
    assert.equal(bullet.parsedLine, null);

    // Inline file:line after a URL captures the file:line, not the URL
    const inline = parseFindingLine('Ref https://example.com:8443 -> lib/bar.ts:17', 'lib/bar.ts');
    assert.equal(inline.location, 'lib/bar.ts:17');
    assert.equal(inline.parsedLine, null);

    // Leading URL line parses no location
    const leadingUrl = parseFindingLine('https://example.com:8443/path', 'src/foo.mjs');
    assert.equal(leadingUrl.location, null);
    assert.equal(leadingUrl.parsedLine, null);

    // parseFindingsFromOutput drops URL-only lines
    const findings = parseFindingsFromOutput(
      'Fetching https://example.com:8443/docs\nsrc/foo.mjs:12: real issue\n',
      'src/foo.mjs',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 12);
  });
});

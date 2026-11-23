import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopesOverlap } from '../lib/tickets.mjs';

function pair(scopeA, scopeB) {
  return [
    { id: 'A', scope: scopeA },
    { id: 'B', scope: scopeB },
  ];
}

describe('scopesOverlap', () => {
  test('matches leading **/ globs against concrete paths and directory globs', () => {
    const cases = [
      [['**/*.mjs'], ['packages/core/lib/tickets.mjs'], true],
      [['**/*.mjs'], ['packages/core/**'], true],
      [['**/*.test.mjs'], ['**/*.mjs'], true],
      [['**'], ['packages/cli/**'], true],
      [['**/*.mjs'], ['packages/core/**/*.ts'], false],
      [['**/*.mjs'], ['packages/core/lib/tickets.ts'], false],
    ];
    for (const [sa, sb, expected] of cases) {
      const [a, b] = pair(sa, sb);
      assert.equal(scopesOverlap(a, b), expected, `${sa} vs ${sb}`);
      assert.equal(scopesOverlap(b, a), expected, `${sb} vs ${sa} (symmetric)`);
    }
  });

  test('enforces / segment boundaries on literal and prefix globs', () => {
    const cases = [
      [['packages/cli'], ['packages/cli-utils'], false],
      [['packages/cli'], ['packages/cli-utils/**'], false],
      [['packages/cli/**'], ['packages/cli-utils/**'], false],
      [['packages/cli*'], ['packages/cli-utils/**'], false],
      [['packages/cli*/**'], ['packages/cli-utils/**'], true],
      [['packages/cli/*.mjs'], ['packages/cli/sub/*.mjs'], false],
      [['packages/cli/a*'], ['packages/cli/ab*'], true],
      [['packages/cli/index.mjs'], ['packages/cli/**'], true],
      [['packages/cli/index.mjs'], ['packages/cli/index.mjs'], true],
      [['packages/cli/index.mjs'], ['packages/cli/index.mjs.bak'], false],
    ];
    for (const [sa, sb, expected] of cases) {
      const [a, b] = pair(sa, sb);
      assert.equal(scopesOverlap(a, b), expected, `${sa} vs ${sb}`);
      assert.equal(scopesOverlap(b, a), expected, `${sb} vs ${sa} (symmetric)`);
    }
  });

  test('handles leading single * patterns with and without /', () => {
    const cases = [
      [['*.mjs'], ['src/*.mjs'], false],
      [['*.mjs'], ['index.*'], true],
      [['*.mjs'], ['**/index.mjs'], true],
      [['*/*.mjs'], ['src/*.mjs'], true],
      [['*foo**'], ['myfoo/bar.mjs'], true],
      [['*foo**'], ['src/foo/bar.mjs'], false],
      [['*foo**'], ['myfoo/**'], true],
      [['src/a/*'], ['src/a/foo*'], true],
      [['src/a/*.mjs'], ['src/a/*.ts'], false],
      // Multi-level depth regression: `*` cannot cross `/`, so src/*.mjs and
      // src/**/foo/bar.mjs are disjoint, while src/**/bar.mjs overlaps on src/bar.mjs.
      [['src/*.mjs'], ['src/**/foo/bar.mjs'], false],
      [['src/*.mjs'], ['src/**/bar.mjs'], true],
      [['src/**/a/*.mjs'], ['src/x/**/b/*.mjs'], false],
      [['src/**/a/*.mjs'], ['src/x/**/*.mjs'], true],
    ];
    for (const [sa, sb, expected] of cases) {
      const [a, b] = pair(sa, sb);
      assert.equal(scopesOverlap(a, b), expected, `${sa} vs ${sb}`);
      assert.equal(scopesOverlap(b, a), expected, `${sb} vs ${sa} (symmetric)`);
    }
  });
});

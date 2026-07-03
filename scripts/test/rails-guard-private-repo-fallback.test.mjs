// rails-guard-private-repo-fallback.test.mjs — regression test for issue #47.
//
// rails-guard docs/templates called the CI diff gate "unbypassable" and told
// adopters to "make it a required check" in branch protection. On a private
// repo on GitHub's free plan, both required-status-check mechanisms
// (PUT .../branches/main/protection, POST .../rulesets) return 403 ("Upgrade
// to GitHub Pro or make this repository public") — so the gate can run but
// can never actually block a merge for that common repo configuration.
//
// This test asserts:
//   1. docs/ci/rails-guard-private-repo-fallback.md documents the private-repo/
//      free-plan 403 constraint and sketches the fallback (fold the check into
//      an already-required job). This lives in its own file rather than inside
//      docs/ci/rails-guard.yml because that file is itself one of this repo's
//      immutable ADLC trust roots (scripts/rails-guard-ci.mjs) — editing it
//      trips the rail-freeze gate it implements.
//   2. Every integration doc that tells adopters to "make it a required
//      check" also surfaces the caveat/fallback, so the recommendation isn't
//      left undercut in isolation.
//   3. The toolkit README's CI-templates index points at the caveat too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

const FALLBACK_DOC = 'docs/ci/rails-guard-private-repo-fallback.md';

test('rails-guard-private-repo-fallback.md documents the private-repo/free-plan 403 constraint', () => {
  const content = read(FALLBACK_DOC);
  assert.match(
    content,
    /private[- ]repo/i,
    'fallback doc should mention the private-repo constraint'
  );
  assert.match(
    content,
    /403/,
    'fallback doc should mention the 403 both required-status-check APIs return'
  );
  assert.match(
    content,
    /branches\/main\/protection/,
    'fallback doc should name the branch-protection API that 403s'
  );
  assert.match(
    content,
    /rulesets/,
    'fallback doc should name the rulesets API that also 403s'
  );
});

test('rails-guard-private-repo-fallback.md sketches the fold-into-existing-required-job fallback', () => {
  const content = read(FALLBACK_DOC);
  assert.match(
    content,
    /fallback/i,
    'fallback doc should offer a named fallback pattern'
  );
  assert.match(
    content,
    /fold/i,
    'fallback doc should describe folding the check into an existing job'
  );
});

test('docs/ci/rails-guard.yml itself is untouched (it is an immutable ADLC trust root)', () => {
  const content = read('docs/ci/rails-guard.yml');
  assert.doesNotMatch(
    content,
    /PRIVATE-REPO \/ FREE-PLAN CAVEAT/,
    'the private-repo fallback content must live in rails-guard-private-repo-fallback.md, not inside the frozen rails-guard.yml trust root'
  );
});

const INTEGRATION_DOCS_WITH_REQUIRED_CHECK_ADVICE = [
  'docs/integrations/claude-code.md',
  'docs/integrations/opencode.md',
  'docs/integrations/antigravity.md',
  'docs/integrations/cursor.md',
];

for (const relPath of INTEGRATION_DOCS_WITH_REQUIRED_CHECK_ADVICE) {
  test(`${relPath} caveats its "make it a required check" advice for private/free-plan repos`, () => {
    const content = read(relPath);
    assert.match(
      content,
      /make it a required check/i,
      `${relPath} is expected to still recommend a required check (sanity check the fixture)`
    );
    assert.match(
      content,
      /private[- ]repo/i,
      `${relPath} should caveat the required-check advice for private/free-plan repos`
    );
    assert.match(
      content,
      /403/,
      `${relPath} should mention the 403 GitHub returns on a private/free-plan repo`
    );
  });
}

test('docs/README.md CI-templates entry points at the private-repo fallback', () => {
  const content = read('docs/README.md');
  const section = content.slice(content.indexOf('## CI templates'));
  assert.match(
    section,
    /private[- ]repo/i,
    'docs/README.md CI templates section should flag the private-repo caveat'
  );
});

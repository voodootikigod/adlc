// adversarial-review-template.test.mjs — prosecutes issue #60: a documented,
// not-force-installed CI template that wires `adversarial-review` into a risk
// gate (ADR-0007), mirroring the docs/ci/adlc-maintenance.yml "template, not
// force-installed" pattern.
//
// This file lives outside any single package (like rails-guard-ci.test.mjs
// and flag-consistency.test.mjs) because it asserts properties of a template
// document plus a cross-cutting CLI-usage contract, not the behavior of one
// package.
//
// Structural checks only (no YAML parser is a repo dependency, matching how
// the sibling docs/ci/*.yml templates are tested elsewhere in this repo —
// via hashing/shell execution rather than schema parsing). The one dynamic
// check (T-adlc60/AC6) actually runs the real gate-manifest binary against
// the exact --data payload shape the template emits, so the recording
// command is proven to work, not just present as text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(ROOT, 'docs', 'ci', 'adversarial-review.yml');
const GATE_MANIFEST_BIN = join(ROOT, 'packages', 'gate-manifest', 'bin', 'gate-manifest.mjs');

function readTemplate() {
  assert.ok(existsSync(TEMPLATE), `expected ${TEMPLATE} to exist`);
  return readFileSync(TEMPLATE, 'utf8');
}

// Explanatory `#` comments legitimately mention --loop/--evidence (to say why
// NOT to use them); only the executable (non-comment) lines must avoid them.
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

// Extracts and dedents the `run: |` script body of the step whose `- name:`
// line contains `stepNameSubstring`, so tests can actually execute a step's
// script under bash -eo pipefail (GitHub Actions' default shell) rather than
// only pattern-matching its text. This is what lets AC12/AC13 catch a
// regression even if a future edit reorders or rewrites the surrounding
// lines while dropping the behavior under test.
function extractStepScript(text, stepNameSubstring) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex(
    (l) => l.trim().startsWith('- name:') && l.includes(stepNameSubstring),
  );
  assert.ok(startIdx >= 0, `expected to find a step named like "${stepNameSubstring}"`);
  const stepIndent = lines[startIdx].match(/^(\s*)/)[1].length;

  let runIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    const indent = l.match(/^(\s*)/)[1].length;
    if (l.trim().startsWith('- name:') && indent <= stepIndent) break;
    if (/^\s*run:\s*\|\s*$/.test(l)) {
      runIdx = i;
      break;
    }
  }
  assert.ok(runIdx >= 0, `expected a "run: |" block for step "${stepNameSubstring}"`);
  const runIndent = lines[runIdx].match(/^(\s*)/)[1].length;

  const scriptLines = [];
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') {
      scriptLines.push('');
      continue;
    }
    const indent = l.match(/^(\s*)/)[1].length;
    if (indent <= runIndent) break;
    scriptLines.push(l);
  }

  const nonEmpty = scriptLines.filter((l) => l.trim() !== '');
  const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)[1].length));
  return scriptLines.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n');
}

test('AC1: docs/ci/adversarial-review.yml exists and is a documented template (not force-installed)', () => {
  const text = readTemplate();
  // Same "copy into your repo" framing as docs/ci/adlc-maintenance.yml — this
  // template must not be wired into .github/workflows/ directly by this change.
  assert.match(text, /copy into your repo as/i);
  assert.ok(!existsSync(join(ROOT, '.github', 'workflows', 'adversarial-review.yml')),
    'the template must not be force-installed into .github/workflows/');
});

test('AC2: triggers on pull_request against main', () => {
  const text = readTemplate();
  assert.match(text, /on:\s*\n\s*pull_request:/);
});

test('AC3: risk-tier path filter covers every ADR-0007 category', () => {
  const text = readTemplate();
  // auth / trust boundary
  assert.match(text, /auth/i);
  // security controls / deny paths: rail guards, validators, sandboxes
  assert.match(text, /guard/i);
  assert.match(text, /validat/i);
  assert.match(text, /sandbox/i);
  // secrets handling
  assert.match(text, /secret/i);
  // data-loss / destructive / irreversible ops
  assert.match(text, /destructive|irreversible|data-loss/i);
  // schema / migration changes
  assert.match(text, /migrat/i);
  assert.match(text, /schema/i);
  // CI/CD / supply-chain config
  assert.match(text, /\.github\/workflows/);
});

test('AC3b: risk-tier PATTERN actually matches realistic auth/validator file paths (not just substrings in prose)', () => {
  // Regression for a review finding: the PATTERN string could contain the
  // words "auth"/"validat" in comments/other alternatives while the *regex*
  // still failed to match common real-world file names like
  // `authentication/`, `authorization.ts`, or `validation.ts`. This test
  // extracts the exact `PATTERN=`/`PATTERN="$PATTERN|...` construction lines
  // from the classify step and runs the real `grep -qiE` the workflow runs,
  // against realistic sample paths -- the same verification method used to
  // find the bug.
  const text = readTemplate();
  const patternLines = text
    .split('\n')
    .filter((line) => /^\s*PATTERN=/.test(line))
    .map((line) => line.trim());
  assert.ok(patternLines.length > 1, 'expected the multi-line PATTERN construction in the classify step');

  const mustMatch = [
    'src/authentication/handler.js',
    'lib/authorization.ts',
    'src/validation.ts',
    'src/input-validation.ts',
    'src/auth/handler.js',
    // Regression for a round-3 review finding: the previous PATTERN required
    // a `/`/`-`/`_`/start-of-string boundary immediately before the literal
    // "auth", which missed these extremely common real-world auth file
    // names that don't have a separator directly adjacent to "auth".
    'src/oauth/callback.ts',
    'src/OAuthCallback.ts',
    'src/GoogleAuth.java',
    'src/isAuthenticated.ts',
    'lib/reauth.ts',
  ];
  const mustNotNecessarilyBlockUnrelated = ['src/components/Button.tsx', 'README.md'];

  for (const file of mustMatch) {
    const script = `${patternLines.join('\n')}\nprintf '%s\\n' ${JSON.stringify(file)} | grep -qiE "$PATTERN"`;
    const rc = execFileSync('bash', ['-c', `${script}; echo $?`], { encoding: 'utf8' }).trim();
    assert.equal(rc, '0', `expected PATTERN to classify "${file}" as risk=high (a real auth/validator path), but it did not match`);
  }

  for (const file of mustNotNecessarilyBlockUnrelated) {
    const script = `${patternLines.join('\n')}\nprintf '%s\\n' ${JSON.stringify(file)} | grep -qiE "$PATTERN"`;
    const rc = execFileSync('bash', ['-c', `${script}; echo $?`], { encoding: 'utf8' }).trim();
    assert.equal(rc, '1', `expected PATTERN to NOT classify unrelated file "${file}" as risk=high`);
  }
});

test('AC3d: bare "auth" substring accepted false positive is documented and exercised (e.g. author/AUTHORS.md)', () => {
  // Regression for a review finding: the classify step's comment used to
  // assert (incorrectly) that "there is no common non-auth English word
  // that contains 'auth' as a substring". `author`/`AUTHORS.md` are an
  // easy, common counterexample -- an `AUTHORS.md` file or an
  // `src/author.ts` model field has nothing to do with authn/authz but
  // still matches the bare `auth` alternative. This is an accepted false
  // positive under the file's own "a false positive just costs one extra
  // full review" tradeoff (not a bug), but the tradeoff must actually be
  // exercised here rather than only asserted in prose.
  const text = readTemplate();
  const patternLines = text
    .split('\n')
    .filter((line) => /^\s*PATTERN=/.test(line))
    .map((line) => line.trim());
  assert.ok(patternLines.length > 1, 'expected the multi-line PATTERN construction in the classify step');

  const acceptedFalsePositives = ['AUTHORS.md', 'src/author.ts', 'docs/authors/team.md'];
  for (const file of acceptedFalsePositives) {
    const script = `${patternLines.join('\n')}\nprintf '%s\\n' ${JSON.stringify(file)} | grep -qiE "$PATTERN"`;
    const rc = execFileSync('bash', ['-c', `${script}; echo $?`], { encoding: 'utf8' }).trim();
    assert.equal(rc, '0',
      `expected the bare "auth" substring match to (over-inclusively) flag "${file}" as risk=high -- ` +
      'this is the documented, accepted false-positive tradeoff, not a gap');
  }

  // The comment must no longer assert the false "no non-auth word contains
  // auth" claim; it must instead document this as an accepted tradeoff.
  assert.ok(!/there is no common non-auth/i.test(text),
    'the classify-step comment must not claim no non-auth English word contains "auth" as a substring -- ' +
    '"author"/"AUTHORS.md" are a common counterexample');
});

test('AC3c: ADVERSARIAL_REVIEW_VERSION is pinned to an exact version, not the mutable "latest" tag', () => {
  // Regression for the other half of commit 0790478 ("...and pin
  // adversarial-review version"): AC3b already regression-tests the regex
  // fix from that commit, but nothing previously asserted the version pin
  // itself, so a future edit could silently reintroduce `latest` -- exactly
  // the supply-chain risk the "ACTION REQUIRED item 1" comment warns
  // against -- and still pass a fully green test suite.
  const text = readTemplate();
  const executable = stripComments(text);
  const pinLines = executable.match(/ADVERSARIAL_REVIEW_VERSION:\s*\S+/g) || [];
  assert.ok(pinLines.length > 0, 'expected at least one ADVERSARIAL_REVIEW_VERSION: env assignment');
  for (const line of pinLines) {
    assert.ok(!/latest/i.test(line), `ADVERSARIAL_REVIEW_VERSION must not be pinned to the mutable "latest" tag: "${line}"`);
    assert.match(line, /ADVERSARIAL_REVIEW_VERSION:\s*['"]?\d+\.\d+\.\d+['"]?/,
      `ADVERSARIAL_REVIEW_VERSION must be an exact semver pin, got: "${line}"`);
  }
  // Both jobs (adversarial-review and adversarial-review-cheap) invoke
  // npx with this version -- both must be pinned identically, not just one.
  assert.match(executable, /npx --yes ["']?adversarial-review@\$\{ADVERSARIAL_REVIEW_VERSION\}/);
  const npxInvocations = (executable.match(/npx --yes ["']?adversarial-review@\$\{ADVERSARIAL_REVIEW_VERSION\}/g) || []).length;
  assert.equal(npxInvocations, 2, 'expected both the high-risk and cheap jobs to invoke the pinned version');
});

test('AC4: uses plain (non-loop) review mode and documents the durable reason (--loop is incompatible with --base/branch-scope review, independent of the now-closed adversarial-review#9)', () => {
  // Round-5 adversarial-review finding: adversarial-review#9 ("--loop
  // silently drops --providers") was closed upstream and the fix shipped in
  // the exact 2.6.0 version this template pins -- verified directly against
  // the published 2.6.0 package (--help text + src/loop.js's
  // runProviderRound path). So #9 is no longer a valid reason to avoid
  // --loop, and this test must not encode "cites #9" as the thing that
  // makes the design correct. The durable, still-true reason plain mode is
  // required is that 2.6.0's --loop hard-errors on --base <ref> / --scope
  // branch (it only supports --scope working-tree), which is incompatible
  // with this gate's read-only branch-diff review -- that's what this test
  // now asserts is documented, alongside the historical #9 context.
  const text = readTemplate();
  const executable = stripComments(text);
  assert.ok(!/--loop\b/.test(executable), 'no executable line may pass --loop (incompatible with --base/branch-scope review)');
  assert.match(text, /adversarial-review#9/, 'should still document the historical #9 context');
  assert.match(text, /2\.6\.0/, 'must note the fix shipped in the pinned 2.6.0 version, not leave #9 looking open');
  assert.match(text, /--base(?: <ref>| "?origin)?.{0,40}(incompatible|refuses|hard-errors|exits 1)|(incompatible|refuses|hard-errors|exits 1).{0,60}--base/is,
    'must document the real, durable blocker: --loop is incompatible with --base/branch-scope review');
  assert.match(text, /--providers/);
});

test('AC5: high-risk job runs the documented invocation shape and posts a PR comment', () => {
  const text = readTemplate();
  assert.match(text, /npx --yes ["']?adversarial-review/);
  assert.match(text, /--base ["']?"?origin\/\$BASE_REF/);
  assert.match(text, /--providers auto/);
  assert.match(text, /--fail-on high/);
  assert.match(text, /gh pr comment/);
});

test('AC6: records the verdict via the CLI flag gate-manifest actually supports (--data, not the stale --evidence doc convention)', () => {
  const text = readTemplate();
  const executable = stripComments(text);
  assert.match(executable, /gate-manifest record adversarial-review/);
  assert.ok(!executable.includes('--evidence'),
    'gate-manifest record has no --evidence flag (node:util parseArgs strict mode throws ' +
    'ERR_PARSE_ARGS_UNKNOWN_OPTION) -- must use the real --data JSON flag');
  assert.match(executable, /--data\s+["']/);
});

test('AC6b: the --data JSON payload shape the template emits is accepted by the real gate-manifest binary', () => {
  const text = readTemplate();
  // Pull the record step's --data template out of the yml and substitute
  // sample values for the shell variables it interpolates, so we exercise
  // gate-manifest with the exact JSON *shape* the workflow will send. The
  // template double-quotes the payload for bash variable interpolation and
  // backslash-escapes the inner JSON quotes (`\"`) -- undo that escaping here
  // since we invoke the binary directly (no shell) with execFileSync.
  const match = text.match(/--data\s+"(\{[^\n]*\})"/);
  assert.ok(match, 'expected a --data "{...}" JSON payload in the record step');
  const sample = match[1]
    .replaceAll('\\"', '"')
    .replaceAll('$providers', 'claude,gpt')
    .replaceAll('$verdict', 'needs-attention')
    .replaceAll('$surviving', '1');

  const dir = mkdtempSync(join(tmpdir(), 'gm-adv-review-'));
  try {
    const out = execFileSync(
      process.execPath,
      [GATE_MANIFEST_BIN, 'record', 'adversarial-review', '--data', sample, '--dir', dir, '--json'],
      { encoding: 'utf8' },
    );
    const entry = JSON.parse(out);
    assert.equal(entry.gate, 'adversarial-review');
    assert.equal(entry.data.verdict, 'needs-attention');
    assert.equal(entry.data.providers, 'claude,gpt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC7: non-risk-tier paths skip the full quorum (cost control per ADR-0007)', () => {
  const text = readTemplate();
  // There must be a second job path gated on the low-risk output that does
  // NOT request the full multi-provider quorum.
  assert.match(text, /risk\s*==\s*['"]low['"]/);
  const lowJobMatch = text.match(/risk[^\n]*low[\s\S]*?(?=\njobs:|$)/);
  assert.ok(lowJobMatch);
});

test('AC8: pins actions to full commit SHAs, matching the sibling template convention', () => {
  const text = readTemplate();
  assert.match(text, /actions\/checkout@[0-9a-f]{40}/);
  if (/actions\/setup-node@/.test(text)) {
    assert.match(text, /actions\/setup-node@[0-9a-f]{40}/);
  }
});

test('AC9: docs/toolkit.md references the new CI template', () => {
  const toolkit = readFileSync(join(ROOT, 'docs', 'toolkit.md'), 'utf8');
  assert.match(toolkit, /ci\/adversarial-review\.yml/);
});

test('AC10: docs/toolkit.md\'s gate-manifest record example uses the real --data flag, not --evidence', () => {
  const toolkit = readFileSync(join(ROOT, 'docs', 'toolkit.md'), 'utf8');
  // The runnable example is the indented ("    adlc gate-manifest record ...")
  // code sample -- prose above it is allowed to name the old, incorrect
  // --evidence flag while explaining the correction.
  const exampleMatch = toolkit.match(/^ {4}adlc gate-manifest record adversarial-review[\s\S]*?\n\n/m);
  assert.ok(exampleMatch, 'expected a runnable gate-manifest record example in docs/toolkit.md');
  assert.match(exampleMatch[0], /--data\s+'/);
  assert.ok(!exampleMatch[0].includes('--evidence'),
    'the runnable example must not use the nonexistent --evidence flag');
});

test('AC11: docs/README.md CI templates section lists the new template, mirroring adlc-maintenance.yml', () => {
  const readme = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8');
  assert.match(readme, /ci\/adversarial-review\.yml/);
});

test('AC12: "Record adversarial-review verdict" step tolerates a review-report.txt with no provider token under bash -eo pipefail (regression for a missing `set +e`)', () => {
  // Regression for a round-3 review finding: commit 4e347ff added `set +e`
  // before the provider-extraction grep specifically because GitHub Actions
  // runs `run:` blocks with `bash -eo pipefail` by default, and a
  // review-report.txt without a literal claude/gpt/codex/gemini token makes
  // that grep exit 1 -- which, without `set +e`, aborts the step *before*
  // `adlc gate-manifest record` runs. This actually executes the extracted
  // step script (not just a text match) under that same shell mode, so a
  // future edit that drops or reorders the guard fails this test.
  const text = readTemplate();
  let script = extractStepScript(text, 'Record adversarial-review verdict');
  // Substitute the one GitHub Actions expression the runner would normally
  // resolve before invoking the shell.
  script = script.replace('${{ steps.review.outputs.rc }}', '0');

  const dir = mkdtempSync(join(tmpdir(), 'adv-review-record-'));
  try {
    // Deliberately no claude/gpt/codex/gemini token -- this is exactly the
    // input that made the unguarded grep exit 1.
    writeFileSync(join(dir, 'review-report.txt'), 'no matching provider tokens in this report\n');

    // Stub `adlc` on PATH: touch a marker file so we can prove the script
    // reached this command instead of aborting earlier under pipefail.
    const stubDir = join(dir, 'bin');
    mkdirSync(stubDir);
    const marker = join(dir, 'adlc-was-called');
    writeFileSync(join(stubDir, 'adlc'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(join(stubDir, 'adlc'), 0o755);

    const fullScript = `set -eo pipefail\n${script}`;
    execFileSync('bash', ['-c', fullScript], {
      cwd: dir,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
    });

    assert.ok(
      existsSync(marker),
      'expected `adlc gate-manifest record` to run even when review-report.txt has no ' +
        'provider token -- if this fails, the step is missing (or lost) its `set +e` guard ' +
        'against bash -eo pipefail aborting the provider-extraction grep',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC13: both "Post ... PR comment" steps tolerate a failing `gh pr comment` (forked PR, read-only GITHUB_TOKEN)', () => {
  // Regression for a round-3 review finding: commit 4e347ff appended
  // `|| echo "::warning..."` to both `gh pr comment` invocations so a
  // forked PR's read-only GITHUB_TOKEN can't fail the job. For the "cheap"
  // job this also protects the documented "advisory only, never blocks the
  // PR" contract. This both text-checks the fallback and actually executes
  // each step's script with a `gh` stub that always fails, so a future edit
  // that drops the `|| echo` (or reintroduces a bare `gh pr comment`) fails
  // this test instead of shipping unnoticed.
  const text = readTemplate();
  const stepNames = [
    'Post review report as a PR comment',
    'Post informational review as a PR comment',
  ];

  for (const stepName of stepNames) {
    const script = extractStepScript(text, stepName);
    assert.match(
      script,
      /gh pr comment[\s\S]*\|\|\s*echo\s+"::warning/,
      `expected "${stepName}" to fall back with "|| echo ::warning" instead of letting ` +
        '`gh pr comment` fail the job',
    );

    const dir = mkdtempSync(join(tmpdir(), 'adv-review-comment-'));
    try {
      writeFileSync(join(dir, 'review-report.txt'), 'some review output\n');

      // Stub `gh` on PATH to always fail, simulating a forked PR's
      // read-only GITHUB_TOKEN rejecting `gh pr comment`.
      const stubDir = join(dir, 'bin');
      mkdirSync(stubDir);
      writeFileSync(join(stubDir, 'gh'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(stubDir, 'gh'), 0o755);

      const fullScript = `set -eo pipefail\n${script}`;
      assert.doesNotThrow(() => {
        execFileSync('bash', ['-c', fullScript], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${stubDir}:${process.env.PATH}`,
            GH_TOKEN: 'fake',
            PR_NUMBER: '123',
          },
        });
      }, `expected "${stepName}" to survive a failing \`gh pr comment\` under bash -eo pipefail`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

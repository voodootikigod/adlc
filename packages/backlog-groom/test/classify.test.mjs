// classify.test.mjs — AC2.
//
// Routing decides HOW an issue will be checked, not what it concludes (§3.2 vs
// §3.3). `unverifiable` is a first-class route: collapsing it into "still valid"
// is the specific false-green this design exists to avoid, because it lets a
// sweep under-report while appearing to have examined everything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyIssue, parseReferences, MAX_REFERENCES_PER_ISSUE, MAX_SNIPPETS_PER_ISSUE } from '../lib/classify.mjs';

const AUDIT_BODY = [
  '**Source:** `/release-audit` for @adlc 1.11.0, class **false-green**.',
  '',
  '**Location** `plugins/adlc-pi/lib/gate-tool.mjs:134`',
  '',
  '```',
  "const code = typeof res?.code === 'number' ? res.code : 1;",
  '```',
  '',
  'So a gate that hangs returns `code === 0`.',
].join('\n');

test('AC2: the audit body shape routes mechanical, with path, line and snippet captured', () => {
  const c = classifyIssue({ number: 1, title: 't', body: AUDIT_BODY, labels: [] });
  assert.equal(c.route, 'mechanical');
  const ref = c.references[0];
  assert.equal(ref.path, 'plugins/adlc-pi/lib/gate-tool.mjs');
  assert.equal(ref.line, 134);
  assert.match(ref.snippets[0], /const code = typeof/, 'the fenced block is attributed to the nearest preceding path');
});

test('AC2: an inline path:line with no fence still routes mechanical — existence is checkable', () => {
  const c = classifyIssue({ number: 2, title: 't', body: 'The bug is at `packages/core/lib/text.mjs:37` and never fires.', labels: [] });
  assert.equal(c.route, 'mechanical');
  assert.equal(c.references[0].path, 'packages/core/lib/text.mjs');
  assert.equal(c.references[0].line, 37);
  assert.deepEqual(c.references[0].snippets, [], 'no fence means nothing to compare — verify decides what that implies');
});

test('AC2: a checkable claim with no parseable reference routes to model', () => {
  const body = 'The `resolveModel` helper returns the wrong tier when the provider is unset. Seems to be in the router.';
  const c = classifyIssue({ number: 3, title: 'router picks the wrong tier', body, labels: [] });
  assert.equal(c.route, 'model', 'code identifiers are a checkable claim even without a path');
  assert.deepEqual(c.references, []);
});

test('AC2: an issue with no checkable claim about code routes to unverifiable', () => {
  const body = 'We should discuss the roadmap for next quarter and decide what matters most to users.';
  const c = classifyIssue({ number: 4, title: 'plan the quarter', body, labels: [] });
  assert.equal(c.route, 'unverifiable');
  assert.deepEqual(c.references, []);
});

test('AC2: an empty body is unverifiable, never mechanical', () => {
  for (const body of ['', '   ', null, undefined]) {
    const c = classifyIssue({ number: 5, title: 'no body', body, labels: [] });
    assert.equal(c.route, 'unverifiable', `body ${JSON.stringify(body)} must not be mechanical`);
  }
});

test('AC2: a title-only code signal is enough for model, and never for mechanical', () => {
  const c = classifyIssue({ number: 6, title: 'fence() drops the tag when maxChars is 0', body: 'It is wrong.', labels: [] });
  assert.equal(c.route, 'model');
});

test('AC2: prose that merely mentions a version or a date is not a code claim', () => {
  // The failure mode is over-routing to `model`: every issue then costs a model
  // call and the cheap path never runs.
  const c = classifyIssue({ number: 7, title: 'release 1.11.0 on 2026-09-13', body: 'Ship it on Friday, 1.11.0, after the standup.', labels: [] });
  assert.equal(c.route, 'unverifiable');
});

test('AC2: a URL containing a path is not a code reference', () => {
  // A GitHub permalink is a link, not a claim that this repo has that file at
  // that line; treating it as one invents references from link text.
  const body = 'See https://github.com/voodootikigod/adlc/blob/main/packages/core/lib/text.mjs:37 for context.';
  const c = classifyIssue({ number: 8, title: 't', body, labels: [] });
  assert.notEqual(c.references[0]?.path, 'packages/core/lib/text.mjs');
});

test('AC2: parseReferences dedupes the same path:line cited twice', () => {
  const body = 'at `lib/a.mjs:3` ... and again at `lib/a.mjs:3`';
  const refs = parseReferences(body);
  assert.equal(refs.length, 1);
});

test('AC2: a path cited without a line is captured, with line null', () => {
  const refs = parseReferences('the whole of `packages/parallax/lib/modes.mjs` is wrong');
  assert.equal(refs[0].path, 'packages/parallax/lib/modes.mjs');
  assert.equal(refs[0].line, null);
});

test('AC2: a fence not preceded by any path is not attributed to one', () => {
  const body = ['Some prose.', '```', 'const x = 1;', '```'].join('\n');
  const refs = parseReferences(body);
  assert.deepEqual(refs, [], 'an unattributed fence is not a code reference — it has no file to check against');
});

test('AC2: every route is exactly one of the three, for every input', () => {
  const bodies = [AUDIT_BODY, 'the `foo()` helper', 'plan the quarter', '', '`a/b.mjs:1`'];
  for (const body of bodies) {
    const c = classifyIssue({ number: 9, title: '', body, labels: [] });
    assert.ok(['mechanical', 'model', 'unverifiable'].includes(c.route), `unexpected route ${c.route}`);
  }
});

test('AC2: a non-repo-relative path is not a reference, and does not steal a later citation\'s snippet', () => {
  // Ordering bug this pins: if `../core/index.mjs` is filtered only at the end,
  // it still claims the fence that follows it, and the real citation below is
  // left with nothing to compare — a silent downgrade from a verifiable issue to
  // an unverifiable one.
  const body = [
    'imported from `../core/index.mjs` originally',
    '',
    '**Location** `packages/core/lib/text.mjs:37`',
    '',
    '```',
    'const tag = `${label}-${capped.length}`;',
    '```',
  ].join('\n');
  const refs = parseReferences(body);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, 'packages/core/lib/text.mjs');
  assert.match(refs[0].snippets[0], /const tag/, 'the snippet belongs to the real citation');
});

test('AC2: absolute paths and dot segments are never references', () => {
  assert.deepEqual(parseReferences('see /etc/passwd.txt for it'), []);
  assert.deepEqual(parseReferences('see ./local/thing.mjs for it'), []);
  assert.deepEqual(parseReferences('see ../up/thing.mjs for it'), []);
});

test('AC2: an extension containing a digit is still a path — .mp4, .v2.json, .h5', () => {
  // The extension character class must cover the whole digit range. A narrowed
  // one silently stops recognising these as citations, which is a verification
  // downgrade with no signal: the issue quietly routes to `model` instead.
  for (const path of ['assets/clip.mp4', 'packages/x/schema.v2.json', 'data/store.h5']) {
    const refs = parseReferences(`the bug is in \`${path}\` somewhere`);
    assert.equal(refs[0]?.path, path, `${path} must parse as a reference`);
  }
});

test('AC2: a URL with a digit in its scheme is still masked — s3://, h2://', () => {
  // The scheme character class must cover the whole digit range, or `s3://...`
  // stops being recognised as a URL and its path is mined for a citation the
  // issue never made about this repository.
  const refs = parseReferences('artifacts live at s3://bucket/packages/core/lib/text.mjs today');
  assert.deepEqual(refs, []);
});

test('AC2: a code-shaped token inside a URL is not a code claim', () => {
  // The URL mask has to cover schemes with digits too. Unmasked, the filename in
  // an s3:// link reads as a bare-filename code claim and the issue is routed to
  // an expensive model verification it never warranted.
  const c = classifyIssue({ number: 1, title: 'artifacts', body: 'they live at s3://bucket/dir/thing.mjs and rotate weekly', labels: [] });
  assert.equal(c.route, 'unverifiable');
});

test('AC2: every excerpt for one citation is kept, not just the first', () => {
  const body = [
    '**Location** `lib/a.mjs:10`',
    '',
    '```',
    'first excerpt',
    '```',
    '',
    'and also',
    '',
    '```',
    'second excerpt',
    '```',
  ].join('\n');
  const refs = parseReferences(body);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].snippets, ['first excerpt', 'second excerpt']);
});

test('AC2: a repeated citation MERGES its excerpts rather than dropping them', () => {
  const body = [
    '`lib/a.mjs:10`', '', '```', 'one', '```', '',
    'again at `lib/a.mjs:10`', '', '```', 'two', '```',
  ].join('\n');
  const refs = parseReferences(body);
  assert.equal(refs.length, 1, 'still one reference');
  assert.deepEqual(refs[0].snippets, ['one', 'two'], 'dedupe must not discard evidence');
});

test('AC2: citations are capped per issue, and the issue is marked truncated', () => {
  // Every citation costs synchronous git subprocesses, and an issue body is
  // untrusted input. Unbounded, one issue citing thousands of locations makes a
  // sweep appear hung.
  const body = Array.from({ length: 500 }, (_, i) => `see \`lib/f${i}.mjs:${i + 1}\``).join('\n');
  const c = classifyIssue({ number: 1, title: 't', body, labels: [] });
  assert.equal(c.references.length, MAX_REFERENCES_PER_ISSUE);
  assert.equal(c.referencesTruncated, true);
});

test('AC2: the citation cap is 50 — the value is a deliberate budget, not a default', () => {
  // Pinned like the other operator-visible bounds. 50 citations is already far
  // past what a real issue carries, and each one costs several synchronous git
  // subprocesses, so the number is the per-issue work budget for a sweep.
  assert.equal(MAX_REFERENCES_PER_ISSUE, 50);
});

test('AC2: an ordinary issue is not marked truncated', () => {
  const c = classifyIssue({ number: 2, title: 't', body: 'see `lib/a.mjs:1` and `lib/b.mjs:2`', labels: [] });
  assert.equal(c.references.length, 2);
  assert.equal(c.referencesTruncated, false);
});

test('AC2: excerpts are bounded per issue — repeated citations of one path cannot slip the cap', () => {
  // The reference cap counts distinct path:line keys, so a body repeating
  // thousands of fences for ONE path merged them all into a single reference and
  // stayed under the cap, while verification matched once per excerpt.
  const fences = Array.from({ length: 400 }, (_, i) => `\`lib/a.mjs:1\`\n\n\`\`\`\nexcerpt ${i}\n\`\`\``).join('\n\n');
  const c = classifyIssue({ number: 1, title: 't', body: fences, labels: [] });
  const total = c.references.reduce((n, r) => n + r.snippets.length, 0);
  assert.equal(total, MAX_SNIPPETS_PER_ISSUE);
  assert.equal(c.referencesTruncated, true, 'and the issue says its evidence is incomplete');
});

test('AC2: the excerpt bound is 200 — the per-issue matching budget', () => {
  // Pinned like the other operator-visible bounds. Each excerpt is matched
  // against the cited file, so this is the ceiling on match work one issue can
  // demand, and 200 is already far past what a real citation carries.
  assert.equal(MAX_SNIPPETS_PER_ISSUE, 200);
});

test('AC2: identical excerpts are deduped — repetition is not extra evidence', () => {
  const body = ['`lib/a.mjs:1`', '', '```', 'same', '```', '', '`lib/a.mjs:1`', '', '```', 'same', '```'].join('\n');
  const refs = parseReferences(body);
  assert.deepEqual(refs[0].snippets, ['same']);
});

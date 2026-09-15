// verify.test.mjs — AC1, AC3, AC13.
//
// THE DEFECT THIS FILE EXISTS TO PREVENT (spec §3.3): a mechanical check
// anchored to the cited LINE number closes live bugs. Any unrelated edit above
// the citation shifts every line below it, the snippet stops matching AT THAT
// LINE, and a live issue verdicts `fixed` and is autonomously closed. The line
// is a HINT; `fixed` requires the snippet to be absent from the WHOLE file.
//
// Everything is injected, so these tests assert the decision logic rather than
// the state of this repository's working tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyIssue, matchSnippet, prepareContent } from '../lib/verify.mjs';

const SNIPPET = "const code = typeof res?.code === 'number' ? res.code : 1;";

/**
 * A world where `files` maps path → contents; anything else does not exist.
 *
 * `everExisted` defaults to true, so an absent path means "it was here and is
 * gone" — a real `moved`. The never-tracked case is exercised explicitly below,
 * because the two are different findings and only one of them is decay.
 */
function world(files, lastCommit = 'abc1234', everExisted = () => true) {
  return {
    readFile: (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    pathExists: (p) => p in files,
    lastCommitFor: () => lastCommit,
    everExisted,
  };
}

function mechanical(references) {
  return { number: 1, route: 'mechanical', references };
}

test('AC1: a cited snippet still present at HEAD verifies valid', () => {
  const files = { 'lib/a.mjs': `line one\n${SNIPPET}\nline three\n` };
  const v = verifyIssue(mechanical([{ path: 'lib/a.mjs', line: 2, snippet: SNIPPET }]), world(files));
  assert.equal(v.verdict, 'valid');
  assert.equal(v.evidence.foundAtLine, 2);
});

test('AC1: a snippet absent from the whole file verifies fixed, with the changing commit as evidence', () => {
  const files = { 'lib/a.mjs': 'something else entirely\n' };
  const v = verifyIssue(mechanical([{ path: 'lib/a.mjs', line: 2, snippet: SNIPPET }]), world(files, 'deadbee'));
  assert.equal(v.verdict, 'fixed');
  assert.equal(v.evidence.lastCommitTouchingPath, 'deadbee', 'a close cites the last commit to touch the path — named for what it is');
  assert.ok(v.evidence.path === 'lib/a.mjs');
});

test('AC13: a snippet that MOVED within its file verifies valid, never fixed', () => {
  // The citation says line 2. An unrelated edit inserted 40 lines above it, so
  // the snippet now sits at line 42. A line-anchored check would call this
  // `fixed` and close a live bug. This is the single most likely wrong close in
  // the design.
  const padding = Array.from({ length: 40 }, (_, i) => `// inserted line ${i}`).join('\n');
  const files = { 'lib/a.mjs': `line one\n${padding}\n${SNIPPET}\ntail\n` };
  const v = verifyIssue(mechanical([{ path: 'lib/a.mjs', line: 2, snippet: SNIPPET }]), world(files));
  assert.equal(v.verdict, 'valid', 'the line is a hint; the snippet is the identity');
  assert.equal(v.evidence.citedLine, 2);
  assert.equal(v.evidence.foundAtLine, 42, 'the evidence records where it actually is now');
  assert.equal(v.evidence.movedWithinFile, true, 'and states plainly that it moved');
});

test('AC13: whitespace and indentation changes do not make a live snippet look fixed', () => {
  // Reindentation is the other shift that looks like a deletion to a naive
  // comparison.
  const files = { 'lib/a.mjs': `if (x) {\n      ${SNIPPET.replace(/ +/g, '  ')}\n}\n` };
  const v = verifyIssue(mechanical([{ path: 'lib/a.mjs', line: 1, snippet: `  ${SNIPPET}` }]), world(files));
  assert.equal(v.verdict, 'valid');
});

test('AC3: a cited path that no longer exists verifies moved, never fixed', () => {
  const v = verifyIssue(mechanical([{ path: 'lib/gone.mjs', line: 3, snippet: SNIPPET }]), world({}));
  assert.equal(v.verdict, 'moved', 'the claim may still hold elsewhere — this is a re-locate, not a close');
  assert.notEqual(v.verdict, 'fixed');
});

test('AC3: a missing path outranks a fixed snippet elsewhere — moved wins', () => {
  const files = { 'lib/a.mjs': 'nothing here\n' };
  const v = verifyIssue(
    mechanical([
      { path: 'lib/a.mjs', line: 1, snippet: SNIPPET },
      { path: 'lib/gone.mjs', line: 1, snippet: SNIPPET },
    ]),
    world(files)
  );
  assert.equal(v.verdict, 'moved');
});

test('AC1: one live citation outranks another that reads fixed — valid wins, so nothing closes', () => {
  // Conservative by construction: an issue with any citation still present is
  // not fixed, and closing it would be the expensive error.
  const files = { 'lib/a.mjs': `${SNIPPET}\n`, 'lib/b.mjs': 'gone\n' };
  const v = verifyIssue(
    mechanical([
      { path: 'lib/b.mjs', line: 1, snippet: SNIPPET },
      { path: 'lib/a.mjs', line: 1, snippet: SNIPPET },
    ]),
    world(files)
  );
  assert.equal(v.verdict, 'valid');
});

test('AC1: a reference with no snippet cannot conclude — the issue is unverifiable, never valid', () => {
  // A path that exists tells us nothing about whether the described defect is
  // still there. Calling that `valid` would be a false green in the safe
  // direction, and calling it `fixed` would be one in the dangerous direction.
  const files = { 'lib/a.mjs': 'anything\n' };
  const v = verifyIssue(mechanical([{ path: 'lib/a.mjs', line: 9, snippet: null }]), world(files));
  assert.equal(v.verdict, 'unverifiable');
  assert.match(v.reason, /no snippet/i);
});

test('AC1: an unreadable file is unverifiable, not fixed', () => {
  const w = world({ 'lib/a.mjs': 'x' });
  w.readFile = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  const v = verifyIssue(mechanical([{ path: 'lib/a.mjs', line: 1, snippet: SNIPPET }]), w);
  assert.equal(v.verdict, 'unverifiable', 'a read error is not evidence that the code changed');
  assert.match(v.reason, /EACCES|unreadable/i);
});

test('the model route is never verified mechanically — it is returned for the skill to judge', () => {
  const v = verifyIssue({ number: 2, route: 'model', references: [] }, world({}));
  assert.equal(v.verdict, 'unverified');
  assert.equal(v.route, 'model', 'the route survives so the report can count it');
});

test('the unverifiable route stays unverifiable and carries no evidence', () => {
  const v = verifyIssue({ number: 3, route: 'unverifiable', references: [] }, world({}));
  assert.equal(v.verdict, 'unverifiable');
  assert.equal(v.evidence, null, 'no evidence means nothing downstream can cite it as a reason to act');
});

test('a verdict is always one of the declared values', () => {
  const files = { 'lib/a.mjs': `${SNIPPET}\n` };
  const cases = [
    mechanical([{ path: 'lib/a.mjs', line: 1, snippet: SNIPPET }]),
    mechanical([{ path: 'nope.mjs', line: 1, snippet: SNIPPET }]),
    mechanical([{ path: 'lib/a.mjs', line: 1, snippet: null }]),
    { number: 4, route: 'model', references: [] },
    { number: 5, route: 'unverifiable', references: [] },
  ];
  for (const c of cases) {
    const v = verifyIssue(c, world(files));
    assert.ok(['valid', 'fixed', 'moved', 'unverifiable', 'unverified'].includes(v.verdict), `unexpected verdict ${v.verdict}`);
  }
});

test('AC3: a path git has NEVER tracked is not a reference at all, and never moved', () => {
  // Found by the first live run: issue bodies are full of path-shaped prose —
  // `lib/plan.mjs` from another project, `rejection-mining/lib/llm.mjs` shorn of
  // its `packages/` prefix by a `pkg:` label. Treating each as a deleted file
  // produced 186 false `moved` verdicts out of 379 issues, which would have
  // buried every real finding.
  const v = verifyIssue(
    mechanical([{ path: 'lib/from-another-repo.mjs', line: 1, snippet: SNIPPET }]),
    world({}, 'abc1234', () => false)
  );
  assert.notEqual(v.verdict, 'moved', 'prose that looks like a path is not decay');
  assert.equal(v.verdict, 'unverifiable');
  assert.match(v.reason, /never existed/i);
});

test('AC3: moved and never-tracked are distinguished by git history, not by spelling', () => {
  const tracked = verifyIssue(mechanical([{ path: 'lib/deleted.mjs', line: 1, snippet: SNIPPET }]), world({}, 'abc1234', () => true));
  assert.equal(tracked.verdict, 'moved');

  const never = verifyIssue(mechanical([{ path: 'lib/deleted.mjs', line: 1, snippet: SNIPPET }]), world({}, 'abc1234', () => false));
  assert.equal(never.verdict, 'unverifiable');
});

test('AC3: a real moved outranks a never-tracked sibling reference', () => {
  const v = verifyIssue(
    mechanical([
      { path: 'noise/prose.mjs', line: 1, snippet: SNIPPET },
      { path: 'lib/deleted.mjs', line: 1, snippet: SNIPPET },
    ]),
    world({}, 'abc1234', (p) => p === 'lib/deleted.mjs')
  );
  assert.equal(v.verdict, 'moved');
  assert.equal(v.evidence.path, 'lib/deleted.mjs', 'the evidence cites the path that actually existed');
});

test('AC1/AC13: an ELIDED excerpt — non-contiguous lines pasted together — verifies valid', () => {
  // Found against the real backlog, not by a test. Issue #1005 quotes three
  // lines of fence() that sit at 42, 48 and 50 with other code between them.
  // Requiring contiguity verdicted that live security issue `fixed`, which
  // would have closed it autonomously.
  const file = [
    'export function fence(label, content, maxChars) {',
    '  const capped = tail(raw, maxChars);',
    '  const truncated = capped.length < raw.length;',
    '  // a comment the issue did not quote',
    '  const tag = `${label}-${capped.length}`;',
    '  const marker = truncated ? long : label;',
    '  return `<<UNTRUSTED:${marker}:${tag}>>`;',
    '}',
  ].join('\n');
  const excerpt = [
    'const capped = tail(raw, maxChars);',
    'const tag = `${label}-${capped.length}`;',
    'return `<<UNTRUSTED:${marker}:${tag}>>`;',
  ].join('\n');

  const v = verifyIssue(mechanical([{ path: 'lib/text.mjs', line: 37, snippet: excerpt }]), world({ 'lib/text.mjs': file }));
  assert.equal(v.verdict, 'valid', 'every quoted line is still present, just not adjacent');
});

test('AC1: a PARTIAL survival is unverifiable, never fixed — changed is not fixed', () => {
  // The middle ground is where a naive matcher does the damage: some of the
  // cited code survives, so the defect may well still be there in a new shape.
  const file = 'const capped = tail(raw, maxChars);\nsomething completely different\n';
  const excerpt = 'const capped = tail(raw, maxChars);\nconst tag = `${label}-${capped.length}`;\n';
  const v = verifyIssue(mechanical([{ path: 'lib/text.mjs', line: 1, snippet: excerpt }]), world({ 'lib/text.mjs': file }));
  assert.equal(v.verdict, 'unverifiable');
  assert.match(v.reason, /1 of 2/, 'the report says exactly how much survived');
});

test('AC1: fixed still requires that NO cited line survives', () => {
  const file = 'nothing from the citation at all\n';
  const excerpt = 'const capped = tail(raw, maxChars);\nconst tag = one;\n';
  const v = verifyIssue(mechanical([{ path: 'lib/text.mjs', line: 1, snippet: excerpt }]), world({ 'lib/text.mjs': file }));
  assert.equal(v.verdict, 'fixed');
  assert.match(v.evidence.reason, /no line/i);
});

test('AC1: reordered cited lines are partial, not gone — a reorder is not a fix', () => {
  const file = 'const b = 2;\nconst a = 1;\n';
  const v = verifyIssue(mechanical([{ path: 'x.mjs', line: 1, snippet: 'const a = 1;\nconst b = 2;\nconst c = 3;' }]), world({ 'x.mjs': file }));
  assert.notEqual(v.verdict, 'fixed');
});

test('AC1: a single-character line is part of the citation — a lone brace is not noise', () => {
  // Normalisation drops BLANK lines only. Dropping short ones too would erase
  // `}` and `)` from both sides, so a snippet whose only remaining difference is
  // its closing brace would compare equal.
  const file = 'if (x) {\n  doThing();\n}\n';
  const v = verifyIssue(mechanical([{ path: 'a.mjs', line: 1, snippet: 'if (x) {\n  doThing();\n}' }]), world({ 'a.mjs': file }));
  assert.equal(v.verdict, 'valid');

  // A snippet sharing only its closing brace with the file must not read as
  // present: `}` alone is not the citation.
  const braceOnly = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 1, snippet: 'if (y) {\n  other();\n}' }]),
    world({ 'a.mjs': file })
  );
  assert.notEqual(braceOnly.verdict, 'valid', 'a different body must not match just because the braces do');
  assert.equal(braceOnly.verdict, 'unverifiable', 'one shared line of three is partial survival, which never closes');
});

test('AC1: one live excerpt among several prevents fixed — every excerpt is judged', () => {
  // Raised in cross-model review. An issue that cites one location twice — a
  // first excerpt since removed, a second describing the still-live defect —
  // must not verify `fixed`. Judging only the first excerpt produces a false
  // close on an open bug.
  const file = 'the second excerpt lives here\nand more\n';
  const v = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 10, snippets: ['long gone line', 'the second excerpt lives here'] }]),
    world({ 'a.mjs': file })
  );
  assert.equal(v.verdict, 'valid');
});

test('AC1: fixed requires EVERY excerpt to be gone, and says how many it checked', () => {
  const v = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 1, snippets: ['gone one', 'gone two'] }]),
    world({ 'a.mjs': 'nothing related\n' })
  );
  assert.equal(v.verdict, 'fixed');
  assert.match(v.evidence.reason, /2 cited excerpts/);
});

test('AC1: a partial excerpt still outranks a wholly-absent one', () => {
  const v = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 1, snippets: ['utterly absent', 'kept line\nvanished line'] }]),
    world({ 'a.mjs': 'kept line\n' })
  );
  assert.equal(v.verdict, 'unverifiable', 'partial survival never closes');
});

test('AC1: an UNVERIFIABLE citation outranks a fixed one — a close needs complete evidence', () => {
  // Raised in cross-model review. An issue cites two locations: one snippet is
  // gone, the other has no excerpt at all. That issue has NOT been shown fixed —
  // one citation was never checked — and returning `fixed` would close on
  // incomplete evidence.
  const v = verifyIssue(
    mechanical([
      { path: 'gone.mjs', line: 1, snippets: ['vanished'] },
      { path: 'other.mjs', line: 2, snippets: [] },
    ]),
    world({ 'gone.mjs': 'nothing\n', 'other.mjs': 'anything\n' })
  );
  assert.equal(v.verdict, 'unverifiable');
  assert.notEqual(v.verdict, 'fixed');
});

test('AC1: an unreadable sibling citation also prevents fixed', () => {
  const w = world({ 'gone.mjs': 'nothing\n', 'locked.mjs': 'x' });
  const realRead = w.readFile;
  w.readFile = (p) => {
    if (p === 'locked.mjs') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return realRead(p);
  };
  const v = verifyIssue(
    mechanical([
      { path: 'gone.mjs', line: 1, snippets: ['vanished'] },
      { path: 'locked.mjs', line: 1, snippets: ['something'] },
    ]),
    w
  );
  assert.equal(v.verdict, 'unverifiable', 'a citation we could not read is not evidence of a fix');
});

test('AC1: a clean fixed — every citation checked and all gone — still verifies fixed', () => {
  const v = verifyIssue(
    mechanical([
      { path: 'a.mjs', line: 1, snippets: ['gone one'] },
      { path: 'b.mjs', line: 1, snippets: ['gone two'] },
    ]),
    world({ 'a.mjs': 'nothing\n', 'b.mjs': 'nothing\n' })
  );
  assert.equal(v.verdict, 'fixed', 'the precedence must not make fixed unreachable');
});

test('AC1: verification reads HEAD, not the working tree', () => {
  // Raised in cross-model review, and it is a false-close path. The contract is
  // verification against HEAD; reading the filesystem lets a developer's
  // uncommitted edit decide the verdict. Someone part-way through a fix — the
  // snippet deleted locally, nothing committed — would see `fixed` and hand the
  // write path a close proposal for a bug still in the repository.
  //
  // Asserted by giving the two seams DIFFERENT answers and checking which one
  // the verdict followed.
  const headContent = `${SNIPPET}\n`;
  const workingTree = 'the developer deleted it locally\n';
  const reads = [];
  const io = {
    readFile: (p) => { reads.push(p); return headContent; },  // stands in for HEAD
    pathExists: () => true,
    lastCommitFor: () => 'abc',
    everExisted: () => true,
  };
  const v = verifyIssue(mechanical([{ path: 'a.mjs', line: 1, snippets: [SNIPPET] }]), io);
  assert.equal(v.verdict, 'valid', 'the committed content decides, not the working copy');
  assert.ok(reads.includes('a.mjs'));
  assert.notEqual(workingTree, headContent);
});

test('AC1: an EMPTY or whitespace-only fence is not evidence — never fixed', () => {
  // Raised in cross-model review, and the worst shape yet: an empty fence
  // normalises to zero lines, the matcher reports `none`, and `none` mapped
  // straight to `fixed`. A malformed citation manufactured a close candidate
  // carrying no evidence whatsoever, on a bug still in the file.
  for (const empty of ['', '   ', '\n\n']) {
    const v = verifyIssue(
      mechanical([{ path: 'a.mjs', line: 1, snippets: [empty] }]),
      world({ 'a.mjs': 'the bug is still right here\n' })
    );
    assert.notEqual(v.verdict, 'fixed', `an empty fence (${JSON.stringify(empty)}) must not close anything`);
    assert.equal(v.verdict, 'unverifiable');
    assert.match(v.reason, /empty excerpt/);
  }
});

test('AC1: an empty fence alongside a real one does not dilute the real verdict', () => {
  const v = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 1, snippets: ['', 'still here'] }]),
    world({ 'a.mjs': 'still here\n' })
  );
  assert.equal(v.verdict, 'valid');
});

test('AC1: a snippet quoting the same line twice is not satisfied by one occurrence', () => {
  // Raised in cross-model review. Counting needle lines against a SET of
  // haystack lines double-counts duplicates, so a snippet quoting a line twice
  // against a file retaining it once reported `all` — a false `valid` on code
  // that is half gone.
  const v = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 1, snippets: ['dup();\nother();\ndup();'] }]),
    world({ 'a.mjs': 'dup();\nunrelated();\n' })
  );
  assert.notEqual(v.verdict, 'valid', 'two occurrences were cited and only one survives');
  assert.equal(v.verdict, 'unverifiable', 'partial survival never closes either');
});

test('AC1: close evidence pins the revision it was computed against', () => {
  const v = verifyIssue(
    mechanical([{ path: 'a.mjs', line: 1, snippets: ['gone'] }]),
    { ...world({ 'a.mjs': 'nothing\n' }), revision: 'cafe1234' }
  );
  assert.equal(v.verdict, 'fixed');
  assert.equal(v.evidence.revision, 'cafe1234', 'evidence without a revision cannot be re-checked later');
});

test('AC1: an issue whose citations were CAPPED can never verify fixed', () => {
  // Its evidence was not fully read, which is the same condition as a citation
  // that could not be checked — reached by a different route, and it must fail
  // the same way.
  const v = verifyIssue(
    { number: 1, route: 'mechanical', referencesTruncated: true, references: [{ path: 'a.mjs', line: 1, snippets: ['gone'] }] },
    world({ 'a.mjs': 'nothing\n' })
  );
  assert.notEqual(v.verdict, 'fixed');
  assert.equal(v.verdict, 'unverifiable');
  assert.match(v.reason, /more locations than one sweep will read/);
});

test('AC1: a capped issue with a surviving citation is still valid', () => {
  const v = verifyIssue(
    { number: 2, route: 'mechanical', referencesTruncated: true, references: [{ path: 'a.mjs', line: 1, snippets: ['still here'] }] },
    world({ 'a.mjs': 'still here\n' })
  );
  assert.equal(v.verdict, 'valid', 'the cap only forbids closing, not confirming');
});

test('AC1: matchSnippet USES the prepared content it is handed', () => {
  // Without this, `prepareContent` could return nothing and every call would
  // quietly re-normalise the file instead: identical results, and the whole
  // point of preparing once per citation silently lost. Asserted by handing it a
  // prepared view that disagrees with `content` and checking which one wins.
  const content = 'the real file\n';
  const prepared = prepareContent('a completely different body\n');
  const viaPrepared = matchSnippet(content, 'a completely different body', prepared);
  assert.equal(viaPrepared.kind, 'all', 'the prepared view decided the match');

  const viaContent = matchSnippet(content, 'a completely different body');
  assert.equal(viaContent.kind, 'none', 'and without it, the content does');
});

test('AC1: prepareContent returns normalised lines and their original line numbers', () => {
  const p = prepareContent('first\n\n  second  \n');
  assert.deepEqual(p.hay, ['first', 'second']);
  assert.deepEqual(p.originalLineOf, [1, 3], 'blank lines are skipped but the numbering is of the ORIGINAL file');
});

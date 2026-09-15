/**
 * Code-grounded verification (spec §3.3).
 *
 * THE RULE THAT MATTERS MOST: **the cited line number is a hint, never an
 * identity.** `fixed` requires the snippet to be absent from the ENTIRE file.
 * Any unrelated edit above a citation shifts every line below it, so a
 * line-anchored comparison reports `fixed` for live bugs — the single most
 * likely wrong close in this design, and the one that autonomously closes
 * someone's open bug.
 *
 * The aggregation is deliberately conservative in one direction. Across several
 * citations the order is `moved` > `valid` > `fixed`:
 *  - a missing PATH means the claim may still hold somewhere else, so it is a
 *    re-locate rather than a close;
 *  - any citation still present means the issue still has live evidence, so it
 *    is not fixed.
 * Both tie-breaks fail towards NOT closing, because a wrong close removes a real
 * issue from the backlog and nobody re-reads closed issues.
 */

import { execFileSync } from 'node:child_process';

/**
 * Normalise for comparison: trim each line and collapse internal whitespace
 * runs, dropping blank lines.
 *
 * Reindentation and re-wrapping are edits that leave the code's identity intact
 * but defeat a byte comparison, and treating them as deletions would be the same
 * false `fixed` the line-number rule guards against.
 */
function normaliseLines(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l.length > 0);
}

/** Normalised lines plus their original 1-based line numbers, computed once. */
export function prepareContent(content) {
  const originalLineOf = lineIndexOf(content);
  return { hay: normaliseLines(content), originalLineOf };
}

function lineIndexOf(content) {
  const out = [];
  String(content).split('\n').forEach((l, i) => {
    if (l.trim().length > 0) out.push(i + 1);
  });
  return out;
}

/**
 * Match a cited snippet against a file.
 *
 * Snippets in issue bodies are routinely ELIDED EXCERPTS — non-contiguous lines
 * pasted together to show the shape of a defect. Issue #1005 in this repository
 * quotes three lines of `fence()` that sit at 42, 48 and 50 with other code
 * between them. Requiring contiguity called that live code `fixed`, which is the
 * dangerous verdict: an autonomous close of an open security issue. Found by
 * running this against the real backlog, not by a test.
 *
 * So the match is a SUBSEQUENCE in order, and the outcome is three-valued:
 *  - `all`     every snippet line is present, in order → the code is still there
 *  - `none`    no snippet line survives → the code is genuinely gone
 *  - `partial` some lines survive → the code CHANGED, but "changed" is not
 *              "fixed", so this must never close anything
 *
 * @returns {{kind:'all'|'none'|'partial', firstLine:number, matched:number, total:number}}
 */
export function matchSnippet(content, snippet, prepared = null) {
  const needle = normaliseLines(snippet);
  // `prepared` lets a caller normalise a file ONCE and match many excerpts
  // against it. Re-normalising per excerpt made a body repeating fences for one
  // path rebuild the whole file representation each time.
  const hay = prepared?.hay ?? normaliseLines(content);
  if (needle.length === 0) return { kind: 'none', firstLine: -1, matched: 0, total: 0 };

  const originalLineOf = prepared?.originalLineOf ?? lineIndexOf(content);

  // Greedy in-order subsequence walk.
  let hi = 0;
  let matched = 0;
  let firstLine = -1;
  for (const want of needle) {
    while (hi < hay.length && hay[hi] !== want) hi += 1;
    if (hi >= hay.length) break;
    if (firstLine === -1) firstLine = originalLineOf[hi] ?? -1;
    matched += 1;
    hi += 1;
  }

  // A line may also be present out of order; count those so a reordering is
  // `partial` (changed) rather than `none` (gone).
  if (matched < needle.length) {
    // MULTISET, not a Set. Counting each needle line against a set of haystack
    // lines double-counts duplicates: a snippet quoting the same line twice,
    // where the file retains it once, would count two matches and report `all` —
    // a false `valid` on code that is half gone.
    const available = new Map();
    for (const l of hay) available.set(l, (available.get(l) ?? 0) + 1);
    let anywhere = 0;
    for (const l of needle) {
      const left = available.get(l) ?? 0;
      if (left > 0) {
        available.set(l, left - 1);
        anywhere += 1;
      }
    }
    if (anywhere > matched) matched = anywhere;
    if (firstLine === -1 && anywhere > 0) {
      const idx = hay.findIndex((l) => needle.includes(l));
      firstLine = originalLineOf[idx] ?? -1;
    }
  }

  const kind = matched === needle.length ? 'all' : matched === 0 ? 'none' : 'partial';
  return { kind, firstLine, matched, total: needle.length };
}

/**
 * Read `path` AS OF HEAD, not from the working tree.
 *
 * Raised in cross-model review, and it is a false-close path: the contract says
 * verification is against HEAD, but reading the filesystem means a developer's
 * uncommitted edit decides the verdict. Someone part-way through a fix — the
 * snippet deleted locally, nothing committed — would have the tool report
 * `fixed` and hand the write path a close proposal for a bug that is still in
 * the repository.
 *
 * Reading through git also makes a run reproducible: two people on the same
 * commit get the same answer whatever their working trees look like.
 */
function defaultReadFileAtHead(path, rev = 'HEAD', run = execFileSync) {
  return String(run('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
}

/** Whether `path` exists AT HEAD — again, not in the working tree. */
function defaultPathExistsAtHead(path, rev = 'HEAD', run = execFileSync) {
  try {
    run('git', ['cat-file', '-e', `${rev}:${path}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** The commit HEAD points at, so a run can say what it described. */
export function headCommit(run = execFileSync) {
  try {
    return String(run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch {
    return null;
  }
}

/** The commit that last touched `path`, or null when git cannot say. */
function defaultLastCommitFor(path, rev = 'HEAD', run = execFileSync) {
  try {
    return String(run('git', ['log', '-1', '--format=%h', rev, '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Has git EVER tracked this path?
 *
 * This is what separates a real `moved` from text that was never a citation.
 * Issue bodies are full of path-shaped fragments — `lib/plan.mjs` from another
 * repo, `rejection-mining/lib/llm.mjs` shorn of its `packages/` prefix by a
 * `pkg:` label — and treating every one as a deleted file produced 186 false
 * `moved` verdicts out of 379 issues on the first live run. A path this
 * repository has never contained is prose, not a reference.
 */
function defaultEverExisted(path, rev = 'HEAD', run = execFileSync) {
  try {
    // stderr is discarded: git complains loudly about paths outside the
    // repository, and that is an expected answer here ("no"), not a fault worth
    // printing over the report.
    // Scoped to the run's revision rather than `--all`: a path added on another
    // branch after the described commit has not "existed" as far as this run is
    // concerned, and treating it as deleted would report `moved` for a file that
    // never was.
    const out = String(
      run('git', ['log', '--oneline', '-1', rev, '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Verify one classified issue.
 *
 * @param {{number:number, route:string, references:object[]}} classified
 * @param {object} [io] - injected filesystem/git seams
 * @returns {{number:number, route:string, verdict:string, evidence:object|null, reason?:string}}
 */
export function verifyIssue(classified, io = {}) {
  const {
    // `revision` is resolved ONCE by the caller and threaded here. Re-reading
    // `HEAD` per file lets another checkout move the branch mid-run, so the set
    // would claim one revision while holding evidence from another — and cache a
    // verdict from the later revision under the earlier one's hash.
    revision = 'HEAD',
    readFile = (p) => defaultReadFileAtHead(p, revision),
    pathExists = (p) => defaultPathExistsAtHead(p, revision),
    lastCommitFor = (p) => defaultLastCommitFor(p, revision),
    everExisted = (p) => defaultEverExisted(p, revision),
  } = io;

  const { number, route, references = [], referencesTruncated = false } = classified;

  // The model route is judged by the skill, not here. It is returned as
  // `unverified` — explicitly NOT `valid` — so nothing downstream can mistake
  // "we have not looked" for "we looked and it holds".
  if (route === 'model') return { number, route, verdict: 'unverified', evidence: null };
  if (route === 'unverifiable') return { number, route, verdict: 'unverifiable', evidence: null };

  const outcomes = [];
  for (const ref of references) {
    if (!pathExists(ref.path)) {
      // A path git has never tracked is not a deleted file — it is prose that
      // happened to look like a path. Calling it `moved` would flood the report
      // with citations the repository never had.
      if (!everExisted(ref.path)) {
        outcomes.push({ verdict: 'not-a-reference', reason: `${ref.path} has never existed in this repository` });
        continue;
      }
      outcomes.push({ verdict: 'moved', evidence: { path: ref.path, citedLine: ref.line, reason: 'the cited path existed and no longer does' } });
      continue;
    }
    // An EMPTY or whitespace-only fence is discarded before matching. It
    // normalises to zero lines, which the matcher reports as `none`, which maps
    // to `fixed` — a close candidate manufactured from a malformed citation
    // carrying no evidence at all.
    const declared = ref.snippets ?? (ref.snippet ? [ref.snippet] : []);
    const snippets = declared.filter((sn) => String(sn ?? '').trim().length > 0);
    if (snippets.length === 0) {
      outcomes.push({
        verdict: 'unverifiable',
        reason: declared.length > 0
          ? `${ref.path} is cited with an empty excerpt — nothing to compare`
          : `no snippet to compare for ${ref.path}`,
      });
      continue;
    }
    let content;
    try {
      content = readFile(ref.path);
    } catch (err) {
      outcomes.push({ verdict: 'unverifiable', reason: `${ref.path} is unreadable: ${err.code ?? err.message}` });
      continue;
    }
    // EVERY excerpt attached to this citation is evaluated, and the best
    // outcome wins: a single surviving excerpt means the cited code is still
    // there, whatever happened to the others. Judging only one excerpt is how an
    // issue that quotes a location twice — once removed, once live — verifies
    // `fixed` and gets closed.
    const prepared = prepareContent(content);
    const matches = snippets.map((sn) => matchSnippet(content, sn, prepared));
    const best = matches.find((x) => x.kind === 'all')
      ?? matches.find((x) => x.kind === 'partial')
      ?? matches[0];
    const m = best;
    if (m.kind === 'none') {
      outcomes.push({
        verdict: 'fixed',
        evidence: {
          path: ref.path,
          citedLine: ref.line,
          revision,
          // NAMED for what it is. This is the last commit to touch the path, not
          // necessarily the one that removed the cited lines — finding that
          // would need a pickaxe search per citation. Calling it the removing
          // commit in close evidence would be a claim the tool never checked.
          lastCommitTouchingPath: lastCommitFor(ref.path),
          reason: snippets.length > 1
            ? `no line of any of the ${snippets.length} cited excerpts survives anywhere in the file`
            : 'no line of the cited snippet survives anywhere in the file',
        },
      });
    } else if (m.kind === 'partial') {
      // The code CHANGED, and "changed" is not "fixed". Concluding otherwise
      // here is how an elided excerpt or a partial refactor closes a live issue.
      outcomes.push({
        verdict: 'unverifiable',
        reason: `only ${m.matched} of ${m.total} cited line(s) survive in ${ref.path} — changed, but not demonstrably fixed`,
      });
    } else {
      outcomes.push({
        verdict: 'valid',
        evidence: {
          path: ref.path,
          citedLine: ref.line,
          foundAtLine: m.firstLine,
          movedWithinFile: ref.line != null && m.firstLine !== ref.line,
        },
      });
    }
  }

  // PRECEDENCE, and every step of it fails towards NOT closing:
  //   moved > valid > unverifiable > fixed
  //
  // `unverifiable` outranking `fixed` is the subtle one, raised in cross-model
  // review. An issue citing two locations — one whose snippet is gone, one with
  // no excerpt or temporarily unreadable — has NOT been shown to be fixed: one
  // citation could not be checked at all. Returning `fixed` there would close on
  // incomplete evidence, which is the same defect as closing on a shifted line,
  // reached by a different route.
  // An issue whose citations were CAPPED has not been fully read, so it can
  // never verify `fixed` — the same rule as a citation that could not be
  // checked, reached by a different route.
  const order = referencesTruncated ? ['moved', 'valid', 'unverifiable'] : ['moved', 'valid', 'unverifiable', 'fixed'];
  for (const want of order) {
    const hit = outcomes.find((o) => o.verdict === want);
    if (!hit) continue;
    if (want === 'unverifiable') {
      return { number, route, verdict: 'unverifiable', evidence: null, reason: hit.reason ?? 'a citation could not be checked' };
    }
    return { number, route, verdict: want, evidence: hit.evidence ?? null };
  }

  const why = referencesTruncated
    ? 'the issue cites more locations than one sweep will read; its evidence is incomplete'
    : (outcomes.find((o) => o.reason)?.reason ?? 'no citation could be checked');
  return { number, route, verdict: 'unverifiable', evidence: null, reason: why };
}

/** Verify a whole classified backlog. */
export function verifyAll(classified, io = {}) {
  return classified.map((c) => verifyIssue(c, io));
}

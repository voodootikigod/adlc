/**
 * Verifiability routing (spec §3.2).
 *
 * Routing decides HOW an issue will be checked; §3.3 decides what it concludes.
 * Keeping the two apart is what lets `unverifiable` be a first-class outcome
 * instead of a synonym for "still valid" — the false green this package exists
 * to detect.
 *
 *   mechanical   — the body carries a parseable code reference
 *   model        — a checkable claim about code, but nothing parseable
 *   unverifiable — no checkable claim about code at all
 */

/**
 * A repo-relative path: at least one `/`, a file extension, no spaces, and no
 * scheme. Anchored to a backtick or word boundary so prose does not produce
 * accidental matches.
 */
const PATH = String.raw`(?![a-z]+:\/\/)([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+)`;
const PATH_WITH_OPTIONAL_LINE = new RegExp(`${PATH}(?::(\\d+))?`, 'g');

/**
 * Cap on citations honoured from a single issue body.
 *
 * Every citation costs synchronous git subprocesses — an existence check, a read
 * for the hash, a read for verification. An issue body is untrusted input, so an
 * unbounded count lets one issue citing thousands of distinct `path:line`s make a
 * sweep appear hung. Beyond the cap the issue is marked truncated, and §3.3's
 * precedence then forbids it ever verifying `fixed`: evidence that was not fully
 * read cannot close anything.
 */
export const MAX_REFERENCES_PER_ISSUE = 50;

/**
 * Cap on fenced excerpts honoured from a single issue body.
 *
 * The reference cap counts distinct `path:line` keys, so repeated citations of
 * ONE path merged excerpts without limit — and verification matches once per
 * excerpt. A body repeating thousands of fences for one path slipped straight
 * past the reference cap while `referencesTruncated` stayed false.
 */
export const MAX_SNIPPETS_PER_ISSUE = 200;

/** A fenced block, with the offset it starts at so it can be attributed. */
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

/**
 * Signals that an issue makes a claim ABOUT CODE even without a parseable
 * reference: a backticked identifier, a call-shaped token, or a bare filename.
 *
 * Deliberately narrow. Over-routing to `model` is the expensive failure — every
 * issue then costs a model call and the cheap mechanical path never runs — so a
 * version string or a date must not qualify.
 */
const CODE_CLAIM = [
  /`[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\)`/,        // `fence()`
  /`[A-Za-z_$][A-Za-z0-9_$.]*`/,                  // `resolveModel`, `res.code`
  /\b[A-Za-z_$][A-Za-z0-9_$]*\(\)/,               // fence() unbacktick'd
  /\b[\w.-]+\.(mjs|js|ts|tsx|jsx|json|yml|yaml|py|go|rs|sh)\b/, // a bare filename
];

/**
 * A citation is repo-relative. `../core/index.mjs` is written from inside some
 * other file's directory and an absolute path belongs to whoever's machine
 * wrote it; neither names a file in THIS repository, and handing them to git
 * produces only noise.
 */
function isRepoRelative(path) {
  // No leading-slash check here: `/` is outside the path character class, so a
  // captured path can never begin with one. Absolute paths are rejected by the
  // preceding-character test at the match site, which is the only place that
  // CAN see the slash. A second check here would be unreachable code.
  const segments = path.split('/');
  return !segments.includes('..') && !segments.includes('.');
}

/** Strip fenced blocks and URLs so they cannot seed path or claim matches. */
function maskNonProse(body) {
  return String(body ?? '')
    .replace(FENCE, (m) => ' '.repeat(m.length))
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => ' '.repeat(m.length));
}

/**
 * Every code reference the body cites, deduped by `path:line`.
 *
 * A fenced block is attributed to the NEAREST PRECEDING path mention, which is
 * the shape the audit-filed issues use (a `**Location**` line, then the snippet).
 * A fence with no preceding path is NOT a reference: it has no file to be
 * checked against, and inventing one would manufacture a citation the issue
 * never made.
 *
 * @param {string} body
 * @returns {{path:string, line:number|null, snippet:string|null}[]}
 */
export function parseReferences(body) {
  const text = String(body ?? '');
  const masked = maskNonProse(text);

  // Paths, in document order, with their offsets (from the masked text, so a
  // path inside a URL or a fence never counts).
  const paths = [];
  for (const m of masked.matchAll(PATH_WITH_OPTIONAL_LINE)) {
    // Filtered HERE, before fence attribution: a `../core/index.mjs` mention
    // sitting just above a snippet would otherwise claim that snippet and then
    // be dropped, leaving the real citation below it with nothing to compare.
    // The leading `/` of an absolute path is outside the character class, so
    // `/etc/passwd.txt` matches as `etc/passwd.txt`. Look at what preceded the
    // match rather than at the match alone.
    if (masked[m.index - 1] === '/') continue;
    if (!isRepoRelative(m[1])) continue;
    paths.push({ path: m[1], line: m[2] ? Number(m[2]) : null, at: m.index });
  }
  if (paths.length === 0) return [];

  // Fences, from the ORIGINAL text, attributed to the nearest preceding path.
  for (const f of text.matchAll(FENCE)) {
    let owner = null;
    for (const p of paths) {
      if (p.at < f.index) owner = p;
      else break;
    }
    // EVERY excerpt is kept, not just the first. An issue that quotes one
    // location twice — a removed excerpt and a still-live one — would otherwise
    // lose the live excerpt and verify `fixed`, which is a false close.
    if (owner) (owner.snippets ??= []).push(f[1].trim());
  }

  const seen = new Map();
  const out = [];
  let snippetBudget = MAX_SNIPPETS_PER_ISSUE;

  /** Take excerpts within budget, dropping exact duplicates. */
  const takeSnippets = (target, candidates) => {
    for (const sn of candidates) {
      if (snippetBudget <= 0) {
        out.truncated = true;
        return;
      }
      // Identical excerpts are redundant work, not extra evidence.
      if (target.includes(sn)) continue;
      target.push(sn);
      snippetBudget -= 1;
    }
  };
  for (const p of paths) {
    const key = `${p.path}:${p.line ?? ''}`;
    const existing = seen.get(key);
    if (existing) {
      // A repeated citation MERGES its excerpts rather than being dropped:
      // dedupe must not discard evidence — within the excerpt budget.
      takeSnippets(existing.snippets, p.snippets ?? []);
      continue;
    }
    if (out.length >= MAX_REFERENCES_PER_ISSUE) {
      out.truncated = true;
      break;
    }
    const ref = { path: p.path, line: p.line, snippets: [] };
    takeSnippets(ref.snippets, p.snippets ?? []);
    seen.set(key, ref);
    out.push(ref);
  }
  return out;
}

/**
 * Route one issue.
 *
 * @param {{number:number, title?:string, body?:string, labels?:string[]}} issue
 * @returns {{number:number, route:'mechanical'|'model'|'unverifiable', references:object[]}}
 */
export function classifyIssue(issue) {
  const body = String(issue?.body ?? '');
  const title = String(issue?.title ?? '');
  const references = parseReferences(body);
  if (references.length > 0) {
    return {
      number: issue?.number,
      route: 'mechanical',
      references,
      referencesTruncated: references.truncated === true,
    };
  }

  const prose = `${title}\n${maskNonProse(body)}`;
  const claims = CODE_CLAIM.some((re) => re.test(prose));
  return { number: issue?.number, route: claims ? 'model' : 'unverifiable', references: [] };
}

/**
 * Route a whole backlog, and count the routes.
 *
 * The counts are what §3.9 leads the report with: a sweep that mechanically
 * verified 4% is still useful, but that number must sit next to the conclusions
 * or a thin run reads as a thorough one.
 */
export function classifyAll(issues) {
  const classified = issues.map(classifyIssue);
  const routeCounts = { mechanical: 0, model: 0, unverifiable: 0 };
  for (const c of classified) routeCounts[c.route] += 1;
  return { classified, routeCounts };
}

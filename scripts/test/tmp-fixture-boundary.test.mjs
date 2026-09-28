import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * Suite directories, mirroring scripts/test/ticket-store-boundary.test.mjs.
 * A fixture directory minted anywhere else is production code creating a real
 * temp dir (atomic writes, clones, locks) and is deliberately out of scope.
 */
const SUITE_DIRECTORIES = new Set(['test', 'cli-test', 'adapter-test']);

/**
 * What this guard covers: fixture directories minted by a mkdtempSync call in
 * a suite file (any .mjs under a suite directory). Each such call must bind its
 * result and pair it with a removal, as unremovedFixtures() defines.
 *
 * What it does not cover: a directory made any other way (mkdirSync under
 * tmpdir(), fs.promises.mkdtemp, a shell mktemp) and any file outside a suite
 * directory. Fixtures from @adlc/core/test-kit (tmp(t), gitRepo(t)) are not
 * scanned; the kit refuses to create one without a test context whose after()
 * hook removes it.
 *
 * ALLOWLIST would excuse a leaking file by path. It must stay empty: the test
 * below asserts its size is 0, so a leaking suite file is fixed, never listed.
 */
const ALLOWLIST = new Set([]);

/** @param {string} name directory entry name */
export function isSuiteDirectory(name) {
  return SUITE_DIRECTORIES.has(name);
}

/**
 * Every .mjs file that lives inside a suite directory, at any depth.
 * Helper modules count: packages/prosecute/test/helpers.mjs is not a
 * *.test.mjs file, yet its exported factories mint a fixture per call.
 */
function suiteFiles(path, inSuite = false) {
  const files = [];
  if (!existsSync(path)) return files;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...suiteFiles(full, inSuite || isSuiteDirectory(entry.name)));
    else if (inSuite && entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

/** Line number (1-based) of a character offset, for actionable failures. */
function lineOf(body, index) {
  return body.slice(0, index).split('\n').length;
}

/**
 * Names of local one-argument helpers whose body removes their own parameter,
 * e.g. `const cleanup = (p) => rmSync(p, { recursive: true, force: true })`.
 * Calling one of these with a fixture binding counts as removing it.
 */
export function removalHelpers(body) {
  const names = new Set();
  const arrow = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>\s*\{?([^;}]*)/g;
  const declared = /function\s+(\w+)\s*\(\s*(\w+)\s*\)\s*\{([\s\S]{0,400}?)\n\}/g;
  for (const re of [arrow, declared]) {
    for (const match of body.matchAll(re)) {
      const [, name, param, tail] = match;
      if (new RegExp(String.raw`rmSync\s*\(\s*${param}\b`).test(tail)) names.add(name);
    }
  }
  return names;
}

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await']);

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_PUNCTUATION = /[(,=:[!&|?{};+\-*%<>~^]/;

/**
 * The source with every comment and every string, template, and regex literal
 * body replaced by spaces. Newlines are kept and the length is unchanged, so
 * offsets and line numbers in the result are those of the original. Code in a
 * template `${...}` interpolation is kept: it runs.
 */
export function stripNonCode(source) {
  const out = [...source];
  const blank = (at) => { if (at < out.length && out[at] !== '\n') out[at] = ' '; };
  const interpolations = []; // unclosed `{` count inside each open `${`
  let lastSignificant = '';
  let lastWord = '';
  let i = 0;

  const skipQuoted = (quote) => {
    for (i += 1; i < source.length && source[i] !== quote && source[i] !== '\n'; i += 1) {
      if (source[i] === '\\') { blank(i); i += 1; }
      blank(i);
    }
  };
  // Leaves i on the closing backtick (true) or on the `{` of an opened `${` (false).
  const skipTemplate = () => {
    for (; i < source.length; i += 1) {
      if (source[i] === '\\') { blank(i); i += 1; blank(i); continue; }
      if (source[i] === '`') return true;
      if (source[i] === '$' && source[i + 1] === '{') {
        blank(i); blank(i + 1); i += 1;
        interpolations.push(0);
        return false;
      }
      blank(i);
    }
    return true;
  };
  const skipRegex = () => {
    let inClass = false;
    for (i += 1; i < source.length && source[i] !== '\n'; i += 1) {
      const c = source[i];
      if (c === '\\') { blank(i); i += 1; blank(i); continue; }
      if (c === '/' && !inClass) return;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      blank(i);
    }
  };
  const blankUntil = (stop) => {
    for (; i < stop; i += 1) blank(i);
    i -= 1;
  };
  const resumeTemplate = () => {
    lastSignificant = skipTemplate() ? '`' : '{';
    lastWord = '';
  };

  for (; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blankUntil(end === -1 ? source.length : end);
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      blankUntil(end === -1 ? source.length : end + 2);
      continue;
    }
    if (c === "'" || c === '"') {
      skipQuoted(c);
      lastSignificant = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      i += 1;
      resumeTemplate();
      continue;
    }
    if (c === '/' && (lastSignificant === '' || REGEX_PRECEDING_PUNCTUATION.test(lastSignificant) || REGEX_PRECEDING_WORDS.has(lastWord))) {
      skipRegex();
      lastSignificant = '/';
      lastWord = '';
      continue;
    }
    const depth = interpolations.length - 1;
    if (depth >= 0 && c === '{') interpolations[depth] += 1;
    if (depth >= 0 && c === '}') {
      if (interpolations[depth] === 0) {
        interpolations.pop();
        blank(i);
        i += 1;
        resumeTemplate();
        continue;
      }
      interpolations[depth] -= 1;
    }
    if (/\s/.test(c)) continue;
    const continuesWord = /[\w$]/.test(c) && /[\w$]/.test(source[i - 1] ?? '');
    lastWord = /[\w$]/.test(c) ? (continuesWord ? lastWord + c : c) : '';
    lastSignificant = c;
  }
  return out.join('');
}

/** Control-flow keywords whose `(...) {` block is not a function body. */
const BLOCK_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/** Whether the `{` at `open` starts a function body. `code` is stripped source. */
function opensFunctionBody(code, open) {
  const head = code.slice(0, open).trimEnd();
  if (head.endsWith('=>')) return true;
  if (!head.endsWith(')')) return false;
  let depth = 0;
  let paren = head.length - 1;
  for (; paren >= 0; paren -= 1) {
    if (head[paren] === ')') depth += 1;
    else if (head[paren] === '(' && --depth === 0) break;
  }
  const callee = head.slice(0, Math.max(0, paren)).trimEnd();
  if (/\bfunction\s*\*?\s*[\w$]*$/.test(callee)) return true;
  const word = callee.match(/([\w$]+)$/);
  return word !== null && !BLOCK_KEYWORDS.has(word[1]);
}

/**
 * The text of the innermost function body enclosing `index`, or null at
 * module scope. `code` is stripped source, so every brace is structural.
 */
function enclosingFunctionBody(code, index) {
  const opens = [];
  for (let at = 0; at < index; at += 1) {
    if (code[at] === '{') opens.push(at);
    else if (code[at] === '}') opens.pop();
  }
  const open = opens.reverse().find((position) => opensFunctionBody(code, position));
  if (open === undefined) return null;
  let depth = 0;
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === '{') depth += 1;
    else if (code[at] === '}' && --depth === 0) return code.slice(open, at + 1);
  }
  return code.slice(open);
}

/**
 * Whether the function body `fn` hands the binding `name` to its caller:
 * directly, through a call that returns the same path (`return
 * realpathSync(dir)`), or as a member of a returned object or array literal.
 * A call that merely uses the fixture (`return run(dir)`) does not hand it out.
 */
function returnsBinding(fn, name) {
  return [
    String.raw`\breturn\s+${name}\s*(?:[;})\]\n]|$)`,
    String.raw`\breturn\s+(?:realpathSync|resolve|normalize)\s*\(\s*${name}\s*\)`,
    String.raw`\breturn\s*\{(?:[^}]*[,:])?\s*${name}\s*[,}]`,
    String.raw`\breturn\s*\[[^\]]*\b${name}\b`,
  ].some((shape) => new RegExp(shape).test(fn));
}

/**
 * Fixture bindings that nothing in the file ever removes.
 *
 * Pairing is per BINDING, never per file: a file-level "does an rmSync appear
 * anywhere" test passes a file whose only rmSync calls delete a subdirectory of
 * the fixture so a symlink can take its place — setup, not cleanup — while every
 * fixture root survives the run.
 *
 * Compliant shapes, per the ticket contract:
 *   (a) rmSync(X ...)                      direct removal
 *   (b) cleanup(X)                         a local one-arg helper that rmSyncs its param
 *   (c) dirs.add(X) / dirs.push(X)         registration drained by an after() hook
 * An unassigned call is non-compliant by definition: nothing can remove a value
 * that was never bound to a name. A fixture a helper function returns to its
 * caller is compliant only through (c) or a t.after removal inside that helper.
 *
 * Comments and string, template, and regex literal text are ignored.
 */
export function unremovedFixtures(source) {
  // Comments and literal text are neither calls nor removals: scanning them
  // would report a documented `mkdtempSync(` and accept a quoted `rmSync(dir`.
  const body = stripNonCode(source);
  const helpers = removalHelpers(body);
  const drains = /after\s*\(/.test(body) && /rmSync\s*\(/.test(body);
  const count = (text, re) => (text.match(re) || []).length;
  const leaks = [];

  /**
   * Removal SITES for a name in `text`, not merely "does one exist". `dir` and
   * `root` are the common fixture names here, so a file-wide existence test
   * lets one cleaned fixture launder every later fixture that reuses the name.
   * Counting keeps removals in step with creations.
   *
   * Registration is the exception and stays uncounted: one collection drained
   * by an after() hook covers any number of members, so a single add() site
   * inside a helper legitimately serves every call.
   */
  const removalSites = (name, text = body) =>
    count(text, new RegExp(String.raw`rmSync\s*\(\s*${name}\b`, 'g'))
    + [...helpers].reduce((n, helper) => n + count(text, new RegExp(String.raw`\b${helper}\s*\(\s*${name}\s*\)`, 'g')), 0);

  const registered = (name, text = body) =>
    drains && new RegExp(String.raw`\w+\s*\.\s*(?:add|push)\s*\(\s*${name}\b`).test(text);

  const seen = new Map();
  for (const match of body.matchAll(/mkdtempSync\s*\(/g)) {
    const before = body.slice(Math.max(0, match.index - 120), match.index);
    // A declaration, or a bare assignment such as `dir = mkdtempSync(...)` in a
    // before() hook to a `let dir;` declared at describe() scope. Member
    // assignments (`obj.dir = ...`) stay unbound: nothing pairs them.
    const binding = before.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?$/)
      ?? before.match(/(?:^|[;{}()\n,])\s*(\w+)\s*=\s*(?:await\s+)?$/);
    const line = lineOf(body, match.index);

    if (!binding) {
      leaks.push(`line ${line}: mkdtempSync result is never bound to a name, so nothing can remove it`);
      continue;
    }
    const name = binding[1];

    // A factory: one creation site serves every call, so removal sites at the
    // call sites cannot be counted against it, and one caller that skips
    // removal leaks on every call. Only a removal the factory itself registers
    // (t.after, or a registry drained by after()) covers every call.
    const factory = enclosingFunctionBody(body, match.index);
    if (factory !== null && returnsBinding(factory, name)) {
      const hooked = /after\s*\(/.test(factory) && removalSites(name, factory) > 0;
      if (registered(name, factory) || hooked) continue;
      leaks.push(
        `line ${line}: fixture "${name}" is returned from a helper, so its removal must be registered `
          + 'inside that helper (t.after, or a registry drained by an after() hook)',
      );
      continue;
    }

    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    if (registered(name) || nth <= removalSites(name)) continue;
    leaks.push(
      `line ${line}: fixture "${name}" is never removed (no rmSync, cleanup helper, or registered after() hook)`,
    );
  }
  return leaks;
}

/**
 * This guard's own fixtures are SOURCE TEXT — string literals fed to the
 * detector to prove it bites — not calls that ever create a directory. Scanning
 * itself would report every one of them. The exemption is by exact path, so a
 * file that merely looks similar is still scanned (proven below).
 */
const SELF = 'scripts/test/tmp-fixture-boundary.test.mjs';

export function leakingSuiteFiles(files) {
  return files
    .map((path) => ({ name: relative(ROOT, path).replaceAll('\\', '/'), body: readFileSync(path, 'utf8') }))
    .filter(({ name, body }) => name !== SELF && body.includes('mkdtempSync'))
    .map(({ name, body }) => ({ name, leaks: unremovedFixtures(body) }))
    .filter(({ leaks }) => leaks.length > 0);
}

function scanRepo() {
  return leakingSuiteFiles(['packages', 'plugins', 'scripts', 'apps'].flatMap((dir) => suiteFiles(join(ROOT, dir))));
}

test('no un-allowlisted suite file leaks a fixture directory', () => {
  const offenders = scanRepo().map(({ name, leaks }) => `${name}\n    ${leaks.join('\n    ')}`);
  const unexpected = offenders.filter((entry) => !ALLOWLIST.has(entry.split('\n')[0]));
  assert.deepEqual(
    unexpected,
    [],
    `these suite files mint fixture directories nothing removes — register cleanup `
      + `(an after() hook draining a registry, or rmSync on the binding):\n  ${unexpected.join('\n  ')}`,
  );
});

test('the allowlist may only shrink', () => {
  assert.equal(
    ALLOWLIST.size,
    0,
    'ALLOWLIST must remain empty: a suite file that leaks a mkdtempSync fixture is fixed, not exempted',
  );
  const stillLeaking = new Set(scanRepo().map(({ name }) => name));
  const stale = [...ALLOWLIST].filter((name) => !stillLeaking.has(name)).sort();
  assert.deepEqual(
    stale,
    [],
    `these files are compliant now and must be removed from ALLOWLIST so the ratchet keeps tightening: ${stale.join(', ')}`,
  );
});

test('the detector bites on a planted leak', () => {
  const planted = `
    import { mkdtempSync } from 'node:fs';
    test('x', () => {
      const dir = mkdtempSync(join(tmpdir(), 'planted-'));
      assert.ok(dir);
    });
  `;
  const leaks = unremovedFixtures(planted);
  assert.equal(leaks.length, 1, 'an unremoved fixture binding must be reported');
  assert.match(leaks[0], /fixture "dir" is never removed/);
  assert.match(leaks[0], /line 4/, 'the failure must name the line');
});

test('an unassigned mkdtempSync call is a leak by definition', () => {
  const inline = `const mkRepo = () => mkdtempSync(join(tmpdir(), 'x-'));`;
  const leaks = unremovedFixtures(inline);
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /never bound to a name/);
});

test('each compliant shape in the contract is accepted', () => {
  const direct = `
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    rmSync(dir, { recursive: true, force: true });
  `;
  assert.deepEqual(unremovedFixtures(direct), [], 'direct rmSync on the binding');

  const helper = `
    const cleanup = (p) => rmSync(p, { recursive: true, force: true });
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    cleanup(dir);
  `;
  assert.deepEqual(unremovedFixtures(helper), [], 'a local one-arg removal helper');

  const registry = `
    const dirs = new Set();
    after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    dirs.add(dir);
  `;
  assert.deepEqual(unremovedFixtures(registry), [], 'registration drained by an after() hook');
});

test('a registry that is never drained is still a leak', () => {
  // Registration only counts because an after() hook removes the members. Without
  // the hook the Set is just a list of directories that outlive the run.
  const undrained = `
    const dirs = new Set();
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    dirs.add(dir);
  `;
  assert.equal(unremovedFixtures(undrained).length, 1);
});

test('one cleaned fixture does not launder a second fixture of the same name', () => {
  // `dir` and `root` are the two most common fixture names in this repo, so a
  // file-wide "is there an rmSync(dir) anywhere" test would mark every later
  // `const dir = mkdtempSync(...)` clean because an earlier one was removed.
  // Removal sites must therefore keep pace with creation sites.
  const reused = `
    test('a', () => {
      const dir = mkdtempSync(join(tmpdir(), 'x-'));
      rmSync(dir, { recursive: true, force: true });
    });
    test('b', () => {
      const dir = mkdtempSync(join(tmpdir(), 'x-'));
      assert.ok(dir);
    });
  `;
  const leaks = unremovedFixtures(reused);
  assert.equal(leaks.length, 1, 'the second, uncleaned "dir" must still be reported');
  assert.match(leaks[0], /line 7/, 'and it must name the uncleaned site, not the cleaned one');

  // The registry shape stays N-safe: one drained collection covers any number
  // of fixtures, so it must not be penalised by the same counting rule.
  const manyViaRegistry = `
    const dirs = new Set();
    after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    test('a', () => { const dir = mkdtempSync(join(tmpdir(), 'x-')); dirs.add(dir); });
    test('b', () => { const dir = mkdtempSync(join(tmpdir(), 'x-')); dirs.add(dir); });
  `;
  assert.deepEqual(unremovedFixtures(manyViaRegistry), [], 'a drained registry covers every member');
});

test('the scan tolerates a missing top-level directory', () => {
  // scanRepo walks a fixed list; a repo without one of them must fail with a
  // clear empty result, never an ENOENT crash inside the test runner.
  assert.deepEqual(suiteFiles(join(ROOT, "no-such-directory-here")), []);
});

test('a same-file rmSync on a DIFFERENT binding does not launder a leak', () => {
  // The shape that motivated per-binding pairing: rmSync deletes a
  // subdirectory of the fixture as test setup, and the fixture root itself
  // survives. A file-level "contains rmSync" check passes this; pairing catches it.
  const setupNotCleanup = `
    const root = mkdtempSync(join(tmpdir(), 'a-'));
    const dir = join(root, '.adlc');
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(shadow, dir);
  `;
  const leaks = unremovedFixtures(setupNotCleanup);
  assert.equal(leaks.length, 1, 'the unremoved root must still be reported');
  assert.match(leaks[0], /fixture "root" is never removed/);
});

test('production mkdtempSync call sites are out of scope', () => {
  const scanned = ['packages', 'plugins'].flatMap((dir) => suiteFiles(join(ROOT, dir)))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'));

  for (const production of [
    'packages/tickets/lib/edit.mjs',
    'packages/autopilot/lib/lock.mjs',
    'packages/gate-fuzzing/lib/clone.mjs',
    'packages/fleet/bin/fleet.mjs',
  ]) {
    assert.ok(!scanned.includes(production), `${production} is production code and must not be scanned`);
  }
  assert.ok(
    scanned.some((name) => name.startsWith('packages/prosecute/test/')),
    'suite directories must still be scanned',
  );
  assert.equal(isSuiteDirectory('test'), true);
  assert.equal(isSuiteDirectory('lib'), false);
  assert.equal(isSuiteDirectory('bin'), false);
});

test('a bare assignment binds the fixture and still has to pair with a removal', () => {
  const cleaned = `
    describe('suite', () => {
      let dir;
      before(() => { dir = mkdtempSync(join(tmpdir(), 'a-')); });
      after(() => rmSync(dir, { recursive: true, force: true }));
    });
  `;
  assert.deepEqual(unremovedFixtures(cleaned), [], 'a describe-scope binding assigned in before() and removed in after()');

  const uncleaned = `
    describe('suite', () => {
      let dir;
      before(() => { dir = mkdtempSync(join(tmpdir(), 'a-')); });
    });
  `;
  const leaks = unremovedFixtures(uncleaned);
  assert.equal(leaks.length, 1, 'the bare assignment without a removal must be reported');
  assert.match(leaks[0], /fixture "dir" is never removed/);
  assert.match(leaks[0], /line 4/);
});

test('a member assignment is not a binding', () => {
  const member = `
    const ctx = {};
    ctx.dir = mkdtempSync(join(tmpdir(), 'a-'));
    rmSync(dir, { recursive: true, force: true });
  `;
  const leaks = unremovedFixtures(member);
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /never bound to a name/);
});

test('mkdtempSync text inside a comment or a string literal is not a call', () => {
  const commented = `
    // wraps mkdtempSync() and registers cleanup
    /* dir = mkdtempSync(join(tmpdir(), 'x-'))
       spans lines */
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    rmSync(dir, { recursive: true, force: true });
  `;
  assert.deepEqual(unremovedFixtures(commented), [], 'commented calls are not fixtures');

  const quoted = `
    const single = 'dir = mkdtempSync(x)';
    const double = "dir = mkdtempSync(x)";
    const planted = \`
      dir = mkdtempSync(x);
    \`;
  `;
  assert.deepEqual(unremovedFixtures(quoted), [], 'quoted calls are not fixtures');
});

test('a quoted removal does not launder a real fixture, and line numbers survive stripping', () => {
  const quotedRemoval = `
    /* a block comment
       across three lines */
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    const note = 'rmSync(dir, { recursive: true })';
    // rmSync(dir)
  `;
  const leaks = unremovedFixtures(quotedRemoval);
  assert.equal(leaks.length, 1, 'removal text in a string or comment is not a removal');
  assert.match(leaks[0], /fixture "dir" is never removed/);
  assert.match(leaks[0], /line 4/, 'the reported line must match the unstripped source');
});

test('code inside a template interpolation and after a regex literal is still scanned', () => {
  const interpolated = 'const label = `at ${mkdtempSync(join(tmpdir(), "a-"))}`;';
  const interpolatedLeaks = unremovedFixtures(interpolated);
  assert.equal(interpolatedLeaks.length, 1, 'an interpolation is code');
  assert.match(interpolatedLeaks[0], /never bound to a name/);

  const afterRegex = `
    const quote = /['"]/;
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
  `;
  const regexLeaks = unremovedFixtures(afterRegex);
  assert.equal(regexLeaks.length, 1, 'a quote inside a regex literal must not open a string');
  assert.match(regexLeaks[0], /fixture "dir" is never removed/);
});

test('a fixture returned from a factory is removed only when the factory registers the removal', () => {
  // One creation site serves every call, so callers that each rmSync the result
  // cannot be counted against it: one caller that skips removal leaks per call.
  const factory = `
    function makeDirs() {
      const repoDir = mkdtempSync(join(tmpdir(), 'repo-'));
      const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
      return { repoDir, outsideDir };
    }
    test('a', () => {
      const { repoDir, outsideDir } = makeDirs();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    });
    test('b', () => {
      const { repoDir } = makeDirs();
      rmSync(repoDir, { recursive: true, force: true });
    });
  `;
  const leaks = unremovedFixtures(factory);
  assert.equal(leaks.length, 2, 'both returned fixtures must be reported');
  assert.match(leaks[0], /line 3: fixture "repoDir" is returned from a helper/);
  assert.match(leaks[1], /line 4: fixture "outsideDir" is returned from a helper/);

  const arrowFactory = `
    const mk = () => {
      const dir = mkdtempSync(join(tmpdir(), 'a-'));
      return dir;
    };
    test('a', () => { const dir = mk(); rmSync(dir, { recursive: true, force: true }); });
  `;
  assert.equal(unremovedFixtures(arrowFactory).length, 1, 'an arrow-function factory is a factory too');

  const hooked = `
    function makeDir(t) {
      const dir = mkdtempSync(join(tmpdir(), 'a-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      return dir;
    }
  `;
  assert.deepEqual(unremovedFixtures(hooked), [], 'a factory that registers t.after removal');

  const registry = `
    const dirs = [];
    after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    function makeDir() {
      const dir = mkdtempSync(join(tmpdir(), 'a-'));
      dirs.push(dir);
      return dir;
    }
  `;
  assert.deepEqual(unremovedFixtures(registry), [], 'a factory that registers into a drained registry');

  const removedAfterReturn = `
    function makeDir() {
      const dir = mkdtempSync(join(tmpdir(), 'a-'));
      return dir;
    }
    after(() => rmSync(dir, { recursive: true, force: true }));
  `;
  assert.equal(unremovedFixtures(removedAfterReturn).length, 1, 'a removal outside the factory does not count');

  const notReturned = `
    function check() {
      const dir = mkdtempSync(join(tmpdir(), 'a-'));
      try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  `;
  assert.deepEqual(unremovedFixtures(notReturned), [], 'a helper that removes its own fixture is not a factory');
});

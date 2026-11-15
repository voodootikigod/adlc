// Tests for file emission shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLintDescriptor, buildCheckScript, buildSkillStub, buildSpecGapLine, planEmissions, collectIncludeGlobs } from '../lib/emit.mjs';

// ---------------------------------------------------------------------------
// buildLintDescriptor
// ---------------------------------------------------------------------------
test('buildLintDescriptor: returns valid JSON descriptor shape', () => {
  const findings = [{ desc: 'Found "TODO" comment in production code', category: 'security' }];
  const { path, content } = buildLintDescriptor('todo-in-prod', findings);

  assert(path.endsWith('.lint.json'));
  const parsed = JSON.parse(content);
  assert.strictEqual(typeof parsed.name, 'string');
  assert.strictEqual(typeof parsed.pattern, 'string');
  assert(Array.isArray(parsed.paths));
  assert.strictEqual(typeof parsed.message, 'string');
  assert(parsed.paths.includes('**'));
});

test('buildLintDescriptor: pattern is escaped literal when literal found', () => {
  const findings = [{ desc: 'Use "strict" mode everywhere' }];
  const { content } = buildLintDescriptor('strict-mode', findings);
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.pattern, 'strict');
});

// ---------------------------------------------------------------------------
// buildCheckScript
// ---------------------------------------------------------------------------
test('buildCheckScript: returns runnable .mjs script', () => {
  const findings = [{ desc: 'Found "eval" usage in code', category: 'security' }];
  const { path, content } = buildCheckScript('no-eval', findings);

  assert(path.endsWith('.mjs'));
  assert(content.includes('process.exit(0)'));
  assert(content.includes('process.exit(2)'));
  assert(content.includes('import'));
  assert(content.includes('grep'));
});

test('buildCheckScript: script name matches cluster name', () => {
  const findings = [{ desc: 'test finding', category: 'security' }];
  const { path } = buildCheckScript('my-cluster', findings);
  assert.strictEqual(path, 'check-my-cluster.mjs');
});

// F1 regression: the generated gate must NOT trip on itself. The script file
// literally contains the pattern string (PATTERN constant + header comment), so
// a naive grep over the repo would always find a match and fail forever.
test('buildCheckScript: generated gate exits 0 when no REAL occurrences exist (does not trip on itself)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-gate-self-'));
  try {
    // A repo with NO genuine occurrence of the pattern in source.
    const lessonsDir = join(dir, '.adlc', 'lessons');
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(join(dir, 'src.mjs'), 'export const ok = 1;\n', 'utf8');
    // node_modules copy of the pattern must be ignored too.
    const nm = join(dir, 'node_modules', 'pkg');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'index.js'), 'const PATTERN = "TODO";\n', 'utf8');

    const findings = [
      { desc: 'Found "TODO" comment in production code', category: 'security' },
      { desc: 'Another "TODO" left in production', category: 'security' },
    ];
    const { path, content } = buildCheckScript('todo-in-prod', findings);
    // The script itself contains the pattern — that's the trap.
    assert(content.includes('TODO'), 'precondition: generated script contains the pattern');
    const scriptPath = join(lessonsDir, path);
    writeFileSync(scriptPath, content, 'utf8');

    const res = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(res.status, 0, `gate must PASS (exit 0) on a clean repo; got ${res.status}: ${res.stderr}${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCheckScript: generated gate exits 2 when a GENUINE occurrence exists in source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-gate-real-'));
  try {
    const lessonsDir = join(dir, '.adlc', 'lessons');
    mkdirSync(lessonsDir, { recursive: true });
    // A real source file with the offending pattern.
    writeFileSync(join(dir, 'app.mjs'), 'const x = 1; // TODO fix me later\n', 'utf8');

    const findings = [
      { desc: 'Found "TODO" comment in production code', category: 'security' },
      { desc: 'Another "TODO" left in production', category: 'security' },
    ];
    const { path, content } = buildCheckScript('todo-in-prod', findings);
    const scriptPath = join(lessonsDir, path);
    writeFileSync(scriptPath, content, 'utf8');

    const res = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(res.status, 2, `gate must FAIL (exit 2) on a genuine occurrence; got ${res.status}: ${res.stdout}`);
    assert(res.stderr.includes('app.mjs'), `failure should point at the real file: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildSkillStub
// ---------------------------------------------------------------------------
test('buildSkillStub: returns SKILL.md with frontmatter', () => {
  const findings = [
    { desc: 'missing error handling in async functions', category: 'convention', file: 'src/api.mjs', line: 42 },
    { desc: 'no error handling for async call', category: 'convention', file: 'src/db.mjs', line: 10 },
  ];
  const { path, content } = buildSkillStub('async-error-handling', findings, null);

  assert(path.endsWith('.SKILL.md'));
  assert(content.startsWith('---'));
  assert(content.includes('name:'));
  assert(content.includes('description:'));
  assert(content.includes('mined from 2 findings') || content.includes('Mined from 2 finding'));
  assert(content.includes('src/api.mjs') || content.includes('api'));
});

test('buildSkillStub: uses LLM refinement when provided', () => {
  const findings = [{ desc: 'some pattern issue', category: 'pattern' }];
  const refinement = {
    name: 'refined-name',
    description: 'A refined description',
    rule: 'Always do the right thing',
  };
  const { content } = buildSkillStub('raw-name', findings, refinement);
  assert(content.includes('refined-name'));
  assert(content.includes('A refined description'));
  assert(content.includes('Always do the right thing'));
});

// ---------------------------------------------------------------------------
// buildSpecGapLine
// ---------------------------------------------------------------------------
test('buildSpecGapLine: returns markdown checkbox line', () => {
  const findings = [{ desc: 'unclear data retention policy', category: 'security' }];
  const line = buildSpecGapLine('data-retention', findings);
  assert(line.startsWith('- [ ]'));
  assert(line.includes('data-retention'));
  assert(line.includes('1 finding'));
});

test('buildSpecGapLine: pluralizes findings correctly', () => {
  const findings = [
    { desc: 'unclear policy', category: 'security' },
    { desc: 'unclear policy', category: 'security' },
  ];
  const line = buildSpecGapLine('policy-gap', findings);
  assert(line.includes('2 findings'));
});

// ---------------------------------------------------------------------------
// planEmissions
// ---------------------------------------------------------------------------
test('planEmissions: lint cluster produces two files', () => {
  const clusters = [
    { name: 'todo-lint', indices: [0], size: 1, route: 'lint', sample: 'TODO comment' },
  ];
  const findings = [{ desc: 'Found "TODO" in code', category: 'security' }];
  const plan = planEmissions(clusters, findings, '/tmp/out');

  const entry = plan.find((p) => p.cluster === clusters[0]);
  assert(entry);
  assert.strictEqual(entry.route, 'lint');
  assert.strictEqual(entry.files.length, 2);
  assert(entry.files.some((f) => f.path.endsWith('.lint.json')));
  assert(entry.files.some((f) => f.path.endsWith('.mjs')));
});

test('planEmissions: skill cluster produces one SKILL.md', () => {
  const clusters = [
    { name: 'async-errors', indices: [0], size: 1, route: 'skill', sample: 'missing error handling' },
  ];
  const findings = [{ desc: 'missing error handling', category: 'convention' }];
  const plan = planEmissions(clusters, findings, '/tmp/out');

  const entry = plan.find((p) => p.cluster === clusters[0]);
  assert(entry);
  assert.strictEqual(entry.route, 'skill');
  assert.strictEqual(entry.files.length, 1);
  assert(entry.files[0].path.endsWith('.SKILL.md'));
});

test('planEmissions: spec-gap cluster produces interrogation template entry', () => {
  const clusters = [
    { name: 'data-retention', indices: [0], size: 1, route: 'spec-gap', sample: 'unclear policy' },
  ];
  const findings = [{ desc: 'unclear data retention policy', category: 'unknown' }];
  const plan = planEmissions(clusters, findings, '/tmp/out');

  // Should have a spec-gap-template entry
  const template = plan.find((p) => p.route === 'spec-gap-template');
  assert(template);
  assert(template.files[0].path.includes('interrogation-template.md'));
  assert(template.files[0].content.includes('data-retention'));
});

test('planEmissions: outDir prefix applied to all file paths', () => {
  const clusters = [
    { name: 'test-cluster', indices: [0], size: 1, route: 'skill', sample: 'desc' },
  ];
  const findings = [{ desc: 'test', category: 'convention' }];
  const plan = planEmissions(clusters, findings, '/custom/out-dir');

  const entry = plan.find((p) => p.cluster === clusters[0]);
  assert(entry.files.every((f) => f.path.startsWith('/custom/out-dir')));
});

test('planEmissions: empty clusters returns empty plan', () => {
  const plan = planEmissions([], [], '/tmp/out');
  assert.deepStrictEqual(plan, []);
});

test('collectIncludeGlobs: includes default extensions and any valid finding file extensions', () => {
  assert.strictEqual(collectIncludeGlobs([]), '--include="*.mjs" --include="*.js" --include="*.ts" --include="*.tsx"');
  assert.strictEqual(collectIncludeGlobs(null), '--include="*.mjs" --include="*.js" --include="*.ts" --include="*.tsx"');
  const globs = collectIncludeGlobs([
    { desc: 'x', file: 'scripts/deploy.py' },
    { desc: 'y', file: 'docs/guide.md' },
    { desc: 'z', file: 'bad/file."quote"' },
    { desc: 'w', file: 123 },
    null,
  ]);
  assert(globs.includes('--include="*.py"'));
  assert(globs.includes('--include="*.md"'));
  assert(!globs.includes('quote'));
});

test('buildCheckScript: generated gate fails closed (exit 2) when grep exits 1 with stderr (e.g. missing grep on Windows cmd.exe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-gate-err1-'));
  const binDir = mkdtempSync(join(tmpdir(), 'foundry-fake-bin-'));
  try {
    const fakeGrep = join(binDir, 'grep');
    writeFileSync(fakeGrep, '#!/bin/sh\necho "\'grep\' is not recognized as an internal or external command" >&2\nexit 1\n', 'utf8');
    chmodSync(fakeGrep, 0o755);

    const { path, content } = buildCheckScript('missing-grep', [{ desc: 'Found "TODO" in code', category: 'security' }]);
    const scriptPath = join(dir, path);
    writeFileSync(scriptPath, content, 'utf8');

    const res = spawnSync(process.execPath, [scriptPath], {
      cwd: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.strictEqual(res.status, 2, `gate must fail closed (exit 2) when grep exits 1 with stderr; got ${res.status}: ${res.stdout}`);
    assert(res.stderr.includes('check-missing-grep: grep error:'), `stderr must report grep error: ${res.stderr}`);
    assert(res.stderr.includes('not recognized'), `stderr must include underlying stderr text: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('buildCheckScript: generated gate matches occurrences in non-JS finding file extensions (.py/.yml)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-gate-ext-'));
  try {
    writeFileSync(join(dir, 'worker.py'), 'SECRET_TOKEN = "hardcoded"\n', 'utf8');
    const findings = [
      { desc: 'Found "SECRET_TOKEN" in python worker', file: 'worker.py', category: 'security' },
    ];
    const { path, content } = buildCheckScript('py-secret', findings);
    assert(content.includes('--include="*.py"'));
    const scriptPath = join(dir, path);
    writeFileSync(scriptPath, content, 'utf8');

    const res = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(res.status, 2, `gate must FAIL (exit 2) on occurrence in .py file; got ${res.status}: ${res.stdout}`);
    assert(res.stderr.includes('worker.py'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCheckScript: prevents shell command injection from $() and backticks and leading-dash flag injection in findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-gate-inj-'));
  try {
    const marker = join(dir, 'pwned-marker');
    const lessonsDir = join(dir, '.adlc', 'lessons');
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(join(dir, 'clean.mjs'), 'export const x = 1;\n', 'utf8');

    const findings = [
      { desc: `Disallowed "$(touch ${marker})" and \`touch ${marker}\` in source`, category: 'security' },
    ];
    const { path, content } = buildCheckScript("no-shell-inj'test", findings);
    assert(!content.includes('execSync('), 'generated script must not invoke a shell via execSync');
    const scriptPath = join(lessonsDir, path);
    writeFileSync(scriptPath, content, 'utf8');

    const res = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(res.status, 0, `expected clean exit 0, got ${res.status}: ${res.stderr}`);
    assert.strictEqual(existsSync(marker), false, 'shell command substitution must NEVER create marker file');

    // Leading-dash literal (e.g. "--version") must be passed after `-e`, not parsed as a grep flag.
    const dashFindings = [{ desc: 'Avoid "--version" hardcoded flag', category: 'security' }];
    const dashGate = buildCheckScript('leading-dash', dashFindings);
    const dashPath = join(lessonsDir, dashGate.path);
    writeFileSync(dashPath, dashGate.content, 'utf8');
    const dashClean = spawnSync(process.execPath, [dashPath], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(dashClean.status, 0, `leading-dash pattern must not trigger grep --version (got ${dashClean.status}: ${dashClean.stdout})`);

    // A source file with the SAME basename as the check script (outside .adlc/lessons)
    // and fnmatch wildcards in cluster name must still be flagged, while the gate script
    // itself (even when placed in scripts/ outside .adlc) is excluded by exact realpath.
    const scriptsDir = join(dir, 'scripts');
    const srcSubDir = join(dir, 'src');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(srcSubDir, { recursive: true });
    const wildcardGate = buildCheckScript('wild*name', [{ desc: 'Found "FORBIDDEN_CALL" in code', category: 'security' }]);
    const movedScript = join(scriptsDir, wildcardGate.path);
    writeFileSync(movedScript, wildcardGate.content, 'utf8');
    const passMoved = spawnSync(process.execPath, [movedScript], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(passMoved.status, 0, `gate in scripts/ must not trip on itself: ${passMoved.stderr}`);

    // Now plant a real violation inside src/<same-basename>: exact-path exclusion must catch it!
    writeFileSync(join(srcSubDir, wildcardGate.path), 'export const bad = "FORBIDDEN_CALL";\n', 'utf8');
    const failSameBasename = spawnSync(process.execPath, [movedScript], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(failSameBasename.status, 2, 'violation in same-basename source file must fail the gate');

    // Relative PATH (`.`), `node_modules/.bin/grep`, AND repo-interior `tools/grep` MUST be skipped in favor of trusted grep!
    const nmBin = join(dir, 'node_modules', '.bin');
    const repoToolsBin = join(dir, 'tools');
    mkdirSync(nmBin, { recursive: true });
    mkdirSync(repoToolsBin, { recursive: true });
    for (const shadowGrep of [join(dir, 'grep'), join(nmBin, 'grep'), join(repoToolsBin, 'grep')]) {
      writeFileSync(shadowGrep, '#!/bin/sh\nexit 1\n', 'utf8');
      chmodSync(shadowGrep, 0o755);
    }
    const shadowAttempt = spawnSync(process.execPath, [movedScript], {
      cwd: dir,
      env: { ...process.env, PATH: `.:${repoToolsBin}:${nmBin}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.strictEqual(shadowAttempt.status, 2, 'repo tools/grep, node_modules/.bin/grep, and ./grep must not shadow system grep into a false PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSkillStub and buildSpecGapLine neutralize newlines, YAML metacharacters, and path separators', () => {
  const stub = buildSkillStub('inj\nname/sub', [{ desc: 'SECURITY: .adlc/config.json: bad # comment\n---\nevil: true', category: '[flow]\ninjected: yes' }]);
  assert.strictEqual(stub.path, 'inj name-sub.SKILL.md', 'artifact path must sanitize newlines and path separators');
  const fmMatch = stub.content.match(/^---\n([\s\S]*?)\n---/);
  assert(fmMatch, 'frontmatter block must stay intact');
  assert(!fmMatch[1].includes('injected: yes\n') || !/^injected:/m.test(fmMatch[1]), 'category must not inject a new YAML key');
  assert(!/^evil:/m.test(fmMatch[1]), 'desc must not break frontmatter');
  assert(fmMatch[1].includes('description: "SECURITY: .adlc/config.json:'), 'YAML scalar containing ": " and " #" must be double-quoted');
  assert(fmMatch[1].includes('category: "[flow] injected: yes"'), 'YAML scalar starting with "[" and containing ": " must be double-quoted');

  // BusyBox/Toybox multicall symlink (`grep -> multicall`) must preserve `grep` in argv[0]
  if (process.platform !== 'win32') {
    const repoDir = mkdtempSync(join(tmpdir(), 'foundry-busybox-repo-'));
    const multiBin = mkdtempSync(join(tmpdir(), 'foundry-busybox-bin-'));
    try {
      const multicall = join(multiBin, 'busybox-mock');
      writeFileSync(multicall, '#!/bin/sh\ncase "$0" in *grep) exit 1 ;; *) echo "applets require grep argv0, got $0" >&2; exit 127 ;; esac\n', 'utf8');
      chmodSync(multicall, 0o755);
      symlinkSync(multicall, join(multiBin, 'grep'));
      const gate = buildCheckScript('busybox-check', [{ desc: 'Found "NEVER_HERE" in code', category: 'security' }]);
      const gatePath = join(repoDir, gate.path);
      writeFileSync(gatePath, gate.content, 'utf8');
      const r = spawnSync(process.execPath, [gatePath], {
        cwd: repoDir,
        env: { ...process.env, PATH: `${multiBin}:${process.env.PATH}` },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.strictEqual(r.status, 0, `BusyBox symlink grep must receive argv[0] ending in grep; got ${r.status}: ${r.stderr}`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(multiBin, { recursive: true, force: true });
    }
  }

  const gapLine = buildSpecGapLine('slug\ninj', [{ desc: 'multi\nline\ndesc', category: 'cat\ninj' }]);
  assert.strictEqual(gapLine.trimEnd().split('\n').length, 1, 'buildSpecGapLine must emit a single checklist line');
});

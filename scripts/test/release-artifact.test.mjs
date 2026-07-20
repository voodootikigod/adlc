// release-artifact.test.mjs — RAIL for T-01KY00D1KX0HDE3521KTFC9T26.
//
// The existing release.test.mjs pins that the bump touches every surface it
// KNOWS about. This file pins the two things it did not know about, both of
// which shipped broken to real users:
//
//   Defect A — scripts/release.mjs grew a hardcoded bump loop per integration
//     (codex, then cursor). Claude Code was the FIRST integration and never got
//     one, so .claude-plugin/marketplace.json and adlc-claude-code's plugin.json
//     sat at 0.2.0 through 1.3.0/1.4.0/1.5.0 while findVersionDrift reported
//     GREEN — because the gate mirrored the bumper's blind spots exactly.
//
//   Defect B — @adlc/ticket-sync's `files` allowlist omitted scripts/ while
//     lib/doctor.mjs imports ../scripts/gen-schema.mjs at module load, so the
//     published tarball was missing a file its own code imports.
//
// Shared root cause: every gate validated the SOURCE TREE. Nothing asked whether
// the artifact a user installs actually works.
//
// P5 NOTE — several tests here exist because the FIRST version of this rail was
// prosecuted and found wanting. Three failure modes recur and are guarded
// explicitly below, because each one produces a green rail that verifies nothing:
//   (a) asserting `[] === []` against a scanner whose failure mode is also `[]`
//       (always assert the DENOMINATOR too);
//   (b) testing a helper directly while the RELEASE-TIME WIRING that calls it
//       goes uncovered (delete the gate, suite stays green);
//   (c) `.every()` over a list the fixture never populated — vacuously true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  releaseMain,
  findVersionDrift,
  findPackagingProblems,
  hostPluginManifestPaths,
  hostMarketplacePaths,
  hostDiscoveryNearMisses,
  publishTargets,
} from '../release.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const ver = (p) => JSON.parse(readFileSync(p, 'utf8')).version;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const REPOSITORY = { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' };

// A packImpl that reports a fixed file list — lets the manifest tests run fully
// offline instead of shelling out to real npm for every releaseMain call.
const packAll = (fileList) => () => JSON.stringify([{ files: fileList.map((path) => ({ path })) }]);
const packNothing = packAll([]);

/**
 * A fixture repo carrying every host-manifest SHAPE the real repo has, plus the
 * decoys discovery must NOT touch.
 */
function makeRepo({ stranded = '0.2.0', current = '1.0.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-artifact-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);

  write(join(root, 'package.json'), { name: 'adlc', version: current, private: true });
  mkdirSync(join(packagesDir, 'core'));
  write(join(packagesDir, 'core', 'package.json'), { name: '@adlc/core', version: current, repository: REPOSITORY });

  // Codex: nested manifest, already bumped pre-fix — proves we did not regress it.
  mkdirSync(join(pluginsDir, 'adlc-codex', '.codex-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-codex', 'package.json'), { name: '@adlc/codex', version: current, repository: REPOSITORY });
  write(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json'), { name: 'adlc-codex', version: current });

  // Claude Code: nested manifest, NO package.json (the real shape) — Defect A.
  mkdirSync(join(pluginsDir, 'adlc-claude-code', '.claude-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-claude-code', '.claude-plugin', 'plugin.json'), { name: 'adlc', version: stranded });

  // Antigravity: FLAT plugin.json carrying a protocol number that must survive.
  mkdirSync(join(pluginsDir, 'adlc-antigravity'), { recursive: true });
  write(join(pluginsDir, 'adlc-antigravity', 'package.json'), { name: '@adlc/antigravity', version: current, private: true });
  write(join(pluginsDir, 'adlc-antigravity', 'plugin.json'), { name: 'adlc-antigravity', version: stranded, adlcContract: 1 });

  // Root Claude Code marketplace — metadata.version AND every plugins[].version.
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  write(join(root, '.claude-plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { description: 'fixture', version: stranded },
    plugins: [{ name: 'adlc', source: './plugins/adlc-claude-code', version: stranded }],
  });

  // --- decoys that discovery must never touch ---
  // Worktree copies: 21 exist in the real repo; rewriting them corrupts
  // unrelated in-flight branches.
  mkdirSync(join(root, '.worktrees', 'wt', '.claude-plugin'), { recursive: true });
  write(join(root, '.worktrees', 'wt', '.claude-plugin', 'marketplace.json'), {
    name: 'adlc', metadata: { version: stranded }, plugins: [{ name: 'adlc', version: stranded }],
  });
  // node_modules copies at BOTH depths a naive walk would reach. Without these
  // the node_modules assertions below are vacuously true (P5 finding (c)).
  mkdirSync(join(pluginsDir, 'adlc-codex', 'node_modules', 'dep', '.claude-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-codex', 'node_modules', 'dep', '.claude-plugin', 'plugin.json'), {
    name: 'vendored', version: stranded,
  });
  mkdirSync(join(pluginsDir, 'node_modules', 'adlc-fake', '.claude-plugin'), { recursive: true });
  write(join(pluginsDir, 'node_modules', 'adlc-fake', '.claude-plugin', 'plugin.json'), {
    name: 'vendored-2', version: stranded,
  });
  // A stray FILE directly in plugins/ — exercises the readdir try/catch.
  writeFileSync(join(pluginsDir, 'NOTES.md'), '# not a plugin directory\n');
  // A flat plugin.json that is NOT a versioned host manifest. The bumper must
  // not invent a `version` key: for an additionalProperties:false host schema an
  // injected field is an install-time rejection.
  mkdirSync(join(pluginsDir, 'adlc-tool'), { recursive: true });
  write(join(pluginsDir, 'adlc-tool', 'plugin.json'), { name: 'adlc-tool', kind: 'config' });

  return { root, packagesDir, pluginsDir };
}

// --- AC1: the bump reaches every shape -------------------------------------

test('claude-plugin bump reaches every host manifest shape and preserves adlcContract', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const rc = releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    assert.equal(rc, 0, 'releaseMain must succeed');

    assert.equal(ver(join(pluginsDir, 'adlc-claude-code', '.claude-plugin', 'plugin.json')), '9.9.9',
      'nested .claude-plugin/plugin.json must bump — this is the Defect A miss');
    assert.equal(ver(join(pluginsDir, 'adlc-antigravity', 'plugin.json')), '9.9.9',
      'FLAT plugin.json (antigravity shape) must bump');
    assert.equal(ver(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json')), '9.9.9',
      'codex must not regress');

    const mkt = readJson(join(root, '.claude-plugin', 'marketplace.json'));
    assert.equal(mkt.metadata.version, '9.9.9', 'marketplace metadata.version must bump');
    assert.equal(mkt.plugins[0].version, '9.9.9', 'marketplace plugins[].version must bump');

    assert.equal(readJson(join(pluginsDir, 'adlc-antigravity', 'plugin.json')).adlcContract, 1,
      'adlcContract is a protocol number, not a release version — it must survive the bump');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bump never INVENTS a version field in a non-manifest plugin.json', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    const tool = readJson(join(pluginsDir, 'adlc-tool', 'plugin.json'));
    assert.equal('version' in tool, false,
      'a plugin.json with no pre-existing version must not be stamped — an injected key is an install-time rejection under additionalProperties:false');
    assert.deepEqual(tool, { name: 'adlc-tool', kind: 'config' }, 'the file must be byte-identical in content');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stray file directly in plugins/ does not crash the bump', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const rc = releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    assert.equal(rc, 0, 'plugins/NOTES.md must not ENOTDIR the release');
    assert.ok(hostPluginManifestPaths(pluginsDir).length >= 3, 'real manifests are still discovered alongside the stray file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC2: the drift gate sees everything the bumper touches -----------------

test('drift gate flags every stranded host manifest the bumper touches', () => {
  const { root, packagesDir, pluginsDir } = makeRepo({ stranded: '0.2.0', current: '9.9.9' });
  try {
    const problems = findVersionDrift('9.9.9', { root, packagesDir, pluginsDir });
    const blob = problems.join('\n');

    assert.ok(problems.length > 0, 'stranded manifests must produce drift');
    assert.match(blob, /adlc-claude-code[/\\]\.claude-plugin[/\\]plugin\.json/, 'must flag the stranded Claude Code plugin.json');
    assert.match(blob, /\.claude-plugin[/\\]marketplace\.json metadata\.version/, 'must flag stranded marketplace metadata.version');
    assert.match(blob, /\.claude-plugin[/\\]marketplace\.json plugin adlc/, 'must flag the stranded marketplace plugin entry');
    assert.match(blob, /adlc-antigravity[/\\]plugin\.json/, 'must flag the stranded FLAT plugin.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drift gate is clean once the generalized bump has run', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    assert.deepEqual(findVersionDrift('9.9.9', { root, packagesDir, pluginsDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a marketplace with no metadata block is bumpable — the gate cannot demand what the bump cannot write', () => {
  // Regression for a bumper/gate asymmetry: the bumper wrote metadata.version
  // only when `metadata` existed, while the gate required it unconditionally.
  // A metadata-less listing therefore made releaseMain mutate the ENTIRE tree
  // and then abort — identically on every re-run, with no path to green.
  // .agents/plugins/marketplace.json is exactly this shape in the real repo.
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(root, '.bare-plugin'), { recursive: true });
    write(join(root, '.bare-plugin', 'marketplace.json'), {
      name: 'adlc',
      plugins: [{ name: 'adlc-bare', source: './plugins/adlc-bare' }], // no version keys anywhere
    });

    const rc = releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    assert.equal(rc, 0, 'a metadata-less marketplace must not abort the release');
    assert.deepEqual(findVersionDrift('9.9.9', { root, packagesDir, pluginsDir }), [],
      'the gate must not demand a metadata.version the bumper never writes');

    const bare = readJson(join(root, '.bare-plugin', 'marketplace.json'));
    assert.equal('metadata' in bare, false, 'the bump must not invent a metadata block');
    assert.equal('version' in bare.plugins[0], false, 'the bump must not invent an entry version');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC3: discovery generalizes, and its blind spot is loud -----------------

test('unknown host directories are discovered without editing release.mjs', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(pluginsDir, 'adlc-future', '.future-plugin'), { recursive: true });
    write(join(pluginsDir, 'adlc-future', '.future-plugin', 'plugin.json'), { name: 'adlc-future', version: '0.2.0' });
    mkdirSync(join(root, '.future-plugin'), { recursive: true });
    write(join(root, '.future-plugin', 'marketplace.json'), {
      name: 'adlc', metadata: { version: '0.2.0' }, plugins: [{ name: 'adlc-future', version: '0.2.0' }],
    });

    const before = findVersionDrift('9.9.9', { root, packagesDir, pluginsDir }).join('\n');
    assert.match(before, /adlc-future[/\\]\.future-plugin[/\\]plugin\.json/, 'an unknown host plugin.json must be drift-flagged');
    assert.match(before, /\.future-plugin[/\\]marketplace\.json/, 'an unknown host marketplace must be drift-flagged');

    const rc = releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    assert.equal(rc, 0);
    assert.equal(ver(join(pluginsDir, 'adlc-future', '.future-plugin', 'plugin.json')), '9.9.9');
    assert.equal(readJson(join(root, '.future-plugin', 'marketplace.json')).metadata.version, '9.9.9');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a near-miss host directory aborts loudly instead of passing green', () => {
  // The shape regex is itself an enumeration. `.Codex-plugin` / `.claude_plugin`
  // / `.jetbrains.ai-plugin` match neither the bumper nor the gate — which is
  // VERBATIM the Defect A failure mode (frozen manifest, green gate). Sharing
  // the discovery functions prevents bumper/gate divergence but not
  // discovery/reality divergence, so near misses must be reported.
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(pluginsDir, 'adlc-jb', '.Codex-plugin'), { recursive: true });
    write(join(pluginsDir, 'adlc-jb', '.Codex-plugin', 'plugin.json'), { name: 'adlc-jb', version: '0.2.0' });

    const misses = hostDiscoveryNearMisses({ root, pluginsDir });
    assert.ok(misses.length > 0, 'an uppercase host dir must be reported as a near miss');
    assert.match(misses.join('\n'), /\.Codex-plugin/);

    releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });
    const drift = findVersionDrift('9.9.9', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((d) => d.includes('.Codex-plugin')),
      'the near miss must surface as drift so the release stops rather than silently skipping the host');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovery never walks into .worktrees or node_modules', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    // Denominator first: an empty list would make every `.every()` below
    // vacuously true, which is exactly how this test used to pass for free.
    const manifests = hostPluginManifestPaths(pluginsDir);
    const marketplaces = hostMarketplacePaths(root);
    assert.ok(manifests.length >= 3, `expected real manifests, got ${manifests.length}`);
    assert.ok(marketplaces.length >= 1, `expected a real marketplace, got ${marketplaces.length}`);

    assert.ok(manifests.every((p) => !p.includes('node_modules')), 'no node_modules manifest may be returned');
    assert.ok(marketplaces.every((p) => !p.includes('.worktrees')), 'no worktree marketplace may be returned');

    releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: packNothing });

    assert.equal(readJson(join(root, '.worktrees', 'wt', '.claude-plugin', 'marketplace.json')).metadata.version, '0.2.0',
      'the worktree decoy must NOT be rewritten');
    assert.equal(ver(join(pluginsDir, 'adlc-codex', 'node_modules', 'dep', '.claude-plugin', 'plugin.json')), '0.2.0',
      'a vendored manifest inside a plugin must NOT be rewritten');
    assert.equal(ver(join(pluginsDir, 'node_modules', 'adlc-fake', '.claude-plugin', 'plugin.json')), '0.2.0',
      'a manifest under plugins/node_modules must NOT be rewritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC4: the packaging gate ------------------------------------------------

/**
 * A package whose lib/ imports outward, with a controllable `files` allowlist.
 * `source` defaults to the exact shape of Defect B.
 */
function makePackagingFixture(files, source) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-packing-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(join(packagesDir, 'escaper', 'lib'), { recursive: true });
  mkdirSync(join(packagesDir, 'escaper', 'scripts'), { recursive: true });
  mkdirSync(pluginsDir);
  write(join(packagesDir, 'escaper', 'package.json'), {
    name: '@adlc/escaper', version: '1.0.0', type: 'module', repository: REPOSITORY, files,
  });
  // ORDER MATTERS — the escaping import sits at BYTE OFFSET 0. relativeSpecifiers
  // resets `re.lastIndex = 0` before each scan because the patterns are
  // module-level /g regexes shared across calls; if that reset regressed to any
  // non-zero value a match at offset 0 would be skipped and a real escape missed
  // — fail-OPEN in a release gate. Leading with a node: builtin leaves that case
  // untested, since builtins are filtered out anyway.
  writeFileSync(join(packagesDir, 'escaper', 'lib', 'doctor.mjs'), source ??
    "import { generateAll } from '../scripts/gen-schema.mjs';\n" +
    "import { readFileSync } from 'node:fs';\n" +
    "import { thing } from '@adlc/core';\n" +
    "export { generateAll, readFileSync, thing };\n");
  for (const f of ['gen-schema.mjs', 'a.mjs', 'b.mjs', 'c.mjs', 'd.cjs']) {
    writeFileSync(join(packagesDir, 'escaper', 'scripts', f), 'export const x = 1;\n');
  }
  return { root, packagesDir, pluginsDir };
}

test('files allowlist gate flags a shipped import that escapes the tarball', () => {
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'README.md']);
  try {
    const { problems, consulted, unconsultable } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.deepEqual(unconsultable, [], 'npm must have answered — otherwise this test proves nothing');
    assert.equal(consulted.length, 1, 'exactly one publish target must have been inspected');
    assert.ok(problems.length > 0, 'an escaping import must be reported');
    assert.match(problems.join('\n'), /scripts[/\\]gen-schema\.mjs/, 'the report must name the missing file');
    assert.match(problems.join('\n'), /@adlc\/escaper/, 'the report must name the package');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('files allowlist gate is silent when the import is admitted', () => {
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'scripts/', 'README.md']);
  try {
    const { problems, consulted } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.equal(consulted.length, 1, 'silence only means something if a package was actually consulted');
    assert.deepEqual(problems, [], 'admitting scripts/ must clear the problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('files allowlist gate ignores builtins and bare specifiers', () => {
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'scripts/']);
  try {
    const { problems, consulted } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.equal(consulted.length, 1);
    const blob = problems.join('\n');
    assert.doesNotMatch(blob, /node:fs/, 'node: builtins must never be flagged');
    assert.doesNotMatch(blob, /@adlc\/core/, 'bare specifiers must never be flagged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every declared specifier form is actually detected', () => {
  // ADR 0011 §7 promises import / export…from / side-effect import / literal
  // import() / require(). Each needs a fixture or the promise is untested and
  // deleting a pattern breaks nothing.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/'],
    "export { a } from '../scripts/a.mjs';\n" +
    "import '../scripts/b.mjs';\n" +
    "const c = await import('../scripts/c.mjs');\n" +
    "const d = require('../scripts/d.cjs');\n" +
    "export { c, d };\n");
  try {
    const blob = findPackagingProblems({ packagesDir, pluginsDir }).problems.join('\n');
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs', 'd.cjs']) {
      assert.match(blob, new RegExp(`scripts/${f.replace('.', '\\.')}`), `${f} must be detected`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a commented-out import is NOT reported', () => {
  // Without comment stripping, an ordinary refactor leftover hard-aborts the
  // release with "the installed package would fail at import time" about a line
  // that never executes — after the whole tree has already been bumped.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/'],
    "// import { old } from '../scripts/gone.mjs';\n" +
    "/* import { older } from '../scripts/also-gone.mjs'; */\n" +
    "export const fine = 1;\n");
  try {
    const { problems, consulted } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.equal(consulted.length, 1);
    assert.deepEqual(problems, [], 'commented-out imports must not abort a release');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- cross-model review findings (agy, needs-attention) --------------------
// The first fix pass traded one hole for another. These four pin the trade shut.

test('an extensionless CJS require is NOT reported — Node resolves it', () => {
  // `require('../scripts/d')` legitimately resolves to d.cjs/d.js/d/index.js.
  // Comparing the literal specifier against the tarball hard-aborts every valid
  // CommonJS package: a FALSE POSITIVE in a release-blocking gate.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'scripts/'],
    "const d = require('../scripts/d');\nmodule.exports = { d };\n");
  try {
    const { problems, consulted } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.equal(consulted.length, 1);
    assert.deepEqual(problems, [], 'extensionless require must resolve against .cjs/.js/index.*');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an extensionless require to a file that is genuinely absent IS reported', () => {
  // The leniency above must not become a fail-open: if no candidate exists, the
  // escape is still an escape.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/'],
    "const gone = require('../scripts/not-there');\nmodule.exports = { gone };\n");
  try {
    const { problems } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.ok(problems.length > 0, 'a missing target must still be flagged');
    assert.match(problems.join('\n'), /not-there/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an EXTENSIONLESS bin entrypoint is scanned, not skipped', () => {
  // "bin": { "cli": "bin/cli" } is an ordinary CLI pattern. Filtering the scan
  // set by extension skips the package's own entrypoint — a fail-open on the
  // file most likely to be executed.
  const root = mkdtempSync(join(tmpdir(), 'adlc-bin-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(join(packagesDir, 'clier', 'bin'), { recursive: true });
  mkdirSync(join(packagesDir, 'clier', 'internal'), { recursive: true });
  mkdirSync(pluginsDir);
  write(join(packagesDir, 'clier', 'package.json'), {
    name: '@adlc/clier', version: '1.0.0', type: 'module', repository: REPOSITORY,
    bin: { clier: './bin/clier' }, files: ['bin/'],
  });
  writeFileSync(join(packagesDir, 'clier', 'bin', 'clier'),
    "#!/usr/bin/env node\nimport { go } from '../internal/run.mjs';\ngo();\n");
  writeFileSync(join(packagesDir, 'clier', 'internal', 'run.mjs'), 'export const go = () => {};\n');
  try {
    const { problems, consulted } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.equal(consulted.length, 1);
    assert.ok(problems.length > 0, 'the extensionless bin must be scanned');
    assert.match(problems.join('\n'), /internal[/\\]run\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a /* inside a string literal does not blind the scanner', () => {
  // Naive comment stripping matches from a `/*` inside a string to the next
  // `*/` anywhere later, DELETING the code between — including real imports.
  // That is a fail-open, and it is how the previous comment fix broke things.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/'],
    "const glob = '/*.mjs';\n" +
    "import { escaped } from '../scripts/a.mjs';\n" +
    "const close = '*/';\n" +
    "export { glob, escaped, close };\n");
  try {
    const { problems } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.ok(problems.length > 0, 'the real import between two string literals must still be seen');
    assert.match(problems.join('\n'), /scripts[/\\]a\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('import-shaped text inside a string literal is NOT a specifier', () => {
  // Codegen templates and fixtures legitimately contain import text. Extracting
  // it aborts a valid release — and this very rail file is full of such strings.
  //
  // DENOMINATOR: this fixture also carries a REAL escaping import. Asserting
  // only "no imaginary specifiers" would pass trivially if the scanner found
  // nothing at all — the same vacuous-emptiness trap that produced a green rail
  // earlier in this ticket. The real import proves the scanner was awake.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/'],
    "const template = \"import { x } from './totally-imaginary.mjs';\";\n" +
    "const tpl = `require('../scripts/also-imaginary.cjs')`;\n" +
    "import { real } from '../scripts/a.mjs';\n" +
    "export { template, tpl, real };\n");
  try {
    const { problems, consulted } = findPackagingProblems({ packagesDir, pluginsDir });
    assert.equal(consulted.length, 1);
    const blob = problems.join('\n');
    assert.match(blob, /scripts[/\\]a\.mjs/, 'the REAL escaping import must be found (scanner is awake)');
    assert.doesNotMatch(blob, /totally-imaginary/, 'string CONTENTS must not be scanned as code');
    assert.doesNotMatch(blob, /also-imaginary/, 'template-literal CONTENTS must not be scanned as code');
    assert.equal(problems.length, 1, 'exactly one real escape, no phantoms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unconsultable package is reported, never silently clean', () => {
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/']);
  try {
    const thrower = () => { throw new Error('npm exploded'); };
    const r = findPackagingProblems({ packagesDir, pluginsDir, packImpl: thrower });
    assert.deepEqual(r.consulted, [], 'nothing could be consulted');
    assert.equal(r.unconsultable.length, 1, 'the failure must be surfaced, not swallowed');
    assert.match(r.unconsultable[0].reason, /npm exploded/);
    assert.deepEqual(r.problems, [], 'and it must not masquerade as a problem list');

    // The quieter hole: npm exits 0 but returns no files array. That used to
    // yield an EMPTY SET and pass as verified without taking the failure path.
    const shapeless = findPackagingProblems({ packagesDir, pluginsDir, packImpl: () => JSON.stringify([{}]) });
    assert.equal(shapeless.unconsultable.length, 1, 'a missing files array is unconsultable, not "zero files"');
    assert.deepEqual(shapeless.consulted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the RELEASE-TIME WIRING, not just the helper ---------------------------

test('releaseMain ABORTS and publishes nothing when a tarball would ship a broken import', () => {
  // Defect B's fix is not that findPackagingProblems exists — it is that
  // releaseMain refuses. Without this test the entire fail-closed gate could be
  // deleted and the suite would stay green.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/']);
  try {
    write(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
    let published = 0;
    const rc = releaseMain(['9.9.9', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile: () => {},
      publishImpl: () => { published++; },
      packImpl: packAll(['package.json', 'lib/doctor.mjs']), // scripts/ excluded
    });
    assert.equal(rc, 1, 'a packaging problem must abort the release');
    assert.equal(published, 0, 'NOTHING may be published once the gate trips');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unconsultable package is fatal for --publish but only a warning for a bare bump', () => {
  // Policy (ADR 0011): npm pack failing in a directory we are about to run
  // npm publish in is a signal about the very next command. A bare bump
  // publishes nothing, so blocking there would add friction with no safety.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'scripts/']);
  try {
    write(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
    const thrower = () => { throw new Error('npm unavailable'); };

    let published = 0;
    const rcPublish = releaseMain(['9.9.9', '--publish'], {
      root, packagesDir, pluginsDir, regenerateLockfile: () => {},
      publishImpl: () => { published++; }, packImpl: thrower,
    });
    assert.equal(rcPublish, 1, '--publish must refuse to ship an unverified package');
    assert.equal(published, 0, 'nothing may be published');

    const rcBump = releaseMain(['9.9.8'], {
      root, packagesDir, pluginsDir, regenerateLockfile: () => {}, packImpl: thrower,
    });
    assert.equal(rcBump, 0, 'a bare bump proceeds — nothing leaves the machine');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC5 / AC7: the REAL repo, with denominators ----------------------------

test('the real repo ships every file its code imports (with a scan denominator)', () => {
  const { problems, consulted, unconsultable } = findPackagingProblems({
    packagesDir: join(REPO_ROOT, 'packages'),
    pluginsDir: join(REPO_ROOT, 'plugins'),
  });
  const expected = publishTargets({
    packagesDir: join(REPO_ROOT, 'packages'),
    pluginsDir: join(REPO_ROOT, 'plugins'),
  }).length;
  // Without this, `problems === []` is also what a totally failed scan returns.
  assert.deepEqual(unconsultable, [], 'every publish target must be answerable by npm');
  assert.equal(consulted.length, expected, `all ${expected} publish targets must be inspected`);
  assert.deepEqual(problems, [], 'no published package may import a file its files allowlist excludes');
});

test('AC5 end-to-end: the packed ticket-sync tarball can actually be imported', async () => {
  // The analyzer cannot audit itself. This is the only assertion independent of
  // it: pack the REAL package, extract it, and import the module that crashed
  // with ERR_MODULE_NOT_FOUND for every 1.5.0 user.
  const pkgDir = join(REPO_ROOT, 'packages', 'ticket-sync');
  const tmp = mkdtempSync(join(tmpdir(), 'adlc-e2e-'));
  try {
    const out = execFileSync('npm', ['pack', '--pack-destination', tmp, '--json'], {
      cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tarball = join(tmp, JSON.parse(out)[0].filename);
    execFileSync('tar', ['xzf', tarball, '-C', tmp]);
    const extracted = join(tmp, 'package');

    const doctor = join(extracted, 'lib', 'doctor.mjs');
    assert.ok(existsSync(doctor), 'lib/doctor.mjs must be in the tarball');
    assert.ok(existsSync(join(extracted, 'scripts', 'gen-schema.mjs')),
      'the file doctor.mjs imports must be in the tarball — this is Defect B');

    // Resolve the workspace deps so the import exercises the tarball's own
    // relative graph rather than failing on an unrelated missing dependency.
    mkdirSync(join(extracted, 'node_modules', '@adlc'), { recursive: true });
    for (const dep of ['core', 'tickets']) {
      symlinkSync(join(REPO_ROOT, 'packages', dep), join(extracted, 'node_modules', '@adlc', dep), 'dir');
    }
    // MUST be awaited inside the try: a bare `return import(...)` lets the
    // finally block delete the extracted tree before the import resolves.
    const mod = await import(pathToFileURL(doctor).href);
    assert.equal(typeof mod, 'object', 'doctor.mjs must import cleanly from the packed artifact');
    assert.equal(typeof mod.doctor, 'function', 'the packed module must expose its API, not just parse');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the real repo is in host-manifest lockstep at the root version (with a discovery denominator)', () => {
  const rootVersion = readJson(join(REPO_ROOT, 'package.json')).version;
  const opts = { root: REPO_ROOT, packagesDir: join(REPO_ROOT, 'packages'), pluginsDir: join(REPO_ROOT, 'plugins') };

  // Prove discovery actually found the surfaces before asserting they are clean.
  const manifests = hostPluginManifestPaths(opts.pluginsDir);
  const marketplaces = hostMarketplacePaths(REPO_ROOT);
  assert.ok(manifests.some((p) => p.includes(join('adlc-claude-code', '.claude-plugin'))),
    'the Claude Code manifest — the one that was stranded — must be discovered');
  assert.ok(manifests.some((p) => p.endsWith(join('adlc-antigravity', 'plugin.json'))),
    'the flat antigravity manifest must be discovered');
  assert.ok(marketplaces.some((p) => p.includes('.claude-plugin')),
    'the root Claude Code marketplace must be discovered');

  assert.deepEqual(findVersionDrift(rootVersion, opts), [], `repo must be in lockstep at ${rootVersion}`);
});

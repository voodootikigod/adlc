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
//     `/plugin` compares the declared version string to decide whether an update
//     exists, so every release since 1.2.x was invisible to the updater.
//
//   Defect B — @adlc/ticket-sync's `files` allowlist omitted scripts/ while
//     lib/doctor.mjs imports ../scripts/gen-schema.mjs at module load. The
//     published tarball was missing a file its own code imports, so
//     `adlc ticket doctor` hard-crashed with ERR_MODULE_NOT_FOUND for every
//     npm-installed user of 1.5.0.
//
// The shared root cause: every gate validated the SOURCE TREE. Nothing asked
// whether the artifact a user installs actually works. These tests are the
// answer to that question, so they are frozen as a rail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  releaseMain,
  findVersionDrift,
  findPackagingProblems,
  hostPluginManifestPaths,
  hostMarketplacePaths,
} from '../release.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const ver = (p) => JSON.parse(readFileSync(p, 'utf8')).version;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * A fixture repo carrying every host-manifest SHAPE the real repo has:
 *   - .codex-plugin/plugin.json   (nested, already covered pre-fix)
 *   - .claude-plugin/plugin.json  (nested, the Defect A miss)
 *   - plugin.json                 (FLAT — antigravity's shape, also missed)
 *   - root .claude-plugin/marketplace.json + root .future-plugin/marketplace.json
 * plus a .worktrees/ decoy that recursive globbing would corrupt.
 */
function makeRepo({ stranded = '0.2.0', current = '1.0.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-artifact-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);
  const repository = { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' };

  write(join(root, 'package.json'), { name: 'adlc', version: current, private: true });
  mkdirSync(join(packagesDir, 'core'));
  write(join(packagesDir, 'core', 'package.json'), { name: '@adlc/core', version: current, repository });

  // Codex: nested manifest, already bumped pre-fix — proves we did not regress it.
  mkdirSync(join(pluginsDir, 'adlc-codex', '.codex-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-codex', 'package.json'), { name: '@adlc/codex', version: current, repository });
  write(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json'), { name: 'adlc-codex', version: current });

  // Claude Code: nested manifest, NO package.json (the real shape) — Defect A.
  mkdirSync(join(pluginsDir, 'adlc-claude-code', '.claude-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-claude-code', '.claude-plugin', 'plugin.json'), {
    name: 'adlc',
    version: stranded,
  });

  // Antigravity: FLAT plugin.json carrying a protocol number that must survive.
  mkdirSync(join(pluginsDir, 'adlc-antigravity'), { recursive: true });
  write(join(pluginsDir, 'adlc-antigravity', 'package.json'), { name: '@adlc/antigravity', version: current, private: true });
  write(join(pluginsDir, 'adlc-antigravity', 'plugin.json'), {
    name: 'adlc-antigravity',
    version: stranded,
    adlcContract: 1,
  });

  // Root Claude Code marketplace — metadata.version AND every plugins[].version.
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  write(join(root, '.claude-plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { description: 'fixture', version: stranded },
    plugins: [{ name: 'adlc', source: './plugins/adlc-claude-code', version: stranded }],
  });

  // A worktree decoy. Recursive globbing would rewrite this; depth-exact will not.
  mkdirSync(join(root, '.worktrees', 'wt', '.claude-plugin'), { recursive: true });
  write(join(root, '.worktrees', 'wt', '.claude-plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { version: stranded },
    plugins: [{ name: 'adlc', version: stranded }],
  });

  return { root, packagesDir, pluginsDir };
}

// --- AC1 -------------------------------------------------------------------

test('claude-plugin bump reaches every host manifest shape and preserves adlcContract', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const rc = releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {} });
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

    // F5: adlcContract is a protocol number, not a release version.
    assert.equal(readJson(join(pluginsDir, 'adlc-antigravity', 'plugin.json')).adlcContract, 1,
      'adlcContract must be left untouched by the bump');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC2 -------------------------------------------------------------------

test('drift gate flags every stranded host manifest the bumper touches', () => {
  const { root, packagesDir, pluginsDir } = makeRepo({ stranded: '0.2.0', current: '9.9.9' });
  try {
    const problems = findVersionDrift('9.9.9', { root, packagesDir, pluginsDir });
    const blob = problems.join('\n');

    assert.ok(problems.length > 0, 'stranded manifests must produce drift');
    assert.match(blob, /adlc-claude-code[/\\]\.claude-plugin[/\\]plugin\.json/,
      'must flag the stranded Claude Code plugin.json');
    assert.match(blob, /\.claude-plugin[/\\]marketplace\.json metadata\.version/,
      'must flag stranded marketplace metadata.version');
    assert.match(blob, /\.claude-plugin[/\\]marketplace\.json plugin adlc/,
      'must flag the stranded marketplace plugin entry');
    assert.match(blob, /adlc-antigravity[/\\]plugin\.json/,
      'must flag the stranded FLAT plugin.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drift gate is clean once the generalized bump has run', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {} });
    assert.deepEqual(findVersionDrift('9.9.9', { root, packagesDir, pluginsDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC3 -------------------------------------------------------------------

test('unknown host directories are discovered without editing release.mjs', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    // A host nobody has written a loop for. Glob-driven discovery covers it;
    // a third hardcoded pair would not.
    mkdirSync(join(pluginsDir, 'adlc-future', '.future-plugin'), { recursive: true });
    write(join(pluginsDir, 'adlc-future', '.future-plugin', 'plugin.json'), {
      name: 'adlc-future',
      version: '0.2.0',
    });
    mkdirSync(join(root, '.future-plugin'), { recursive: true });
    write(join(root, '.future-plugin', 'marketplace.json'), {
      name: 'adlc',
      metadata: { version: '0.2.0' },
      plugins: [{ name: 'adlc-future', version: '0.2.0' }],
    });

    const before = findVersionDrift('9.9.9', { root, packagesDir, pluginsDir }).join('\n');
    assert.match(before, /adlc-future[/\\]\.future-plugin[/\\]plugin\.json/,
      'an unknown host plugin.json must be drift-flagged');
    assert.match(before, /\.future-plugin[/\\]marketplace\.json/,
      'an unknown host marketplace must be drift-flagged');

    const rc = releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {} });
    assert.equal(rc, 0);
    assert.equal(ver(join(pluginsDir, 'adlc-future', '.future-plugin', 'plugin.json')), '9.9.9');
    assert.equal(readJson(join(root, '.future-plugin', 'marketplace.json')).metadata.version, '9.9.9');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown host discovery never walks into .worktrees or node_modules', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['9.9.9'], { root, packagesDir, pluginsDir, regenerateLockfile: () => {} });

    // F1: 21 such copies exist in the real repo. Rewriting them would corrupt
    // unrelated in-flight branches.
    const decoy = join(root, '.worktrees', 'wt', '.claude-plugin', 'marketplace.json');
    assert.equal(readJson(decoy).metadata.version, '0.2.0',
      'the worktree decoy must NOT be rewritten — discovery must be depth-exact');

    const marketplaces = hostMarketplacePaths(root);
    assert.ok(marketplaces.every((p) => !p.includes('.worktrees')),
      'hostMarketplacePaths must not return worktree copies');
    const manifests = hostPluginManifestPaths(pluginsDir);
    assert.ok(manifests.every((p) => !p.includes('node_modules')),
      'hostPluginManifestPaths must not return node_modules copies');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC4 -------------------------------------------------------------------

/** A package whose lib/ imports outward, with a controllable `files` allowlist. */
function makePackagingFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-packing-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(join(packagesDir, 'escaper', 'lib'), { recursive: true });
  mkdirSync(join(packagesDir, 'escaper', 'scripts'), { recursive: true });
  mkdirSync(pluginsDir);
  write(join(packagesDir, 'escaper', 'package.json'), {
    name: '@adlc/escaper',
    version: '1.0.0',
    type: 'module',
    repository: { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' },
    files,
  });
  // The exact shape of Defect B: a TOP-LEVEL import escaping the allowlist.
  writeFileSync(join(packagesDir, 'escaper', 'lib', 'doctor.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
    "import { thing } from '@adlc/core';\n" +
    "import { generateAll } from '../scripts/gen-schema.mjs';\n" +
    "export { generateAll, readFileSync, thing };\n");
  writeFileSync(join(packagesDir, 'escaper', 'scripts', 'gen-schema.mjs'),
    'export const generateAll = () => ({});\n');
  return { root, packagesDir, pluginsDir };
}

test('files allowlist gate flags a shipped import that escapes the tarball', () => {
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'README.md']);
  try {
    const problems = findPackagingProblems({ packagesDir, pluginsDir });
    assert.ok(problems.length > 0, 'an escaping import must be reported');
    assert.match(problems.join('\n'), /scripts[/\\]gen-schema\.mjs/,
      'the report must name the missing file');
    assert.match(problems.join('\n'), /@adlc\/escaper/, 'the report must name the package');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('files allowlist gate is silent when the import is admitted', () => {
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'scripts/', 'README.md']);
  try {
    assert.deepEqual(findPackagingProblems({ packagesDir, pluginsDir }), [],
      'admitting scripts/ must clear the problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('files allowlist gate ignores builtins and bare specifiers', () => {
  // F3: node: builtins and bare package specifiers are dependency-resolved, not
  // file-shipped. Flagging them would make the gate unusable.
  const { root, packagesDir, pluginsDir } = makePackagingFixture(['lib/', 'scripts/']);
  try {
    const problems = findPackagingProblems({ packagesDir, pluginsDir }).join('\n');
    assert.doesNotMatch(problems, /node:fs/, 'node: builtins must never be flagged');
    assert.doesNotMatch(problems, /@adlc\/core/, 'bare specifiers must never be flagged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC5 / AC7: the REAL repo, not a fixture --------------------------------

test('ticket-sync doctor: the real repo ships every file its code imports', () => {
  const problems = findPackagingProblems({
    packagesDir: join(REPO_ROOT, 'packages'),
    pluginsDir: join(REPO_ROOT, 'plugins'),
  });
  assert.deepEqual(problems, [],
    'no published package may import a file its files allowlist excludes');
});

test('the real repo is in host-manifest lockstep at the root version', () => {
  const rootVersion = readJson(join(REPO_ROOT, 'package.json')).version;
  const drift = findVersionDrift(rootVersion, {
    root: REPO_ROOT,
    packagesDir: join(REPO_ROOT, 'packages'),
    pluginsDir: join(REPO_ROOT, 'plugins'),
  });
  assert.deepEqual(drift, [], `repo must be in lockstep at ${rootVersion}`);
});

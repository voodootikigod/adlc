// release.test.mjs — the lockstep release is the moment version drift creeps in
// (a bump that misses a package.json, or leaves package-lock.json stale), so the
// release helper gets a committed regression test. Drives releaseMain against a
// throwaway fake repo with an injected lockfile-regen spy (no real npm, offline,
// leaves no trace).
//
// Regression context: v1.1.0 was bumped across packages/* + root but the bump
// (a) never regenerated package-lock.json (it stayed at 1.0.2 → npm ci broke) and
// (b) skipped plugins/adlc-pi (stranded at 1.0.2). These tests pin BOTH gaps shut.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseMain, repinInternalDependencies, packagePublishOrder, findVersionDrift, publishTargets, findPublishMetadataProblems, defaultIsPublished, hostMarketplacePaths, hostTomlManifestPaths, hostDiscoveryNearMisses } from '../release.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

/** Build a throwaway repo with package and Codex-manifest version surfaces. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-release-'));
  fixtureDirs.add(root);
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);
  const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  // Every non-private publish target must carry a repository.url or npm provenance
  // 422s mid-publish (findPublishMetadataProblems guards this).
  const repository = { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' };
  const publishConfig = { access: 'public', provenance: true };
  write(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
  mkdirSync(join(packagesDir, 'core'));
  write(join(packagesDir, 'core', 'package.json'), { name: '@adlc/core', version: '1.0.0', repository, publishConfig });
  mkdirSync(join(packagesDir, 'cli'));
  write(join(packagesDir, 'cli', 'package.json'), {
    name: '@adlc/cli',
    version: '1.0.0',
    repository,
    publishConfig,
    dependencies: { '@adlc/core': '1.0.0' }, // packages pin exactly
  });
  mkdirSync(join(pluginsDir, 'adlc-pi'));
  write(join(pluginsDir, 'adlc-pi', 'package.json'), {
    name: '@adlc/pi',
    version: '1.0.0',
    private: true,
    dependencies: { '@adlc/core': '^1.0.0' }, // plugin uses a caret range
  });
  // A plugin directory with NO package.json (e.g. adlc-claude-code) must be skipped.
  mkdirSync(join(pluginsDir, 'adlc-claude-code'));
  mkdirSync(join(pluginsDir, 'adlc-codex', '.codex-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-codex', 'package.json'), {
    name: '@adlc/codex',
    version: '1.0.0',
    repository,
    publishConfig,
    dependencies: { '@adlc/cli': '1.0.0' },
  });
  write(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json'), {
    name: 'adlc-codex',
    version: '1.0.0',
  });
  mkdirSync(join(pluginsDir, 'adlc-cursor', '.cursor-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-cursor', 'package.json'), {
    name: '@adlc/cursor',
    version: '1.0.0',
    repository,
    publishConfig,
    dependencies: { '@adlc/cli': '1.0.0' },
  });
  write(join(pluginsDir, 'adlc-cursor', '.cursor-plugin', 'plugin.json'), {
    name: 'adlc-cursor',
    version: '1.0.0',
  });
  // Two plugin entries — a marketplace fix that only updates plugins[0] must be
  // caught, not just a fix that updates *a* entry (see the split drift tests below).
  mkdirSync(join(root, '.cursor-plugin'), { recursive: true });
  write(join(root, '.cursor-plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { description: 'fixture marketplace', version: '1.0.0' },
    plugins: [
      { name: 'adlc-cursor', source: './plugins/adlc-cursor', version: '1.0.0' },
      { name: 'adlc-second', source: './plugins/adlc-second', version: '1.0.0' },
    ],
  });
  return { root, packagesDir, pluginsDir };
}

const ver = (p) => JSON.parse(readFileSync(p, 'utf8')).version;

test('releaseMain bumps packages, versioned plugins, and root in lockstep', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    let regen = 0;
    const rc = releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile: () => regen++ });
    assert.equal(rc, 0);
    assert.equal(ver(join(root, 'package.json')), '1.2.0');
    assert.equal(ver(join(packagesDir, 'core', 'package.json')), '1.2.0');
    assert.equal(ver(join(packagesDir, 'cli', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-pi', 'package.json')), '1.2.0'); // NOT stranded
    assert.equal(ver(join(pluginsDir, 'adlc-codex', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-cursor', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-cursor', '.cursor-plugin', 'plugin.json')), '1.2.0');
    const marketplace = JSON.parse(readFileSync(join(root, '.cursor-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.metadata.version, '1.2.0');
    assert.equal(marketplace.plugins[0].version, '1.2.0');
    assert.equal(marketplace.plugins[1].version, '1.2.0'); // every entry, not just index 0
    assert.equal(regen, 1); // lockfile regenerated exactly once
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain invokes the Cursor MCP builder with the fixture root after version bump', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  const cursorBin = join(pluginsDir, 'adlc-cursor', 'bin');
  mkdirSync(cursorBin);
  writeFileSync(join(cursorBin, 'adlc-mcp-wrapper.mjs'), '// fixture wrapper\n');
  const calls = [];
  try {
    const rc = releaseMain(['1.2.0'], {
      root, packagesDir, pluginsDir, regenerateLockfile() {},
      cursorMcpBuilder(options) { calls.push(options); },
    });
    assert.equal(rc, 0);
    assert.deepEqual(calls, [{ root, write: true }]);
    assert.equal(ver(join(pluginsDir, 'adlc-cursor', 'package.json')), '1.2.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain --publish refuses stale embedded Cursor metadata before publish', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  const cursor = join(pluginsDir, 'adlc-cursor');
  mkdirSync(join(cursor, 'bin'));
  mkdirSync(join(cursor, 'lib'));
  writeFileSync(join(cursor, 'bin', 'adlc-mcp-wrapper.mjs'), '// fixture wrapper\n');
  writeFileSync(join(cursor, 'lib', 'mcp-build-metadata.mjs'), "pluginVersion: '1.0.0'\n");
  let published = 0;
  try {
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir, regenerateLockfile() {},
      cursorMcpBuilder({ root: builderRoot }) {
        assert.equal(builderRoot, root);
        const pluginVersion = ver(join(builderRoot, 'plugins', 'adlc-cursor', 'package.json'));
        const embedded = readFileSync(join(builderRoot, 'plugins', 'adlc-cursor', 'lib', 'mcp-build-metadata.mjs'), 'utf8');
        if (!embedded.includes(`pluginVersion: '${pluginVersion}'`)) throw new Error('stale embedded metadata');
      },
      publishImpl() { published += 1; },
    });
    assert.equal(rc, 1);
    assert.equal(published, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain repins internal @adlc deps, preserving range prefixes', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const cli = JSON.parse(readFileSync(join(packagesDir, 'cli', 'package.json'), 'utf8'));
    assert.equal(cli.dependencies['@adlc/core'], '1.2.0'); // exact stays exact
    const pi = JSON.parse(readFileSync(join(pluginsDir, 'adlc-pi', 'package.json'), 'utf8'));
    assert.equal(pi.dependencies['@adlc/core'], '^1.2.0'); // caret preserved, version moved
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift flags a stranded plugin package', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.length >= 1);
    assert.ok(drift.some((d) => d.includes('adlc-pi')), `expected a plugin entry, got: ${drift.join(' | ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift flags a stale Codex manifest independently of package.json', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const manifest = join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json');
    writeFileSync(manifest, '{"name":"adlc-codex","version":"1.1.0"}\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('.codex-plugin')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: a lockstep bump left plugins/adlc-cursor/.cursor-plugin/plugin.json
// and the root .cursor-plugin/marketplace.json (both entry.version and
// metadata.version) stranded at the prior version, because releaseMain only ever
// walked Codex plugin manifests. cursor-install-smoke.mjs's T47 lockstep check
// caught it; this pins the fix shut the same way the Codex-manifest test does.
test('findVersionDrift flags a stale Cursor manifest independently of package.json', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const manifest = join(pluginsDir, 'adlc-cursor', '.cursor-plugin', 'plugin.json');
    writeFileSync(manifest, '{"name":"adlc-cursor","version":"1.1.0"}\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('.cursor-plugin')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Isolates the metadata.version invariant: both plugin entries are current, only
// metadata.version is stale. A drift check that only walks `plugins[]` (and never
// looks at `metadata`) would wrongly report no drift here.
test('findVersionDrift flags a stale marketplace metadata.version even when every plugin entry is current', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const marketplacePath = join(root, '.cursor-plugin', 'marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    marketplace.metadata.version = '1.1.0'; // stale metadata; both plugin entries stay at 1.2.0
    writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('marketplace.json') && entry.includes('metadata.version')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Isolates the per-entry invariant on the SECOND entry specifically: metadata and
// plugins[0] are current, only plugins[1] is stale. A drift check hardcoded to
// plugins[0] (an index-0-only regression) would wrongly report no drift here.
test('findVersionDrift flags a stale non-first marketplace plugin entry with metadata current', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const marketplacePath = join(root, '.cursor-plugin', 'marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    marketplace.plugins[1].version = '1.1.0'; // stale second entry; metadata + plugins[0] stay at 1.2.0
    writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('marketplace.json') && entry.includes('adlc-second')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift returns empty once releaseMain has bumped everything', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    assert.deepEqual(findVersionDrift('1.2.0', { root, packagesDir, pluginsDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain rejects an invalid version (and does not regenerate the lockfile)', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    let regen = 0;
    const rc = releaseMain(['not-semver'], { root, packagesDir, pluginsDir, regenerateLockfile: () => regen++ });
    assert.equal(rc, 1);
    assert.equal(regen, 0);
    assert.equal(ver(join(root, 'package.json')), '1.0.0'); // untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packagePublishOrder keeps core first and cli last', () => {
  assert.deepEqual(packagePublishOrder(['cli', 'rails-guard', 'core']), ['core', 'rails-guard', 'cli']);
});

test('repinInternalDependencies leaves non-@adlc deps alone', () => {
  const out = repinInternalDependencies(
    { name: 'x', version: '1.0.0', dependencies: { '@adlc/core': '1.0.0', chalk: '^5.0.0' } },
    '2.0.0'
  );
  assert.equal(out.version, '2.0.0');
  assert.equal(out.dependencies['@adlc/core'], '2.0.0');
  assert.equal(out.dependencies.chalk, '^5.0.0'); // untouched
});

// ---- T30: the publish step must include publishable (non-private) plugin packages ----
test('publishTargets: non-private plugin packages publish after packages/*; private plugins are skipped', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    // a publishable plugin (like @adlc/opencode after T30)
    mkdirSync(join(pluginsDir, 'adlc-opencode'));
    writeFileSync(join(pluginsDir, 'adlc-opencode', 'package.json'), JSON.stringify({
      name: '@adlc/opencode', version: '1.0.0',
      dependencies: { '@adlc/core': '1.0.0' },
    }, null, 2) + '\n');
    const targets = publishTargets({ packagesDir, pluginsDir });
    const names = targets.map((t) => t.name);
    assert.ok(names.includes('@adlc/opencode'), 'publishable plugin included');
    // dependency order: every packages/* entry precedes the plugin consumers
    assert.ok(names.indexOf('@adlc/core') < names.indexOf('@adlc/opencode'));
    // private plugins (adlc-pi fixture is private in makeRepo? assert on the actual fixture)
    for (const t of targets) assert.notEqual(t.private, true, `${t.name} must not be private`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain --publish invokes publishImpl for plugin packages too', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(pluginsDir, 'adlc-opencode'));
    writeFileSync(join(pluginsDir, 'adlc-opencode', 'package.json'), JSON.stringify({
      name: '@adlc/opencode', version: '1.0.0',
      repository: { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' },
    }, null, 2) + '\n');
    const published = [];
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      publishImpl: (_dir, name) => published.push(name),
      isPublished: () => false,
    });
    assert.equal(rc, 0);
    assert.ok(published.includes('@adlc/opencode'), `published: ${published}`);
    assert.ok(published.includes('@adlc/core'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- resumable publish (v1.11.1's shape: 30/39 published, then a real failure) --

test('releaseMain --publish skips a target isPublished already reports true, without calling publishImpl', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const published = [];
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      publishImpl: (_dir, name) => published.push(name),
      isPublished: (name) => name === '@adlc/core',
    });
    assert.equal(rc, 0);
    assert.ok(!published.includes('@adlc/core'), 'already-published target must not be re-published');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain --publish is resumable: a mid-run failure, then a re-run with the failed target now succeeding, publishes only what was missing', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(pluginsDir, 'adlc-opencode'));
    writeFileSync(join(pluginsDir, 'adlc-opencode', 'package.json'), JSON.stringify({
      name: '@adlc/opencode', version: '1.0.0',
      repository: { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' },
    }, null, 2) + '\n');
    // First "run": core succeeds, opencode fails (simulating the real v1.11.1
    // incident — a later target's publish genuinely fails after earlier ones land).
    const firstRunPublished = [];
    assert.throws(() => releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      isPublished: () => false,
      publishImpl: (_dir, name) => {
        if (name === '@adlc/opencode') throw new Error('simulated real publish failure');
        firstRunPublished.push(name);
      },
    }));
    assert.ok(firstRunPublished.includes('@adlc/core'), 'core published before the simulated failure');

    // Re-run: core now reports already-published; opencode does not, and this
    // time succeeds. Only opencode should actually invoke publishImpl.
    const secondRunPublished = [];
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      isPublished: (name) => firstRunPublished.includes(name),
      publishImpl: (_dir, name) => secondRunPublished.push(name),
    });
    assert.equal(rc, 0);
    assert.deepEqual(secondRunPublished, ['@adlc/opencode'], 'only the previously-failed target is (re)published');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('defaultIsPublished reflects the real npm registry: true for a version that actually shipped, false for one that never existed', () => {
  // No network mock here by design — this is the one pair of assertions that
  // exercises the REAL default end-to-end, against a package guaranteed to
  // exist (this very suite) with a version guaranteed to (1.0.0, its first
  // published release) and one guaranteed never to. `--publish` tests
  // everywhere else inject a fake isPublished specifically so they stay
  // offline; this is the sole exception, matching the file's own documented
  // pattern for defaultPublishImpl itself (never invoked in tests, but
  // present and directly checkable). This positive case is also what pins
  // the runView call's own 'version' field selector: dropping it would make
  // npm view return the full package.json dump, which can never equal the
  // bare version string.
  assert.equal(defaultIsPublished('@adlc/core', '1.0.0'), true);
  assert.equal(defaultIsPublished('@adlc/core', '0.0.0-does-not-exist'), false);
});

test('defaultIsPublished requires BOTH a zero exit AND matching stdout — a status/stdout split (impossible via a real npm view call for one exact version) must read false either way', () => {
  // npm view for one EXACT version either fully matches or fully fails; it
  // never returns a zero exit with different content, or a nonzero exit with
  // the right content. That combination is only reachable by injecting the
  // subprocess call directly, which is the point: it is what tells an AND
  // apart from an OR here at all.
  assert.equal(defaultIsPublished('@adlc/x', '1.2.3', () => ({ status: 0, stdout: 'not-1.2.3\n' })), false);
  assert.equal(defaultIsPublished('@adlc/x', '1.2.3', () => ({ status: 1, stdout: '1.2.3\n' })), false);
  assert.equal(defaultIsPublished('@adlc/x', '1.2.3', () => ({ status: 0, stdout: '1.2.3\n' })), true);
});

test('findPublishMetadataProblems flags a publish target with missing/empty repository.url', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    assert.deepEqual(findPublishMetadataProblems({ packagesDir, pluginsDir }), []);
    // Empty repository.url — the exact @adlc/tickets condition that 422'd the
    // v1.4.0 provenance publish mid-flight.
    writeFileSync(join(packagesDir, 'core', 'package.json'), JSON.stringify({
      name: '@adlc/core', version: '1.0.0', repository: { url: '' }, publishConfig: { access: 'public' },
    }, null, 2) + '\n');
    const problems = findPublishMetadataProblems({ packagesDir, pluginsDir });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /@adlc\/core/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain --publish fails closed and publishes NOTHING when a target lacks repository.url', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    // Strip repository from a non-private target — a partial lockstep publish must
    // not be possible; the whole suite ships or none of it does.
    writeFileSync(join(packagesDir, 'core', 'package.json'), JSON.stringify({
      name: '@adlc/core', version: '1.0.0',
    }, null, 2) + '\n');
    const published = [];
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      publishImpl: (_dir, name) => published.push(name),
    });
    assert.equal(rc, 1);
    assert.equal(published.length, 0, `nothing should publish; got: ${published}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- T-01KZGT27XA: publish order must be DEPENDENCY order --------------------
// publishTargets documented "dependency order" while implementing directory
// order. npm publish does not validate dependencies, so a complete run hides
// it — the defect fires on a PARTIAL failure, stranding an already-published
// dependent whose exact-pinned dependency never shipped (the v1.4.0 shape).
// Found at 17 violations on the real tree, including core (slot 0) pinning
// tickets (slot 29).

import { fileURLToPath } from 'node:url';

const REAL_REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Bare fixture: a packages/ tree with exactly the given manifests. */
function depsRepo(packages, plugins = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-order-'));
  fixtureDirs.add(root);
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  for (const [dir, pkg] of Object.entries(packages)) {
    mkdirSync(join(packagesDir, dir));
    writeFileSync(join(packagesDir, dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }
  for (const [dir, pkg] of Object.entries(plugins)) {
    mkdirSync(join(pluginsDir, dir));
    writeFileSync(join(pluginsDir, dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }
  return { root, packagesDir, pluginsDir };
}

test('publishTargets: the REAL tree publishes every runtime dependency before its dependents', () => {
  const targets = publishTargets({
    packagesDir: join(REAL_REPO, 'packages'),
    pluginsDir: join(REAL_REPO, 'plugins'),
  });
  const idx = new Map(targets.map((t, i) => [t.name, i]));
  for (const [i, t] of targets.entries()) {
    const pkg = JSON.parse(readFileSync(join(t.dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(deps)) {
      if (!idx.has(name)) continue;
      assert.ok(idx.get(name) < i, `${t.name} (slot ${i}) publishes before its dependency ${name} (slot ${idx.get(name)})`);
    }
  }
});

test('publishTargets: quartermaster precedes fleet — the 1.8.0 near-miss, pinned', () => {
  const names = publishTargets({
    packagesDir: join(REAL_REPO, 'packages'),
    pluginsDir: join(REAL_REPO, 'plugins'),
  }).map((t) => t.name);
  assert.ok(
    names.indexOf('@adlc/quartermaster') < names.indexOf('@adlc/fleet'),
    'fleet exact-pins quartermaster; a partial run publishing fleet first strands it uninstallable'
  );
});

test('publishTargets: order does not follow directory names — a dependency later in the alphabet still goes first', () => {
  const { root, packagesDir, pluginsDir } = depsRepo({
    aa: { name: '@adlc/aa', version: '1.0.0', dependencies: { '@adlc/zz': '1.0.0' } },
    mm: { name: '@adlc/mm', version: '1.0.0', dependencies: { '@adlc/aa': '1.0.0' } },
    zz: { name: '@adlc/zz', version: '1.0.0' },
  });
  try {
    const first = publishTargets({ packagesDir, pluginsDir }).map((t) => t.name);
    assert.deepEqual(first, ['@adlc/zz', '@adlc/aa', '@adlc/mm']);
    // Determinism: a second call yields the identical order.
    const second = publishTargets({ packagesDir, pluginsDir }).map((t) => t.name);
    assert.deepEqual(second, first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publishTargets: a dependency cycle fails closed, naming the packages', () => {
  const { root, packagesDir, pluginsDir } = depsRepo({
    ping: { name: '@adlc/ping', version: '1.0.0', dependencies: { '@adlc/pong': '1.0.0' } },
    pong: { name: '@adlc/pong', version: '1.0.0', dependencies: { '@adlc/ping': '1.0.0' } },
  });
  try {
    assert.throws(
      () => publishTargets({ packagesDir, pluginsDir }),
      (err) => /@adlc\/ping/.test(err.message) && /@adlc\/pong/.test(err.message),
      'an arbitrary order on a cycle is a coin flip; the release must stop instead'
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publishTargets: an optionalDependencies edge constrains order like a runtime dep', () => {
  // optionalDependencies install by default, so a dependent published before
  // its optional dep is just as stranded as with a hard dep. This fixture's
  // ONLY edge is optional, and the names are chosen so alphabetical order
  // gets it wrong — dropping 'optionalDependencies' from the kind list
  // reverts to alphabetical and fails here.
  const { root, packagesDir, pluginsDir } = depsRepo({
    aopt: { name: '@adlc/aopt', version: '1.0.0', optionalDependencies: { '@adlc/zopt': '1.0.0' } },
    zopt: { name: '@adlc/zopt', version: '1.0.0' },
  });
  try {
    const names = publishTargets({ packagesDir, pluginsDir }).map((t) => t.name);
    assert.deepEqual(names, ['@adlc/zopt', '@adlc/aopt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publishTargets: devDependencies do not constrain order — a dev-only cycle is not a cycle', () => {
  const { root, packagesDir, pluginsDir } = depsRepo({
    app: { name: '@adlc/app', version: '1.0.0', dependencies: { '@adlc/lib': '1.0.0' } },
    lib: { name: '@adlc/lib', version: '1.0.0', devDependencies: { '@adlc/app': '1.0.0' } },
  });
  try {
    const names = publishTargets({ packagesDir, pluginsDir }).map((t) => t.name);
    assert.deepEqual(names, ['@adlc/lib', '@adlc/app'], 'runtime edge app→lib holds; the dev back-edge must not create a cycle');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publishTargets: plugins still publish after all packages, in dependency order among themselves', () => {
  const { root, packagesDir, pluginsDir } = depsRepo(
    { core: { name: '@adlc/core', version: '1.0.0' } },
    {
      'adlc-early': { name: '@adlc/early', version: '1.0.0', dependencies: { '@adlc/late': '1.0.0' } },
      'adlc-late': { name: '@adlc/late', version: '1.0.0', dependencies: { '@adlc/core': '1.0.0' } },
    }
  );
  try {
    const names = publishTargets({ packagesDir, pluginsDir }).map((t) => t.name);
    assert.deepEqual(names, ['@adlc/core', '@adlc/late', '@adlc/early']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const writeListing = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const readListing = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** True when a marketplace listing carries any version the bumper would own. */
function carriesVersion(listing) {
  return 'version' in (listing.metadata ?? {}) || (listing.plugins ?? []).some((entry) => 'version' in entry);
}

test('every tracked marketplace.json that carries a version is a surface the bump and drift gate cover', () => {
  const tracked = execFileSync('git', ['ls-files', '*marketplace.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((rel) => carriesVersion(readListing(join(REPO_ROOT, rel))));
  assert.ok(tracked.includes('.github/plugin/marketplace.json'));
  const covered = new Set(hostMarketplacePaths(REPO_ROOT).map((p) => p.slice(REPO_ROOT.length + 1)));
  assert.deepEqual(tracked.filter((rel) => !covered.has(rel)), []);
});

test('the Copilot marketplace listing is at the suite version', () => {
  const version = readListing(join(REPO_ROOT, 'package.json')).version;
  const drift = findVersionDrift(version).filter((entry) => entry.includes(join('.github', 'plugin', 'marketplace.json')));
  assert.deepEqual(drift, []);
});

/** Minimal repo: a root package.json and a stale .github/plugin marketplace. */
function makeMarketplaceRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-release-marketplace-'));
  fixtureDirs.add(root);
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);
  writeListing(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
  mkdirSync(join(root, '.github', 'plugin'), { recursive: true });
  writeListing(join(root, '.github', 'plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { description: 'x', version: '1.0.0' },
    plugins: [{ name: 'adlc-copilot', version: '1.0.0', source: './plugins/adlc-copilot' }],
  });
  return { root, packagesDir, pluginsDir };
}

test('findVersionDrift reports a stale .github/plugin/marketplace.json', () => {
  const { root, packagesDir, pluginsDir } = makeMarketplaceRepo();
  try {
    writeListing(join(root, 'package.json'), { name: 'adlc', version: '1.2.0', private: true });
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    const path = join(root, '.github', 'plugin', 'marketplace.json');
    assert.deepEqual(drift, [
      `${path} metadata.version: 1.0.0 != 1.2.0`,
      `${path} plugin adlc-copilot: 1.0.0 != 1.2.0`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain bumps .github/plugin/marketplace.json in lockstep', () => {
  const { root, packagesDir, pluginsDir } = makeMarketplaceRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const listing = readListing(join(root, '.github', 'plugin', 'marketplace.json'));
    assert.equal(listing.metadata.version, '1.2.0');
    assert.equal(listing.plugins[0].version, '1.2.0');
    assert.equal(listing.metadata.description, 'x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo without .github/plugin/marketplace.json gains no such file from a release', () => {
  const { root, packagesDir, pluginsDir } = makeMarketplaceRepo();
  try {
    rmSync(join(root, '.github'), { recursive: true, force: true });
    assert.deepEqual(hostMarketplacePaths(root), []);
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    assert.deepEqual(hostMarketplacePaths(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#868/#858: hostTomlManifestPaths discovers herdr-plugin.toml on the real repo and findVersionDrift reports lockstep', () => {
  const version = readListing(join(REPO_ROOT, 'package.json')).version;
  const tomls = hostTomlManifestPaths(join(REPO_ROOT, 'plugins'));
  assert.ok(tomls.some((p) => p.endsWith(join('adlc-herdr', 'herdr-plugin.toml'))), 'herdr-plugin.toml must be discovered');
  assert.deepEqual(findVersionDrift(version, {
    root: REPO_ROOT,
    packagesDir: join(REPO_ROOT, 'packages'),
    pluginsDir: join(REPO_ROOT, 'plugins'),
  }), []);
});

test('#868/#858: releaseMain bumps herdr-plugin.toml (preserving min_herdr_version), findVersionDrift flags stale TOML, and near-miss catches versionless TOML', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(pluginsDir, 'adlc-herdr'), { recursive: true });
    writeListing(join(pluginsDir, 'adlc-herdr', 'package.json'), {
      name: '@adlc/herdr',
      version: '1.0.0',
      private: true,
    });
    const tomlPath = join(pluginsDir, 'adlc-herdr', 'herdr-plugin.toml');
    writeFileSync(tomlPath, [
      'id = "adlc"',
      'name = "ADLC"',
      'version = "0.2.0"',
      'min_herdr_version = "0.7.4"',
      '',
    ].join('\n'));

    // Decoys in pluginsDir: node_modules, a stray file, a bare -plugin.toml, and a hidden .herdr-plugin.toml are ignored.
    mkdirSync(join(pluginsDir, 'node_modules'), { recursive: true });
    writeFileSync(join(pluginsDir, 'node_modules', 'vendored-plugin.toml'), 'version = "0.0.1"\n');
    writeFileSync(join(pluginsDir, 'NOTES.md'), '# stray file\n');
    writeFileSync(join(pluginsDir, 'adlc-herdr', '-plugin.toml'), 'version = "0.0.1"\n');
    writeFileSync(join(pluginsDir, 'adlc-herdr', '.herdr-plugin.toml'), 'version = "0.0.1"\n');
    assert.deepEqual(hostTomlManifestPaths(join(root, 'no-such-plugins')), []);
    assert.deepEqual(hostTomlManifestPaths(pluginsDir), [tomlPath]);

    // 1. findVersionDrift flags the stranded TOML manifest.
    const driftBefore = findVersionDrift('1.0.0', { root, packagesDir, pluginsDir });
    assert.ok(driftBefore.includes(`${tomlPath}: 0.2.0 != 1.0.0`));

    // 2. releaseMain bumps version in herdr-plugin.toml while preserving min_herdr_version.
    const rc = releaseMain(['1.2.0'], {
      root,
      packagesDir,
      pluginsDir,
      regenerateLockfile: (r) => writeListing(join(r, 'package-lock.json'), { name: 'adlc', version: '1.2.0' }),
    });
    assert.equal(rc, 0);
    const bumpedToml = readFileSync(tomlPath, 'utf8');
    assert.match(bumpedToml, /^version = "1\.2\.0"$/m);
    assert.match(bumpedToml, /^min_herdr_version = "0\.7\.4"$/m);
    assert.deepEqual(findVersionDrift('1.2.0', { root, packagesDir, pluginsDir }), []);

    // 3. A TOML host manifest without a string version field is flagged by hostDiscoveryNearMisses and aborts releaseMain preflight.
    writeFileSync(tomlPath, 'id = "adlc"\nname = "ADLC"\nmin_herdr_version = "0.7.4"\n');
    const misses = hostDiscoveryNearMisses({ root, pluginsDir });
    assert.ok(misses.some((m) => m.includes(tomlPath) && m.includes('no string "version"')));
    const rcAbort = releaseMain(['1.3.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    assert.equal(rcAbort, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#869: .claude/release-profile.md verify block fails closed on 0 enumerated targets and reports verified N/N on success', async () => {
  const { spawnSync } = await import('node:child_process');
  const profile = readFileSync(join(REPO_ROOT, '.' + 'claude', 'release-profile.md'), 'utf8');
  const match = profile.match(/verify:\n  - \|\n([\s\S]*?)\n---/);
  assert.ok(match, 'verify block must exist in .claude/release-profile.md');
  const rawScript = match[1]
    .split('\n')
    .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
    .join('\n')
    .replaceAll('{{version}}', '1.2.3');

  // Case 1: Empty directory (0 targets enumerated) -> exits 1 with refusal message.
  const emptyDir = mkdtempSync(join(tmpdir(), 'adlc-verify-empty-'));
  try {
    mkdirSync(join(emptyDir, 'packages'));
    mkdirSync(join(emptyDir, 'plugins'));
    const res = spawnSync('sh', ['-c', rawScript], { cwd: emptyDir, encoding: 'utf8' });
    assert.equal(res.status, 1, 'verify block must exit 1 when 0 targets are enumerated');
    assert.match(res.stderr + res.stdout, /verify enumerated 0 targets/);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  // Case 2: Non-empty enumeration with a stub npm that reports 1.2.3 -> exits 0 and prints verified 1/1 targets.
  const okDir = mkdtempSync(join(tmpdir(), 'adlc-verify-ok-'));
  try {
    mkdirSync(join(okDir, 'packages', 'core'), { recursive: true });
    mkdirSync(join(okDir, 'plugins'), { recursive: true });
    writeListing(join(okDir, 'packages', 'core', 'package.json'), { name: '@adlc/core', version: '1.2.3' });
    const binDir = join(okDir, 'bin');
    mkdirSync(binDir);
    const fakeNpm = join(binDir, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\necho "1.2.3"\n', { mode: 0o755 });
    const res = spawnSync('sh', ['-c', rawScript], {
      cwd: okDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /verified 1\/1 targets/);
  } finally {
    rmSync(okDir, { recursive: true, force: true });
  }
});

test('#871/#873: every real non-private publish target declares publishConfig.access=public and release docs/workflow match', () => {
  const realTargets = publishTargets({
    packagesDir: join(REAL_REPO, 'packages'),
    pluginsDir: join(REAL_REPO, 'plugins'),
  });
  assert.ok(realTargets.length >= 30, `expected >= 30 real publish targets, got ${realTargets.length}`);
  for (const target of realTargets) {
    const pkg = JSON.parse(readFileSync(join(target.dir, 'package.json'), 'utf8'));
    assert.equal(pkg.publishConfig?.access, 'public', `${target.name} must declare publishConfig.access: "public"`);
  }
  assert.deepEqual(findPublishMetadataProblems({
    packagesDir: join(REAL_REPO, 'packages'),
    pluginsDir: join(REAL_REPO, 'plugins'),
  }), [], 'every real non-private publish target must carry repository.url');

  const pubWorkflow = readFileSync(join(REAL_REPO, '.github/workflows/publish.yml'), 'utf8');
  assert.match(pubWorkflow, /npm install -g --ignore-scripts npm@11\.\d+\.\d+/, 'publish.yml must pin an exact npm 11.x version');
  assert.doesNotMatch(pubWorkflow, /npm install -g npm@11\b(?!\.)/, 'publish.yml must not float on npm@11');

  const profile = readFileSync(join(REAL_REPO, '.claude/release-profile.md'), 'utf8');
  const releasing = readFileSync(join(REAL_REPO, 'docs/RELEASING.md'), 'utf8');
  assert.doesNotMatch(profile, /@adlc\/core` first/);
  assert.doesNotMatch(profile, /--provenance --access public/);
  assert.match(profile, /topological over internal runtime dependencies/);
  assert.doesNotMatch(releasing, /`@adlc\/core` first/);
  assert.match(releasing, /topological dependency order/);
});

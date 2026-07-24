// T80: banking must survive hand-refinement of a scaffolded lesson.
//
// The gate credited a lesson by the clusterName SLUG (derived from the first
// finding's desc). That slug drifts — cluster members are not ordered stably, and
// a human rewording the scaffolded prose can drop the machine annotation entirely —
// so the marker orphans and the cluster is reported unbanked forever. The fix
// stamps a STABLE, prose-independent cluster id (sha256 over the sorted member
// finding hashes) into both the emitted marker and the bank-detection key, while
// still crediting a legacy slug-only marker for lessons committed before this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClusters, findUnbankedClusters } from '../lib/foundry.mjs';
import { clusterId, clusterName, findingHash } from '../lib/route.mjs';
import { buildSpecGapLine, buildSkillStub, buildLintDescriptor } from '../lib/emit.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'stable-id-test-'));
}

// ---------------------------------------------------------------------------
// findingHash canonicalizes the WHOLE finding via canonicalJson, whose whole job is to be
// order-independent: it recurses into objects and SORTS their keys. If its `value === null
// || typeof value !== 'object'` guard is inverted, every non-null value short-circuits to a
// bare JSON.stringify — no recursion, no key sort — so the hash becomes field-ORDER
// dependent. Pin both: field-order invariance (the killer) and null-field handling.
test('findingHash is invariant to field ORDER (canonicalJson sorts keys)', () => {
  const a = { file: 'a.mjs', desc: 'guard failed open', line: 3, category: 'security' };
  const b = { category: 'security', line: 3, desc: 'guard failed open', file: 'a.mjs' };
  assert.equal(findingHash(a), findingHash(b), 'the same fields in a different order must hash the same');
});

test('findingHash: a null field value is canonicalized, not a crash', () => {
  const withNull = { file: 'a.mjs', desc: 'x', line: null, meta: { nested: null } };
  let hash;
  assert.doesNotThrow(() => { hash = findingHash(withNull); }, 'a null field must not throw');
  assert.match(hash, /^[0-9a-f]+$/, 'and still yields a hex digest');
});

// clusterId — the stable, prose-independent key
// ---------------------------------------------------------------------------
test('clusterId: deterministic, order-independent, and STABLE as the cluster grows', () => {
  const a = { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'alpha' };
  const b = { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'beta' };
  const c = { ts: 't3', file: 'c.mjs', line: 3, category: 'security', desc: 'gamma' };
  const other = { ts: 't9', file: 'z.mjs', line: 9, category: 'style', desc: 'unrelated pattern' };

  assert.equal(clusterId([a, b]), clusterId([a, b]), 'same members → same id');
  assert.equal(clusterId([a, b]), clusterId([b, a]), 'member order must not change the id');
  // THE property this id exists for. A recurring pattern accumulates occurrences; that
  // is the ledger's normal lifecycle. Keying on the whole member set meant one more
  // occurrence of an already-defended pattern re-keyed the cluster and orphaned its
  // lesson — reporting a defended pattern as undistilled.
  assert.equal(clusterId([a, b]), clusterId([a, b, c]), 'appending a new occurrence must NOT re-key the cluster');
  assert.equal(clusterId([a]), clusterId([a, b, c]), 'nor does growth from a single founding occurrence');
  // But genuinely different clusters remain distinct.
  assert.notEqual(clusterId([a, b]), clusterId([other]), 'a different cluster is a different id');
  assert.match(clusterId([a, b]), /^[0-9a-f]+$/, 'id is a hex digest');
});

test('clusterId: does not move when unrelated lesson prose changes', () => {
  // The id is derived only from the findings, so nothing a human does to a lesson
  // file can perturb it. Two runs over the same findings must agree.
  const findings = [
    { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' },
    { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' },
  ];
  assert.equal(clusterId(findings), clusterId(findings.slice()));
});

// ---------------------------------------------------------------------------
// buildClusters stamps the id
// ---------------------------------------------------------------------------
test('buildClusters: stamps a stable id equal to clusterId of the members', () => {
  const findings = [
    { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' },
    { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' },
  ];
  const [cluster] = buildClusters(findings, 2);
  assert.ok(cluster, 'the two similar findings cluster together');
  const members = cluster.indices.map((i) => findings[i]);
  assert.equal(cluster.id, clusterId(members));
});

// ---------------------------------------------------------------------------
// emit stamps the id into the marker
// ---------------------------------------------------------------------------
test('buildSpecGapLine: embeds the stable cluster id', () => {
  const findings = [
    { ts: 't1', file: 'a.mjs', category: 'security', desc: 'unclear retention policy' },
    { ts: 't2', file: 'b.mjs', category: 'security', desc: 'unclear retention policy' },
  ];
  const line = buildSpecGapLine('retention-gap', findings);
  assert.ok(line.includes(`cluster-id: ${clusterId(findings)}`), `line must carry the id: ${line}`);
});

// ---------------------------------------------------------------------------
// (a) a reworded lesson is still banked via the stable id
// ---------------------------------------------------------------------------
test('spec-gap: a reworded lesson that dropped the legacy slug marker is still banked via the id', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' },
    ];
    const [cluster] = buildClusters(findings, 2);
    assert.equal(cluster.route, 'spec-gap');
    assert.ok(cluster.id, 'cluster carries a stable id');

    // The human rewrote the question completely AND removed the auto-generated
    // `cluster: <slug>` annotation, keeping only the stable machine marker.
    const reworded =
      `# Interrogation Template\n\n` +
      `- [ ] **[security]** For every data class we persist, does the spec state its ` +
      `retention window and deletion trigger? <!-- cluster-id: ${cluster.id} -->\n`;
    assert.ok(!reworded.includes(`cluster: ${cluster.name}`), 'precondition: legacy slug marker is gone');

    writeFileSync(join(outDir, 'interrogation-template.md'), reworded, 'utf8');
    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'the reworded lesson is credited by its stable id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spec-gap: a defended cluster STAYS banked when the same pattern recurs again', () => {
  // The lifecycle that matters: distil a lesson, then the pattern happens once more.
  // The gate must still credit the existing defense — not re-report it as undistilled
  // just because the ledger gained another occurrence of the thing it defends against.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const a = { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' };
    const b = { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' };

    const [banked] = buildClusters([a, b], 2);
    assert.equal(banked.route, 'spec-gap');
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# Interrogation Template\n\n- [ ] **[security]** retention window + deletion trigger? <!-- cluster-id: ${banked.id} -->\n`,
      'utf8',
    );
    assert.deepEqual(findUnbankedClusters([banked], outDir, existsSync), [], 'precondition: it is banked');

    // The same pattern recurs a third time.
    const c = { ts: 't3', file: 'c.mjs', line: 3, category: 'security', desc: 'unclear data retention policy for backups' };
    const [grown] = buildClusters([a, b, c], 2);

    assert.equal(grown.id, banked.id, 'the grown cluster keeps its identity');
    assert.deepEqual(
      findUnbankedClusters([grown], outDir, existsSync),
      [],
      'and the existing defense still counts — a recurrence does not un-bank it',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spec-gap: a merged OLDER occurrence does not un-bank a defended cluster', () => {
  // Now that the ledger is tracked in git (T81), branches merge findings out of
  // timestamp order as a matter of course: a record appended today can carry an
  // earlier ts than one already banked. Any identity DERIVED from the member set
  // breaks here — keying on the whole set breaks on growth, keying on the earliest
  // member breaks on exactly this. Overlap survives both.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const a = { ts: '2026-02-01', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' };
    const b = { ts: '2026-02-02', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' };

    const [banked] = buildClusters([a, b], 2);
    assert.equal(banked.route, 'spec-gap');
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# Interrogation Template\n\n${buildSpecGapLine(banked.name, [a, b])}`,
      'utf8',
    );
    assert.deepEqual(findUnbankedClusters([banked], outDir, existsSync), [], 'precondition: banked');

    // A long-running branch merges in an occurrence recorded BEFORE the banked ones.
    const older = { ts: '2026-01-15', file: 'z.mjs', line: 9, category: 'security', desc: 'unclear data retention policy for backups' };
    const [merged] = buildClusters([older, a, b], 2);

    assert.deepEqual(
      findUnbankedClusters([merged], outDir, existsSync),
      [],
      'the existing defense still counts after an out-of-order merge',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spec-gap: a defended cluster fused with an UNDEFENDED one is still reported unbanked', () => {
  // Clustering is transitive, so a bridging finding can fuse two previously distinct
  // patterns. Crediting the fused cluster because ONE member is covered would silently
  // absorb the undefended half — precisely what this gate exists to catch.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const defended = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' },
    ];
    const [banked] = buildClusters(defended, 2);
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# Interrogation Template\n\n${buildSpecGapLine(banked.name, defended)}`,
      'utf8',
    );
    assert.deepEqual(findUnbankedClusters([banked], outDir, existsSync, undefined, undefined, 2), [], 'precondition: banked');

    // A separate, never-defended pattern that clustering later fuses in.
    const fused = {
      ...banked,
      members: [...banked.members, 'ffffffffff01', 'ffffffffff02', 'ffffffffff03'],
      size: 5,
    };

    assert.deepEqual(
      findUnbankedClusters([fused], outDir, existsSync, undefined, undefined, 2).map((c) => c.name),
      [fused.name],
      'the fused cluster is NOT banked by the defense that covers only part of it',
    );

    // ...while a mere recurrence (one new occurrence) still counts as defended.
    const recurred = { ...banked, members: [...banked.members, 'ffffffffff01'], size: 3 };
    assert.deepEqual(
      findUnbankedClusters([recurred], outDir, existsSync, undefined, undefined, 2),
      [],
      'a recurrence does not un-bank the cluster',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lint: a slug-NAMED artifact does not bypass the coverage invariant', () => {
  // Every normally emitted lint/skill artifact is named by the cluster slug, so
  // crediting on the filename alone would short-circuit coverage for all of them —
  // the same bypass the cluster-id match caused for spec-gap.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const a = { ts: 't1', file: 'a.mjs', line: 1, category: 'style', desc: 'stray "TODO" marker left in shipped code' };
    const b = { ts: 't2', file: 'b.mjs', line: 2, category: 'style', desc: 'stray "TODO" marker left in a handler' };
    const [cluster] = buildClusters([a, b], 2);
    assert.equal(cluster.route, 'lint');

    // Emitted by the REAL emitter, at its real slug-derived filename.
    const descriptor = buildLintDescriptor(cluster.name, [a, b]);
    writeFileSync(join(outDir, `${cluster.name}.lint.json`), descriptor.content ?? descriptor, 'utf8');
    assert.deepEqual(findUnbankedClusters([cluster], outDir, existsSync, undefined, undefined, 2), [], 'precondition: banked');

    const fused = { ...cluster, members: [...cluster.members, 'ffffffffff01', 'ffffffffff02', 'ffffffffff03'], size: 5 };
    assert.deepEqual(
      findUnbankedClusters([fused], outDir, existsSync, undefined, undefined, 2).map((c) => c.name),
      [fused.name],
      'the slug-named file must not credit a cluster it only partly covers',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spec-gap: a different cluster sharing a slug is NOT credited by the other lesson', () => {
  // clusterName truncates to 50 chars, so distinct patterns can slugify identically.
  // A CURRENT lesson (one that records member keys) must only bank the cluster whose
  // members it actually covers.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      '# T\n\n- [ ] **[security]** q? *(cluster: shared-slug, cluster-id: aaaa, cluster-members: aaaaaaaaaaa1 aaaaaaaaaaa2)*\n',
      'utf8',
    );
    const other = { route: 'spec-gap', name: 'shared-slug', id: 'bbbb', members: ['bbbbbbbbbbb1', 'bbbbbbbbbbb2'], size: 2 };
    assert.deepEqual(
      findUnbankedClusters([other], outDir, existsSync, undefined, undefined, 2).map((c) => c.name),
      ['shared-slug'],
      'a slug collision with a members-recording lesson is not a defense',
    );

    // But a pre-overlap lesson (no member keys at all) still grants legacy credit.
    writeFileSync(join(outDir, 'interrogation-template.md'), '# T\n\n- [ ] **[security]** q? *(cluster: shared-slug)*\n', 'utf8');
    assert.deepEqual(
      findUnbankedClusters([other], outDir, existsSync, undefined, undefined, 2),
      [],
      'legacy slug-only lessons are still credited',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage: uncovered occurrences that do not cluster with EACH OTHER keep the cluster banked', () => {
  // The count proxy over-reports here. Transitive clustering can put two unrelated
  // findings in one cluster because each bridges to a DIFFERENT covered finding, while
  // not clustering with each other. Those are stray recurrences, not a fused pattern —
  // reclustering the uncovered set (given the findings) decides it exactly.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const covered0 = { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' };
    const covered1 = { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' };
    // Two uncovered findings, mutually DISSIMILAR (different words entirely).
    const strayA = { ts: 't3', file: 'c.mjs', line: 3, category: 'security', desc: 'flaky timeout waiting on the network socket' };
    const strayB = { ts: 't4', file: 'd.mjs', line: 4, category: 'security', desc: 'missing null check dereferences the parser node' };
    const findings = [covered0, covered1, strayA, strayB];
    const coveredKeys = [covered0, covered1].map((f) => findingHash(f).slice(0, 12));

    // Lesson records ONLY the two covered members.
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# T\n\n- [ ] **[security]** retention? *(cluster: x, cluster-id: y, cluster-members: ${coveredKeys.join(' ')})*\n`,
      'utf8',
    );
    const cluster = {
      route: 'spec-gap', name: 'x', id: 'y',
      members: findings.map((f) => findingHash(f).slice(0, 12)).sort(),
      indices: [0, 1, 2, 3], size: 4,
    };

    // count proxy would say unbanked (2 uncovered ≥ minSize); reclustering says banked.
    assert.deepEqual(
      findUnbankedClusters([cluster], outDir, existsSync, undefined, undefined, 2, findings, 0.5),
      [],
      'stray non-clustering recurrences do not un-bank the cluster',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage: uncovered occurrences that DO cluster together surface the cluster', () => {
  // The contrast: an undefended pattern genuinely fused in. Its occurrences cluster
  // with each other, forming a subcluster ≥ minSize → the cluster must be surfaced.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const covered0 = { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' };
    const covered1 = { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' };
    const undef0 = { ts: 't3', file: 'c.mjs', line: 3, category: 'security', desc: 'secrets printed into build logs verbatim' };
    const undef1 = { ts: 't4', file: 'd.mjs', line: 4, category: 'security', desc: 'secrets printed into build logs on failure' };
    const findings = [covered0, covered1, undef0, undef1];
    const coveredKeys = [covered0, covered1].map((f) => findingHash(f).slice(0, 12));
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# T\n\n- [ ] **[security]** retention? *(cluster: x, cluster-id: y, cluster-members: ${coveredKeys.join(' ')})*\n`,
      'utf8',
    );
    const cluster = {
      route: 'spec-gap', name: 'x', id: 'y',
      members: findings.map((f) => findingHash(f).slice(0, 12)).sort(),
      indices: [0, 1, 2, 3], size: 4,
    };
    assert.deepEqual(
      findUnbankedClusters([cluster], outDir, existsSync, undefined, undefined, 2, findings, 0.5).map((c) => c.name),
      ['x'],
      'a fused-in pattern whose occurrences cluster is surfaced',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// End-to-end order-independence: the marker is stamped from one member ordering
// and the gate re-clusters (possibly reordering members) before checking. This is
// the property the whole ticket rests on — an order-dependent id would orphan the
// marker across a re-run — and unlike the headline tests above it does NOT reuse
// one cluster.id on both sides, so an id that stopped sorting its members would
// go RED here, not just in the clusterId unit test.
test('spec-gap: banking survives cluster members being re-ordered between emit and gate', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const a = { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' };
    const b = { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' };

    // Emit stamps the marker from the [a, b] ordering.
    const [emit] = buildClusters([a, b], 2);
    assert.equal(emit.route, 'spec-gap');
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# Interrogation Template\n\n- [ ] **[security]** retention window + deletion trigger? <!-- cluster-id: ${emit.id} -->\n`,
      'utf8',
    );

    // The next run re-clusters and hands the SAME members in the OPPOSITE order.
    const [check] = buildClusters([b, a], 2);
    assert.equal(check.id, emit.id, 'the stable id is invariant to member order');
    const unbanked = findUnbankedClusters([check], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'the re-ordered cluster is still credited by its stable id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: a lesson whose file was renamed is still banked via the id in its content', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    assert.equal(cluster.route, 'skill');

    // The scaffolded stub was refined and renamed to a proper skill name; the
    // slug-derived filename no longer exists, but the id is stamped in its content.
    const stub = buildSkillStub(cluster.name, findings, null);
    assert.ok(stub.content.includes(`cluster-id: ${cluster.id}`), 'stub content carries the id');
    assert.ok(!existsSync(join(outDir, `${cluster.name}.SKILL.md`)), 'precondition: legacy filename absent');
    writeFileSync(join(outDir, 'graceful-async-error-handling.SKILL.md'), stub.content, 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'the renamed skill lesson is credited by its stable id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint: a descriptor whose file was renamed is still banked via the id in its content', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'production code uses "eval" call directly' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'production code uses "eval" in the handler' },
    ];
    const [cluster] = buildClusters(findings, 2);
    assert.equal(cluster.route, 'lint');

    const descriptor = buildLintDescriptor(cluster.name, findings);
    const parsed = JSON.parse(descriptor.content);
    assert.equal(parsed.id, cluster.id, 'descriptor carries the stable id');
    assert.ok(!existsSync(join(outDir, `${cluster.name}.lint.json`)), 'precondition: legacy filename absent');
    writeFileSync(join(outDir, 'no-eval-in-production.lint.json'), descriptor.content, 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'the renamed lint descriptor is credited by its stable id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) a genuinely-missing cluster is still reported unbanked
// ---------------------------------------------------------------------------
test('spec-gap: a genuinely undistilled cluster is still reported unbanked (no id false-credit)', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' },
    ];
    const [cluster] = buildClusters(findings, 2);

    // The template defends a DIFFERENT cluster — neither this cluster's id nor its
    // slug appears, so it must stay unbanked.
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# Interrogation Template\n\n- [ ] **[other]** unrelated question ` +
      `*(recurring in 2 findings, cluster: some-other-gap, cluster-id: 0000000000000000)*\n`,
      'utf8'
    );
    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.equal(unbanked.length, 1);
    assert.equal(unbanked[0].id, cluster.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: a cluster with no defense file is still unbanked even though the id scan runs', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    // An unrelated skill file exists but does not carry this cluster's id.
    writeFileSync(join(outDir, 'unrelated.SKILL.md'), 'cluster-id: ffffffffffffffff\n', 'utf8');
    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.equal(unbanked.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) a legacy slug-only marker still credits
// ---------------------------------------------------------------------------
test('spec-gap: a legacy slug-only marker (no cluster-id) still credits the cluster', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'security', desc: 'unclear data retention policy across services' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'security', desc: 'unclear data retention policy for logs' },
    ];
    const [cluster] = buildClusters(findings, 2);
    const legacyName = clusterName(findings);

    // A lesson committed before T80: only the slug marker, no cluster-id.
    const legacy =
      `# Interrogation Template\n\n- [ ] **[security]** old question ` +
      `*(recurring in 2 findings, cluster: ${legacyName})*\n`;
    assert.ok(!legacy.includes('cluster-id:'), 'precondition: no stable id marker present');
    writeFileSync(join(outDir, 'interrogation-template.md'), legacy, 'utf8');

    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'the legacy slug-only marker is still credited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: a legacy slug-named file (no id in content) still credits the cluster', () => {
  const dir = makeTempDir();
  try {
    const outDir = join(dir, 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: 't1', file: 'a.mjs', line: 1, category: 'convention', desc: 'missing error handling in async functions' },
      { ts: 't2', file: 'b.mjs', line: 2, category: 'convention', desc: 'no error handling for async operation' },
    ];
    const [cluster] = buildClusters(findings, 2);
    // Pre-T80 scaffold: file named by the slug, no id stamped in content.
    writeFileSync(join(outDir, `${cluster.name}.SKILL.md`), 'legacy content, no id\n', 'utf8');
    const unbanked = findUnbankedClusters([cluster], outDir, existsSync);
    assert.deepEqual(unbanked, [], 'the legacy slug-named file is still credited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

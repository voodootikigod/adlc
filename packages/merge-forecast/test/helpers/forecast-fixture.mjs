// A scratch repository that makes runForecast exercise EVERY signal, for the
// characterization test in ../forecast-unchanged.test.mjs. Its golden output
// was recorded with the code as it was BEFORE the scope index existed, so the
// test proves the speed-up changed no answer.
//
// Change nothing here without re-recording the golden from the PRE-change
// code: the fixture and the golden are one artifact.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// One ticket per signal, plus the ones that make two tickets collide on it.
// Scopes mix the three glob shapes the index treats differently: literals,
// `prefix/**`, and patterns with a wildcard in the middle.
export const FIXTURE_TICKETS = [
  // namespace-collision: dynamic route segments [pk] vs [id] under app/votes
  { id: 'ROUTE_A', title: 'route a', scope: ['app/votes/[pk]/**'], edges: [] },
  { id: 'ROUTE_B', title: 'route b', scope: ['app/votes/[id]/page.tsx'], edges: [] },
  // namespace-collision: migration prefix 0005 in drizzle/ and migrations/
  { id: 'MIG_A', title: 'mig a', scope: ['drizzle/0005_add_votes.sql', 'src/mig-a/**'], edges: [] },
  { id: 'MIG_B', title: 'mig b', scope: ['migrations/*_other.sql'], edges: [] },
  // import-radius: src/imp-a/main.mjs imports ../imp-b/util.mjs
  { id: 'IMP_A', title: 'imp a', scope: ['src/imp-a/**'], edges: [] },
  { id: 'IMP_B', title: 'imp b', scope: ['src/imp-b/*.mjs'], edges: [] },
  // co-change: src/co-a/x.mjs and src/co-b/y.mjs committed together 4 times
  { id: 'CO_A', title: 'co a', scope: ['src/co-a/x.mjs'], edges: [] },
  { id: 'CO_B', title: 'co b', scope: ['src/co-b/**/*.mjs'], edges: [] },
  // graph-coupling via fileCoupling
  { id: 'GR_A', title: 'graph a', scope: ['src/gr-a/**'], edges: [] },
  { id: 'GR_B', title: 'graph b', scope: ['src/gr-b/**'], edges: [] },
  // graph-coupling via edges (no fileCoupling entry for this pair)
  { id: 'ED_A', title: 'edge a', scope: ['src/ed-a/m.mjs'], edges: [] },
  { id: 'ED_B', title: 'edge b', scope: ['src/ed-b/**/n.mjs'], edges: [] },
  // scope-overlap hard veto with IMP_A
  { id: 'OVER', title: 'overlap', scope: ['src/imp-a/sub/**'], edges: [] },
  // unscoped, and a scope that matches no file
  { id: 'UNSCOPED', title: 'unscoped', edges: [] },
  { id: 'ZERO', title: 'zero match', scope: ['nothing/**', 'none.txt'], edges: [] },
  // a second wave, so the schedule has more than one
  { id: 'LATE', title: 'late', scope: ['docs/**/*.md', 'README.md'], edges: [] },
  // independent of everything: should come out PARALLEL
  { id: 'SOLO', title: 'solo', scope: ['src/solo/**'], edges: [] },
];

// ROUTE_A → LATE and SOLO → LATE: LATE lands in wave 2.
FIXTURE_TICKETS.find((t) => t.id === 'ROUTE_A').edges.push({ to: 'LATE' });
FIXTURE_TICKETS.find((t) => t.id === 'SOLO').edges.push({ to: 'LATE' });

export const FIXTURE_GRAPH = {
  fileCoupling: { 'src/gr-a/a.mjs|src/gr-b/b.mjs': 0.8 },
  edges: [{ from: 'src/ed-a/m.mjs', to: 'src/ed-b/deep/n.mjs', weight: 0.9 }],
};

const FILES = {
  'app/votes/[pk]/page.tsx': 'export default 1;\n',
  'app/votes/[id]/page.tsx': 'export default 2;\n',
  'drizzle/0005_add_votes.sql': 'select 1;\n',
  'migrations/0005_other.sql': 'select 2;\n',
  'src/mig-a/index.mjs': 'export const m = 1;\n',
  'src/imp-a/main.mjs': "import { u } from '../imp-b/util.mjs';\nexport const x = u;\n",
  'src/imp-a/sub/leaf.mjs': 'export const leaf = 1;\n',
  'src/imp-b/util.mjs': 'export const u = 1;\n',
  'src/co-a/x.mjs': 'export const x = 0;\n',
  'src/co-b/y.mjs': 'export const y = 0;\n',
  'src/gr-a/a.mjs': 'export const a = 1;\n',
  'src/gr-b/b.mjs': 'export const b = 1;\n',
  'src/ed-a/m.mjs': 'export const m = 1;\n',
  'src/ed-b/deep/n.mjs': 'export const n = 1;\n',
  'src/solo/only.mjs': "import fs from 'node:fs';\nexport const s = fs;\n",
  'docs/guide/intro.md': '# intro\n',
  'README.md': '# fixture\n',
};

function write(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function git(root, args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

/** Populate `root` (an empty temp dir) with the fixture files and history. */
export function buildFixtureRepo(root) {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  for (const [rel, content] of Object.entries(FILES)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  // Four commits touching the co-change pair together, above
  // MIN_COCHANGE_SUPPORT, and one touching only one side.
  for (let i = 1; i <= 4; i++) {
    write(root, 'src/co-a/x.mjs', `export const x = ${i};\n`);
    write(root, 'src/co-b/y.mjs', `export const y = ${i};\n`);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', `co-change ${i}`]);
  }
  write(root, 'src/co-a/x.mjs', 'export const x = 99;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'one side only']);
}

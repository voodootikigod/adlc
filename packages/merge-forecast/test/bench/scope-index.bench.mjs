#!/usr/bin/env node
// Offline benchmark for the scope index (spec: .adlc/specs/merge-forecast-scope-index.md,
// acceptance criterion 8).
//
//   node packages/merge-forecast/test/bench/scope-index.bench.mjs
//        [--files N] [--forecast <path/to/lib/forecast.mjs>] [--json]
//
// 1. Filtering: on a synthetic corpus (N files, default 10,000; 10 tickets, one
//    with 108 globs), the per-pair filtering merge-forecast used to do against
//    one scope index per run. Asserts both give the same file sets.
// 2. End to end: the corpus is written to a temp dir and runForecast is timed.
//    With --forecast, that implementation (e.g. origin/main's, extracted) runs
//    on the same corpus too, and the two results must be deep-equal.
//
// The temp dir is not a git repository, so the co-change signal is skipped in
// part 2; part 1 is pure. Lives under test/ because it is test tooling, not
// shipped code. Exit: 0 = agree, 1 = disagree or bad input.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { globMatch } from '@adlc/core';

import { createScopeIndex } from '../../lib/scope-index.mjs';
import { runForecast } from '../../lib/forecast.mjs';

const { values } = parseArgs({
  options: {
    files: { type: 'string', default: '10000' },
    forecast: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const fileCount = Number(values.files);
if (!Number.isSafeInteger(fileCount) || fileCount < 1000) {
  console.error('--files must be an integer >= 1000');
  process.exit(1);
}

// ─── Synthetic corpus ────────────────────────────────────────────────────────

const PACKAGES = 50;
const perPackage = Math.ceil(fileCount / PACKAGES);
const pkg = (p) => `packages/p${String(p).padStart(2, '0')}`;
const mod = (m) => `m${String(m).padStart(4, '0')}.mjs`;

const repoFiles = [];
for (let p = 0; p < PACKAGES && repoFiles.length < fileCount; p++) {
  for (let m = 0; m < perPackage && repoFiles.length < fileCount; m++) {
    repoFiles.push(`${pkg(p)}/lib/${mod(m)}`);
  }
}

// Ticket i owns packages 5i..5i+4, so no two scopes overlap (an overlap is a
// hard veto and would skip every other signal). T0 is the 108-glob ticket:
// 100 literal files, plus prefix and mid-pattern globs, the shapes real scopes
// use.
const tickets = [];
for (let t = 0; t < 10; t++) {
  const own = [0, 1, 2, 3, 4].map((k) => pkg(5 * t + k));
  const scope =
    t === 0
      ? [
          ...Array.from({ length: 100 }, (_, m) => `${own[0]}/lib/${mod(m)}`),
          `${own[1]}/**`,
          `${own[2]}/lib/m00*.mjs`,
          `${own[2]}/lib/m01*.mjs`,
          `${own[3]}/**/m0001.mjs`,
          `${own[3]}/lib/*7.mjs`,
          `${own[4]}/lib/**`,
          `${own[4]}/*/m009*.mjs`,
          `${own[4]}/lib/m1*`,
        ]
      : [`${own[0]}/**`, `${own[1]}/lib/*.mjs`, `${own[2]}/lib/m00*.mjs`, `${own[3]}/lib/${mod(1)}`];
  tickets.push({ id: `T${t}`, title: `ticket ${t}`, scope, edges: [] });
}

// ─── 1. Filtering ────────────────────────────────────────────────────────────

const oldFiles = (scope) => repoFiles.filter((f) => (scope ?? []).some((g) => globMatch(g, f)));

// How often the old code computed a ticket's file set: the zero-match check
// once per ticket, then, per scored pair and per side, once each in namespace
// routes, migrations and import radius. That is the case part 2 runs: no git
// history and no graph-coupling data. Co-change data adds one more per side
// and graph-coupling data another, so a real repository pays 4 or 5; 3 keeps
// this side of the comparison conservative.
const SETS_PER_PAIR_SIDE = 3;
const pairs = [];
for (let i = 0; i < tickets.length; i++) {
  for (let j = i + 1; j < tickets.length; j++) pairs.push([tickets[i], tickets[j]]);
}

function time(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

const before = time(() => {
  const sets = tickets.map((t) => oldFiles(t.scope));
  for (const [a, b] of pairs) {
    for (let k = 0; k < SETS_PER_PAIR_SIDE; k++) {
      oldFiles(a.scope);
      oldFiles(b.scope);
    }
  }
  return sets;
});

const after = time(() => {
  const index = createScopeIndex(repoFiles);
  const sets = tickets.map((t) => index.files(t.scope));
  for (const [a, b] of pairs) {
    for (let k = 0; k < SETS_PER_PAIR_SIDE; k++) {
      index.files(a.scope);
      index.files(b.scope);
    }
  }
  return sets;
});

const filteringAgrees = isDeepStrictEqual(before.value, after.value);
const matched = after.value.reduce((n, set) => n + set.length, 0);

// ─── 2. End to end ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'mf-bench-'));
const endToEnd = {};
let endToEndAgrees = true;
try {
  for (const rel of repoFiles) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    // A relative import, so the import-radius signal has work to do.
    writeFileSync(full, `import { x } from './${mod(0)}';\nexport const y = x;\n`);
  }
  const run = async (forecast) => {
    const start = process.hrtime.bigint();
    const result = await forecast({ tickets: structuredClone(tickets), root: dir });
    return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
  };
  const current = await run(runForecast);
  endToEnd.thisBranchMs = current.ms;
  endToEnd.pairs = current.result.pairs.length;
  if (values.forecast) {
    const other = await import(pathToFileURL(resolve(values.forecast)).href);
    const compared = await run(other.runForecast);
    endToEnd.comparedMs = compared.ms;
    endToEnd.comparedWith = values.forecast;
    endToEndAgrees = isDeepStrictEqual(current.result, compared.result);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ─── Report ──────────────────────────────────────────────────────────────────

const report = {
  corpus: { files: repoFiles.length, tickets: tickets.length, pairs: pairs.length, largestScope: tickets[0].scope.length, matched },
  filtering: { oldMs: before.ms, indexMs: after.ms, speedup: before.ms / after.ms, agrees: filteringAgrees },
  endToEnd: { ...endToEnd, agrees: endToEndAgrees },
};

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ms = (n) => `${n.toFixed(1)} ms`;
  console.log(`corpus: ${report.corpus.files} files, ${report.corpus.tickets} tickets (largest scope ${report.corpus.largestScope} globs), ${report.corpus.pairs} pairs, ${matched} matched files`);
  console.log(`filtering: old ${ms(before.ms)} → index ${ms(after.ms)} (${report.filtering.speedup.toFixed(0)}×), results ${filteringAgrees ? 'identical' : 'DIFFER'}`);
  console.log(`runForecast (this branch): ${ms(endToEnd.thisBranchMs)}`);
  if (values.forecast) {
    console.log(`runForecast (${values.forecast}): ${ms(endToEnd.comparedMs)}, results ${endToEndAgrees ? 'identical' : 'DIFFER'}`);
  }
}

process.exit(filteringAgrees && endToEndAgrees ? 0 : 1);

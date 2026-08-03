#!/usr/bin/env node
// check-consolidation.mjs — prove the router consolidation preserved each harness's
// routing (AC5) and frontmatter (AC8) versus the pre-consolidation baseline, and
// refuse to silently pass on an empty/unresolved baseline (AC9).
//
//   node scripts/router/check-consolidation.mjs <BASE>                 # routing check
//   node scripts/router/check-consolidation.mjs <BASE> --frontmatter   # + frontmatter check
//
// <BASE> is a git ref — the pre-consolidation branch point. Compute it with:
//   git merge-base origin/main HEAD   (fall back to: git merge-base main HEAD)
//
// The routing structure is parsed STRUCTURALLY per format (heading-scoped `### P<n>`
// blocks for prose; the phase/gate table columns for `.mdc`/opencode), keyed by phase,
// so a same-line gate swap cannot false-negative. "Routing" means the phase -> `adlc`
// gate skeleton; the adversarial-review discoverability overlay is invoked via
// `npx adversarial-review` (not an `adlc` subcommand) and is intentionally not part of
// the routing skeleton — adding it (T14) is not a routing change.
//
// Exit codes: 0 = no drift · 1 = operational error (bad/empty/unresolved BASE, git
// failure) · 2 = ROUTING/FRONTMATTER DRIFT found.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { routerModel } from './router-model.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADLC_GATE = /\badlc ([a-z][a-z0-9-]+)/g;

/** The leading `---\n ... \n---\n` frontmatter block (verbatim), or '' if none. */
export function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return '';
  const end = content.indexOf('\n---\n', 3);
  if (end === -1) return '';
  return content.slice(0, end + 5);
}

function gatesIn(text) {
  const set = new Set();
  let m;
  ADLC_GATE.lastIndex = 0;
  while ((m = ADLC_GATE.exec(text)) !== null) set.add(m[1]);
  return set;
}

function addGates(map, phase, gates) {
  if (!map[phase]) map[phase] = new Set();
  for (const g of gates) map[phase].add(g);
}

function finalize(map) {
  const out = {};
  for (const [phase, set] of Object.entries(map)) out[phase] = [...set].sort();
  return out;
}

/**
 * Parse the phase -> `adlc` gate skeleton, keyed by phase.
 *   format 'prose'   — heading-scoped `### P<n>` blocks (claude-code, antigravity).
 *   format 'table'   — the phase/gate markdown table columns (opencode, cursor).
 *   format 'minimal' — delegating routers with no per-phase map (codex, pi): gates
 *                      are collected under a single 'body' bucket.
 */
export function parseRouting(content, format) {
  const map = {};
  if (format === 'table') {
    for (const line of content.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      // cells: ['', col1, col2(phase), col3(gate), '']
      if (cells.length < 4) continue;
      const phaseCell = cells[2];
      const gateCell = cells[3];
      const phases = phaseCell.match(/P\d/g);
      if (!phases) continue; // header/separator/non-phase rows
      const gates = gatesIn(gateCell);
      for (const p of phases) addGates(map, p, gates);
    }
    return finalize(map);
  }
  if (format === 'minimal') {
    addGates(map, 'body', gatesIn(content));
    return finalize(map);
  }
  // prose: scope by `### P<n>` headings.
  let current = null;
  for (const line of content.split('\n')) {
    const h = line.match(/^### (P\d)\b/);
    if (h) { current = h[1]; if (!map[current]) map[current] = new Set(); continue; }
    if (current) for (const g of gatesIn(line)) map[current].add(g);
  }
  return finalize(map);
}

/** Structural diff of two routing skeletons. Returns [] when identical. */
export function compareRouting(base, gen) {
  const drift = [];
  const phases = new Set([...Object.keys(base), ...Object.keys(gen)]);
  for (const p of [...phases].sort()) {
    const a = (base[p] || []).join(',');
    const b = (gen[p] || []).join(',');
    if (a !== b) drift.push(`${p}: baseline [${a}] != current [${b}]`);
  }
  return drift;
}

function gitShow(base, relPath) {
  return execFileSync('git', ['show', `${base}:${relPath}`], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}

function resolveBase(base) {
  if (base === undefined || base === null || String(base).trim() === '') {
    throw { op: true, msg: 'baseline unresolved: <BASE> is empty. Compute it with `git merge-base origin/main HEAD`.' };
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw { op: true, msg: `baseline unresolved: "${base}" is not a resolvable commit.` };
  }
  return base;
}

/**
 * `harnesses` and `readWork` are injectable so the rename/supersede branches can
 * be driven by fixtures instead of only by whatever the real model happens to
 * declare today — otherwise those branches go untested the moment no router is
 * mid-rename.
 */
export function run(base, {
  frontmatter = false,
  harnesses = routerModel.harnesses,
  readWork = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'),
} = {}) {
  const resolved = resolveBase(base);
  const drift = [];
  for (const harness of Object.values(harnesses)) {
    const rel = harness.path;
    // A router that moved since the baseline declares where it used to live, so
    // the comparison follows the rename instead of failing to resolve.
    const baseRel = harness.baselinePath ?? rel;
    let baseContent;
    try {
      baseContent = gitShow(resolved, baseRel);
    } catch {
      throw { op: true, msg: `baseline unresolved: ${baseRel} does not exist at ${resolved}.` };
    }
    const workContent = readWork(rel);

    const routeDrift = compareRouting(
      parseRouting(baseContent, harness.format),
      parseRouting(workContent, harness.format),
    );
    for (const d of routeDrift) drift.push(`ROUTING DRIFT ${rel} — ${d}`);

    if (frontmatter) {
      const a = parseFrontmatter(baseContent);
      const b = parseFrontmatter(workContent);
      // A harness that deliberately replaced its frontmatter pins the exact block
      // it superseded. The drift is accepted only while the baseline still reads
      // that block — any other baseline, or any further edit, still reports.
      const superseded = harness.supersedesBaselineFrontmatter;
      if (a !== b && !(superseded !== undefined && a === superseded)) {
        drift.push(`FRONTMATTER DRIFT ${rel} — leading --- block changed vs baseline`);
      }
    }
  }
  return drift;
}

function main(argv) {
  const frontmatter = argv.includes('--frontmatter');
  const base = argv.find((a) => !a.startsWith('--'));
  try {
    const drift = run(base ?? '', { frontmatter });
    if (drift.length) {
      for (const d of drift) console.error(d);
      process.exit(2);
    }
    console.log(`consolidation check passed — ${Object.keys(routerModel.harnesses).length} routers match the baseline (${frontmatter ? 'routing + frontmatter' : 'routing'}).`);
  } catch (e) {
    if (e && e.op) { console.error(`error: ${e.msg}`); process.exit(1); }
    console.error(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

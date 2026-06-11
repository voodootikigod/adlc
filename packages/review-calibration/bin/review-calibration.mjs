#!/usr/bin/env node
// review-calibration — reviewer recall measurement via planted bugs (ADLC C8)
// Safety: refuses to run on a dirty tree; all plants restored in finally + SIGINT.

import { writeFileSync, readFileSync } from 'node:fs';
import { parseArgs, pass, gateFail, opError, printJson } from '../../core/index.mjs';
import { git, isDirty, isGitRepo, mutate } from '../../core/index.mjs';
import { filterCodeFiles, selectPlants, loadPlantsFile } from '../lib/targets.mjs';
import { runWithPlants } from '../lib/runner.mjs';
import { scoreReview } from '../lib/scorer.mjs';
import { printScorecard, buildJsonReport } from '../lib/report.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    'review-cmd': { type: 'string' },
    commit:       { type: 'string', default: 'HEAD' },
    plants:       { type: 'string', default: '8' },
    'min-recall': { type: 'string', default: '0.5' },
    files:        { type: 'string' },   // Fallback file list (comma-separated)
    'plants-file': { type: 'string' },  // Externally authored plants (JSON)
    json:         { type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help || !values['review-cmd']) {
  console.log(`
review-calibration — reviewer recall measurement via planted bugs (ADLC C8)

Usage:
  review-calibration --review-cmd "cmd with {base} placeholder" [options]

Options:
  --review-cmd <cmd>    (required) Shell command to run the review.
                        {base} is replaced with the commit ref so the review
                        sees the planted working-tree diff vs. base.
  --commit <ref>        Commit to target for plant file selection (default: HEAD)
  --plants <n>          Number of bugs to plant (default: 8)
  --min-recall <f>      Minimum recall fraction to pass gate (default: 0.5)
  --files <list>        Fallback comma-separated file list when the commit
                        touches no eligible code files
  --plants-file <path>  JSON array of externally authored plants:
                        [{file, line, original, mutated, category?}, ...]
                        Bypasses commit discovery and mechanical mutation —
                        use for LLM-generated or hand-written subtle bugs.
                        Each plant is validated against the working tree.
  --json                Machine-readable JSON output
  --help                Show this help

Exit codes:
  0  Recall meets --min-recall (gate passes)
  1  Operational error (dirty tree, no plants generatable, review-cmd crashed)
  2  Recall below --min-recall (gate fails)

ADLC phase: P5 meta-gate — "who reviews the reviewer"

Examples:
  review-calibration \\
    --review-cmd "adversarial-review --base {base} --json" \\
    --commit HEAD \\
    --plants 8 \\
    --min-recall 0.6

  review-calibration \\
    --review-cmd "node scripts/my-review.mjs {base}" \\
    --json
`);
  process.exit(values.help ? 0 : 1);
}

const reviewCmd  = values['review-cmd'];
const commitRef  = values.commit;
const maxPlants  = parseInt(values.plants, 10);
const minRecall  = parseFloat(values['min-recall']);
const filesFlag  = values.files ?? '';
const useJson    = values.json;
const cwd        = process.cwd();

if (isNaN(maxPlants) || maxPlants < 1)  opError('--plants must be a positive integer');
if (isNaN(minRecall) || minRecall < 0 || minRecall > 1) {
  opError('--min-recall must be a number between 0 and 1');
}

// ── safety checks ────────────────────────────────────────────────────────────

if (!isGitRepo(cwd)) {
  opError('not a git repository');
}

if (isDirty(cwd)) {
  opError('commit or stash first — review-calibration plants bugs in-place and restores them');
}

// ── select plants: external file or mechanical mutation ──────────────────────

let plants;

if (values['plants-file']) {
  const { plants: loaded, errors } = loadPlantsFile(values['plants-file'], cwd);
  if (errors.length > 0) {
    opError(`plants file problems:\n  ${errors.join('\n  ')}`);
  }
  if (loaded.length === 0) {
    opError('plants file contains no valid plants — cannot calibrate');
  }
  plants = loaded.slice(0, maxPlants);
} else {
  // Discover target files from the commit, then mutate mechanically.
  let commitFiles = [];
  try {
    const treeOutput = git(
      ['diff-tree', '--no-commit-id', '-r', '--name-only', commitRef],
      { cwd }
    );
    commitFiles = treeOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    opError(`git diff-tree failed for commit "${commitRef}": ${err.message}`);
  }

  let codeFiles = filterCodeFiles(commitFiles);

  // Fallback to --files if no eligible code files found in commit.
  if (codeFiles.length === 0 && filesFlag.trim() !== '') {
    const fallback = filesFlag.split(',').map((f) => f.trim()).filter(Boolean);
    codeFiles = filterCodeFiles(fallback);
  }

  if (codeFiles.length === 0) {
    opError('no eligible code files found in commit (or --files fallback) — nothing to plant');
  }

  plants = selectPlants(codeFiles, cwd, maxPlants, mutate.generateMutants);

  if (plants.length === 0) {
    opError('no mutants could be generated from the target files — cannot calibrate');
  }
}

// ── SIGINT safety: track planted files for emergency restore ──────────────────

// Capture originals before planting so SIGINT handler can restore them.
const preOriginals = new Map();
for (const plant of plants) {
  if (!preOriginals.has(plant.absolutePath)) {
    try {
      preOriginals.set(plant.absolutePath, readFileSync(plant.absolutePath, 'utf8'));
    } catch { /* runner will error properly */ }
  }
}

// Signal handler restores files if the process is interrupted mid-run.
let plantedFiles = preOriginals;

process.on('SIGINT', () => {
  if (plantedFiles !== null) {
    for (const [absPath, content] of plantedFiles) {
      try { writeFileSync(absPath, content, 'utf8'); } catch { /* best-effort */ }
    }
  }
  process.exit(1);
});

// ── run review with all plants applied ───────────────────────────────────────

let runResult;
try {
  runResult = runWithPlants(plants, reviewCmd, commitRef, cwd, 300_000);
} catch (err) {
  plantedFiles = null;
  opError(`planting or review command failed: ${err.message}`);
}

// Clear SIGINT guard (runner's finally already restored files).
plantedFiles = null;

// Exit code 0 and 2 are legitimate review outcomes (pass / gate fail).
// Any other non-null exit code, or null, means the command crashed.
const { exitCode, timedOut, stdout, stderr } = runResult;
const reviewOutput = stdout + '\n' + stderr;

if (timedOut) {
  opError('review command timed out');
}
if (exitCode !== 0 && exitCode !== 2) {
  opError(`review command exited with code ${exitCode} — expected 0 or 2`);
}

// ── score ─────────────────────────────────────────────────────────────────────

const score = scoreReview(reviewOutput, plants);

const scorecard = {
  ...score,
  commit: commitRef,
  minRecall,
  reviewExitCode: exitCode,
};

// ── output ────────────────────────────────────────────────────────────────────

if (useJson) {
  printJson(buildJsonReport(scorecard));
} else {
  printScorecard(scorecard);
}

// ── exit ──────────────────────────────────────────────────────────────────────

if (score.recall < minRecall) {
  if (useJson) process.exit(2);
  gateFail(`recall gate fails — ${(score.recall * 100).toFixed(1)}% < ${(minRecall * 100).toFixed(1)}%`);
}

pass();

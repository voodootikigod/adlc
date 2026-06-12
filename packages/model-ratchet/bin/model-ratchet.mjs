#!/usr/bin/env node
// model-ratchet — ADLC C12 scheduled re-prosecution of hot paths.
// Thin CLI: parse args, call lib, exit with the correct code.

import { parseArgs, opError, printJson, appendEntry, isGitRepo, churn } from '../../core/index.mjs';
import { walkSourceFiles, computeInDegree } from '../lib/walk.mjs';
import { computeScores, topN } from '../lib/score.mjs';
import { runReviewCmd, parseFindingsFromOutput } from '../lib/run-review.mjs';
import { formatPlan, formatReviewSummary } from '../lib/format.mjs';

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    top:          { type: 'string',  default: '10' },
    'review-cmd': { type: 'string' },
    'churn-limit':{ type: 'string',  default: '1000' },
    'dry-run':    { type: 'boolean', default: false },
    json:         { type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`model-ratchet [--top <n>] [--review-cmd <cmd>] [--churn-limit <n>] [--dry-run] [--json]

Scheduled re-prosecution of hot paths (ADLC C12) — every model release is a
free re-audit. Identifies hotspot files (churn × criticality) and either
prints a prosecution plan or runs a review command over them.

Options:
  --top <n>           Number of hotspot files to select (default: 10)
  --review-cmd <cmd>  Shell command to run per file. Use {file} as placeholder.
                      Example: --review-cmd "adversarial-review --file {file}"
  --churn-limit <n>   Commit history depth for churn computation (default: 1000)
  --dry-run           Print plan only, do not run review-cmd (default when no
                      --review-cmd is supplied)
  --json              Machine-readable JSON output
  --help              Show this help

Hot score formula:
  SCORE = churn(limit)[file] × (1 + inDegree)
  where inDegree = number of repo source files that import/require this file.
  Test/spec files and non-source files (md/json/lock) are excluded.

Default (no --review-cmd, or --dry-run):
  Prints prosecution plan table: file, churn, inDegree, score
  Plus suggested charter line per file.

With --review-cmd:
  Runs command per file (spawnSync, shell=true).
  Lines matching /\\S+:\\d+/ or starting with '- ' are parsed as findings.
  Findings are appended to the .adlc/findings ledger.
  Exit code 2 from review-cmd is treated as "findings present" (not an error).
  Exit codes other than 0 or 2 cause operational error (exit 1).

Exit codes:
  0  Success (plan printed or review run complete)
  1  Operational error (not a git repo, review-cmd bad exit, etc.)
  2  Not used by this tool directly (reserved for gate-fail; review-cmd
     findings are appended to ledger, not a gate-fail of model-ratchet itself)

ADLC phase: C12 / D1-D3 maintenance ratchet

Examples:
  # Print prosecution plan for top 10 hot files
  model-ratchet

  # Print plan for top 5 files, last 500 commits
  model-ratchet --top 5 --churn-limit 500

  # Run adversarial review over top 10 hot files
  model-ratchet --review-cmd "adversarial-review --file {file}"

  # CI: run on every model release (add to .github/workflows/model-release.yml)
  # Cron: run monthly
  model-ratchet --review-cmd "npx adversarial-review {file}" --json
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Validate options
// ---------------------------------------------------------------------------

const topCount = parseInt(values.top, 10);
if (!Number.isInteger(topCount) || topCount < 1) {
  opError('--top must be a positive integer');
}

const churnLimit = parseInt(values['churn-limit'], 10);
if (!Number.isInteger(churnLimit) || churnLimit < 1) {
  opError('--churn-limit must be a positive integer');
}

const reviewCmd = values['review-cmd'];
const dryRun = values['dry-run'] || !reviewCmd;

// ---------------------------------------------------------------------------
// Verify git repo
// ---------------------------------------------------------------------------

const cwd = process.cwd();

if (!isGitRepo(cwd)) {
  opError('not a git repository (run from repo root)');
}

// ---------------------------------------------------------------------------
// Compute hot scores
// ---------------------------------------------------------------------------

let churnMap;
try {
  churnMap = churn(churnLimit, cwd);
} catch (err) {
  opError(`failed to compute churn: ${err.message}`);
}

const sourceFiles = walkSourceFiles(cwd);
const inDegreeMap = computeInDegree(sourceFiles, cwd);

// Merge: include all files that appear in either churn or sourceFiles
const allFiles = new Set([...sourceFiles, ...Object.keys(churnMap)]);
// Filter: keep only non-excluded source files
const candidateFiles = [...allFiles].filter(f => sourceFiles.includes(f));

const allScores = computeScores(churnMap, inDegreeMap, candidateFiles);
const selected = topN(allScores, topCount);

// ---------------------------------------------------------------------------
// Dry-run / plan mode
// ---------------------------------------------------------------------------

if (dryRun) {
  if (values.json) {
    printJson({
      mode: 'plan',
      top: topCount,
      churnLimit,
      files: selected,
    });
  } else {
    console.log(formatPlan(selected));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Review mode — run per file
// ---------------------------------------------------------------------------

const fileResults = [];
let operationalError = false;

for (const row of selected) {
  let result;
  try {
    result = runReviewCmd(reviewCmd, row.file);
  } catch (err) {
    fileResults.push({ file: row.file, findings: [], exitCode: -1, error: err.message });
    operationalError = true;
    continue;
  }

  // Exit codes: 0 = clean, 2 = findings (acceptable). Other codes = op error.
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    fileResults.push({
      file: row.file,
      findings: [],
      exitCode: result.exitCode,
      error: `review-cmd exited with code ${result.exitCode}`,
    });
    operationalError = true;
    continue;
  }

  const findings = parseFindingsFromOutput(result.stdout, row.file);

  // Append each finding to the ledger
  for (const finding of findings) {
    try {
      appendEntry('findings', finding);
    } catch (err) {
      // Surface but don't abort — partial data rule
      process.stderr.write(`warn: could not append finding to ledger: ${err.message}\n`);
    }
  }

  fileResults.push({ file: row.file, findings, exitCode: result.exitCode });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const totalFindings = fileResults.reduce((n, r) => n + r.findings.length, 0);

if (values.json) {
  printJson({
    mode: 'review',
    top: topCount,
    churnLimit,
    reviewCmd,
    files: selected,
    results: fileResults.map(({ file, findings, exitCode, error }) => ({
      file,
      exitCode: exitCode ?? null,
      error: error ?? null,
      findingCount: findings.length,
      findings,
    })),
    totalFindings,
    operationalError,
  });
} else {
  console.log(formatReviewSummary(fileResults));
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (operationalError) {
  process.exit(1);
}
process.exit(0);

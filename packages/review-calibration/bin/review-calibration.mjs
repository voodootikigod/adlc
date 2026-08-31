#!/usr/bin/env node
// review-calibration — reviewer recall measurement via planted bugs (ADLC C8)
//
// A plant is CAUGHT only when a reviewer finding LOCATES it AND identifies the
// defect — judged semantically (cheap model) or verified behaviorally (a repro
// that discriminates mutant from original). There is no string-match shortcut:
// a reviewer that merely echoes changed lines scores ~0, proven by the built-in
// echo control that runs on every invocation.
//
// Safety: refuses to run on a dirty tree; all plants restored in finally + SIGINT.

import { writeFileSync, readFileSync } from 'node:fs';
import {
  parseArgs, pass, gateFail, opError, printJson, promptOnly,
  git, isDirty, isGitRepo, mutate,
  complete as coreComplete, extractJson as coreExtractJson, detectProvider,
} from '@adlc/core';
import { filterCodeFiles, selectPlants, loadPlantsFile } from '../lib/targets.mjs';
import { runWithPlants } from '../lib/runner.mjs';
import { parseFindings } from '../lib/findings.mjs';
import { scorePlants } from '../lib/scorer.mjs';
import {
  makeLlmJudge, referenceJudge, JUDGE_SYSTEM, buildJudgePrompt, checkProviderIndependence,
  resolveEffectiveProvider,
} from '../lib/judge.mjs';
import { filterEquivalentMutants } from '../lib/verify.mjs';
import { echoReviewer, oracleReviewer } from '../lib/controls.mjs';
import { printScorecard, buildJsonReport } from '../lib/report.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    'review-cmd':   { type: 'string' },
    commit:         { type: 'string', default: 'HEAD' },
    plants:         { type: 'string', default: '8' },
    'min-recall':   { type: 'string', default: '0.5' },
    'min-precision':{ type: 'string' },
    'min-plants':   { type: 'string', default: '4' },
    scorer:         { type: 'string', default: 'judge' }, // judge | string
    files:          { type: 'string' },
    'plants-file':  { type: 'string' },
    tier:           { type: 'string', default: 'cheap' },
    'review-provider': { type: 'string' },
    strict:         { type: 'boolean', default: false },
    json:           { type: 'boolean', default: false },
    'prompt-only':  { type: 'boolean', default: false },
    help:           { type: 'boolean', default: false },
  },
});

const HELP_TEXT = `
review-calibration — reviewer recall measurement via planted bugs (ADLC C8)

Usage:
  review-calibration --review-cmd "cmd with {base} placeholder" [options]

A plant is caught only when a finding locates it AND identifies the defect
(judged by a cheap model, or verified by a reviewer-supplied repro). Echoing
changed lines scores ~0 — enforced by a built-in control on every run.

Options:
  --review-cmd <cmd>    (required) Command to run the reviewer. {base} is the
                        commit ref. Emit JSON findings (adversarial-review --json
                        shape) for rigorous scoring; prose is consumed weakly.
  --commit <ref>        Commit to target for plant selection (default: HEAD)
  --plants <n>          Number of bugs to plant (default: 8)
  --min-recall <f>      Minimum recall to pass the gate (default: 0.5)
  --min-precision <f>   Optional minimum precision to also require
  --min-plants <n>      Minimum valid-plant count required to report a recall
                        measurement (default: 4). Below this, the sample is
                        too small to mean anything — refuses with exit 1
                        instead of printing a scorecard.
  --scorer <mode>       judge (default; cheap-model semantic match) |
                        string (LEGACY location-only — gameable by echoing,
                        prints a warning; not a trustworthy recall number)
  --files <list>        Fallback comma-separated file list
  --plants-file <path>  JSON array of authored plants:
                        [{file,line,original,mutated,category?,defect?,witness?}]
  --tier cheap|mid|frontier  Model tier for the LLM judge (default: cheap)
  --review-provider <name>  Provider/model family the --review-cmd subprocess
                        actually uses (e.g. anthropic, openai, gemini). The
                        subprocess can't be introspected generically, so the
                        caller must state it. Compared against the judge's
                        own resolved provider — if they match, the "who
                        reviews the reviewer" independence claim is
                        undermined (same-family blind spots go undetected).
                        Warns by default; see --strict.
  --strict              Gate-fail (exit 2) instead of warning when
                        --review-provider matches the judge's resolved
                        provider. Requires --review-provider.
  --json                Machine-readable JSON output
  --prompt-only         Print a representative judge prompt and exit 0 (no
                        API key or git repo needed)
  --help                Show this help

Exit codes:
  0  Recall (and precision, if set) meet thresholds
  1  Operational error (dirty tree, no plants, review crashed, no judge available,
     or the scorer's own control self-test failed)
  2  Recall/precision below thresholds (gate fails), or --strict provider match

ADLC phase: P5 meta-gate — "who reviews the reviewer"
`;

if (values.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(values.tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${values.tier}`);
}

// --prompt-only: print a representative judge prompt and exit 0. Checked
// BEFORE the --review-cmd requirement and any git/dirty-tree checks — the
// tool must be usable with zero setup, not just zero API keys.
if (values['prompt-only']) {
  const placeholderPlant = {
    file: 'src/example.mjs',
    line: 42,
    category: 'off-by-one',
    original: 'i <= arr.length',
    mutated: 'i < arr.length',
    defect: 'off-by-one bound change causes an out-of-bounds read',
  };
  const placeholderFinding = {
    file: 'src/example.mjs',
    line: 42,
    description: '<reviewer finding text will appear here>',
    evidence: null,
  };
  promptOnly(`${JUDGE_SYSTEM}\n\n${buildJudgePrompt(placeholderPlant, placeholderFinding)}`);
  // promptOnly exits; unreachable
}

if (!values['review-cmd']) {
  console.log(HELP_TEXT);
  process.exit(1);
}

const reviewCmd  = values['review-cmd'];
const commitRef  = values.commit;
const maxPlants  = parseInt(values.plants, 10);
const minRecall  = parseFloat(values['min-recall']);
const minPrecision = values['min-precision'] != null ? parseFloat(values['min-precision']) : null;
const minPlants  = parseInt(values['min-plants'], 10);
const scorerMode = values.scorer;
const filesFlag  = values.files ?? '';
const tier       = values.tier;
const useJson    = values.json;
const cwd        = process.cwd();
const reviewProvider = values['review-provider'];
const strict     = values.strict;

if (isNaN(maxPlants) || maxPlants < 1)  opError('--plants must be a positive integer');
if (isNaN(minPlants) || minPlants < 1)  opError(`--min-plants must be a positive integer, got: ${values['min-plants']}`);
if (isNaN(minRecall) || minRecall < 0 || minRecall > 1) opError('--min-recall must be between 0 and 1');
if (minPrecision != null && (isNaN(minPrecision) || minPrecision < 0 || minPrecision > 1)) {
  opError('--min-precision must be between 0 and 1');
}
if (scorerMode !== 'judge' && scorerMode !== 'string') {
  opError(`--scorer must be "judge" or "string" (got "${scorerMode}")`);
}
if (strict && !reviewProvider) {
  opError('--strict requires --review-provider — nothing to compare the judge against');
}

// ── safety checks ────────────────────────────────────────────────────────────

if (!isGitRepo(cwd)) opError('not a git repository');
if (isDirty(cwd)) opError('commit or stash first — review-calibration plants bugs in-place and restores them');

// ── resolve the judge BEFORE expensive work (fail closed, never string-match silently) ──

let judge;
let judgeProviderName;
if (scorerMode === 'string') {
  console.error(
    'WARNING: --scorer string is location-only and is defeated by a reviewer that ' +
    'echoes changed lines. This recall number is NOT trustworthy. Use the default ' +
    '(judge) scorer for an honest measurement.'
  );
  judge = () => true; // any locating finding counts — the gameable legacy behavior
} else {
  const judgeProvider = detectProvider();
  if (!judgeProvider) {
    opError(
      'no LLM provider for the judge — set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, ' +
      'or pass --scorer string (gameable, warned). Refusing to emit a string-matched recall number.'
    );
  }
  // agy's actual model family is tier-dependent (e.g. --tier cheap runs
  // Gemini, --tier mid/frontier run Claude/anthropic) — resolve to the
  // family it will really dispatch to, not the literal 'agy' provider name,
  // so the independence guard below can't be silently defeated (issue #64).
  judgeProviderName = resolveEffectiveProvider(judgeProvider, tier);
  judge = makeLlmJudge(coreComplete, coreExtractJson, tier);
}

// ── provider-independence guard (issue #64) ──────────────────────────────────
// "Who reviews the reviewer" is undermined if the judge and the reviewer
// under test (--review-cmd, an opaque subprocess we cannot introspect) are
// silently the same model family. --review-provider is the caller's explicit
// declaration of what --review-cmd actually runs on.

const independence = checkProviderIndependence(reviewProvider, judgeProviderName);
if (independence.same) {
  const msg =
    `judge and --review-provider are both "${judgeProviderName}" — the reviewer-under-test ` +
    'and the judge scoring it share the same model family, undermining the "who reviews ' +
    'the reviewer" independence this gate exists to check';
  if (strict) {
    gateFail(msg);
  } else {
    console.error(
      `WARNING: ${msg}. Use --strict to fail the gate on this, or pass --review-provider ` +
      'for a provider different from the judge\'s.'
    );
  }
}

// ── select plants ────────────────────────────────────────────────────────────

let plants;
if (values['plants-file']) {
  const { plants: loaded, errors } = loadPlantsFile(values['plants-file'], cwd);
  if (errors.length > 0) opError(`plants file problems:\n  ${errors.join('\n  ')}`);
  if (loaded.length === 0) opError('plants file contains no valid plants — cannot calibrate');
  plants = loaded.slice(0, maxPlants);
} else {
  let commitFiles = [];
  try {
    const treeOutput = git(['diff-tree', '--no-commit-id', '-r', '--name-only', commitRef], { cwd });
    commitFiles = treeOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    opError(`git diff-tree failed for commit "${commitRef}": ${err.message}`);
  }
  let codeFiles = filterCodeFiles(commitFiles);
  if (codeFiles.length === 0 && filesFlag.trim() !== '') {
    codeFiles = filterCodeFiles(filesFlag.split(',').map((f) => f.trim()).filter(Boolean));
  }
  if (codeFiles.length === 0) {
    opError('no eligible code files found in commit (or --files fallback) — nothing to plant');
  }
  plants = selectPlants(codeFiles, cwd, maxPlants, mutate.generateMutants);
  if (plants.length === 0) opError('no mutants could be generated from the target files — cannot calibrate');
}

// ── equivalent-mutant filter (plants WITH a witness must discriminate) ────────

const { valid: validPlants, equivalent } = filterEquivalentMutants(plants, cwd);
if (validPlants.length === 0) {
  opError(`all ${plants.length} plant(s) were equivalent mutants (no behavioral discriminator) — cannot calibrate`);
}
if (validPlants.length < minPlants) {
  opError(
    `only ${validPlants.length} valid plant(s) (--min-plants requires ${minPlants}) — ` +
    'the sample is too small to certify a recall measurement; raise --plants, adjust the ' +
    'target files, or lower --min-plants if this small a sample is deliberate.'
  );
}
const equivalentExcluded = equivalent.length;

// ── control self-test (deterministic, no network) — bounds the scorer ─────────
// echoer must score ~0; oracle must score 1.0. A failure means the SCORER is
// broken (this is the regression that catches a string-match shortcut), so it
// is an operational error, not a reviewer verdict.

const echoScore = await scorePlants(validPlants, echoReviewer(validPlants), { judge: referenceJudge });
const oracleScore = await scorePlants(validPlants, oracleReviewer(validPlants), { judge: referenceJudge });
if (echoScore.recall > 0.001) {
  opError(`scorer self-test FAILED: echo control scored recall ${echoScore.recall.toFixed(3)} (must be ~0) — the scorer has a non-semantic shortcut`);
}
if (oracleScore.recall < 0.999) {
  opError(`scorer self-test FAILED: oracle control scored recall ${oracleScore.recall.toFixed(3)} (must be 1.0) — the scorer has false negatives`);
}

// ── SIGINT safety: track planted files for emergency restore ──────────────────

const preOriginals = new Map();
for (const plant of validPlants) {
  if (!preOriginals.has(plant.absolutePath)) {
    try { preOriginals.set(plant.absolutePath, readFileSync(plant.absolutePath, 'utf8')); } catch { /* runner errors properly */ }
  }
}
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
  runResult = runWithPlants(validPlants, reviewCmd, commitRef, cwd, 300_000);
} catch (err) {
  plantedFiles = null;
  opError(`planting or review command failed: ${err.message}`);
}
plantedFiles = null;

const { exitCode, timedOut, stdout, stderr } = runResult;
if (timedOut) opError('review command timed out');
if (exitCode !== 0 && exitCode !== 2) {
  opError(`review command exited with code ${exitCode} — expected 0 or 2`);
}

// ── score real findings ───────────────────────────────────────────────────────

const findings = parseFindings(stdout + '\n' + stderr);
const score = await scorePlants(validPlants, findings, { judge });

const scorecard = {
  ...score,
  commit: commitRef,
  minRecall,
  minPrecision,
  scorer: scorerMode,
  reviewExitCode: exitCode,
  equivalentExcluded,
};

// ── output ────────────────────────────────────────────────────────────────────

if (useJson) printJson(buildJsonReport(scorecard));
else printScorecard(scorecard);

// ── exit ──────────────────────────────────────────────────────────────────────

const recallFail = score.recall < minRecall;
const precisionFail = minPrecision != null && score.precision < minPrecision;
if (recallFail || precisionFail) {
  if (useJson) process.exit(2);
  gateFail(
    `gate fails — recall ${(score.recall * 100).toFixed(1)}% (min ${(minRecall * 100).toFixed(1)}%)` +
    (minPrecision != null ? `, precision ${(score.precision * 100).toFixed(1)}% (min ${(minPrecision * 100).toFixed(1)}%)` : '')
  );
}
pass();

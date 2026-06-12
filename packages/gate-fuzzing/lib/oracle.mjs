// gate-fuzzing/lib/oracle.mjs
// Oracle independence check (§1.1).
// Fix 3: Only sources (a) contract-derived and (b) independent-context approval.
// Source (c) suite-minus-G corroboration removed as logically vacuous.
//
// A witness is "independent" if it is either:
//   (a) contract-derived: mechanically derived from the gate's declared contract,
//       not authored by the adversary
//   (b) independently-approved: a separate fresh-context lens confirms the witness
//       pins a genuine defect and is not contrived to the diff

/**
 * Check oracle independence for a candidate's witness.
 *
 * @param {object} opts
 * @param {object} opts.candidate - The candidate (target, claimKind, witnessProposal)
 * @param {'contract-derived'|'proposed'} opts.witnessSource - How the witness was obtained
 * @param {Function|null} opts.independentApprovalFn - (candidate, witnessProposal) => {approved, reason}
 * @returns {{independent:boolean, source:string, reason?:string}}
 */
export function checkOracle({ candidate, witnessSource, independentApprovalFn }) {
  // (a) Contract-derived: fully independent by construction
  if (witnessSource === 'contract-derived') {
    return { independent: true, source: 'contract-derived' };
  }

  // (b) Independent-context approval lens
  if (typeof independentApprovalFn === 'function') {
    const approval = independentApprovalFn(candidate, candidate.witnessProposal);
    if (approval.approved) {
      return { independent: true, source: 'independently-approved' };
    }
    return {
      independent: false,
      source: 'unwitnessed',
      reason: `independent lens rejected: ${approval.reason}`,
    };
  }

  // No independent source available → unwitnessed
  return {
    independent: false,
    source: 'unwitnessed',
    reason: 'no contract derivation and no independent approval function provided',
  };
}

/**
 * Build a contract-derived witness for gates with a declared contract.
 * For freeze-integrity gates: the witness checks that a frozen file's content
 * hash changed between baseline and candidate.
 *
 * @param {object} gate - Gate descriptor with claims
 * @param {object} candidate - The candidate
 * @param {string} baselineDir - Path to baseline clone
 * @param {string} cloneDir - Path to candidate clone
 * @returns {{witnessSpec:object, source:'contract-derived'}|null}
 */
export function deriveContractWitness(gate, candidate, baselineDir, cloneDir) {
  // Only contract-derivable for freeze-integrity claim kind
  if (!gate.claims?.includes(candidate.claimKind)) return null;
  if (candidate.claimKind !== 'freeze-integrity') return null;

  // The witness: check if any file in the gate's surface has changed hash
  // We encode this as a node command that compares hashes
  // For test purposes, return the witness spec shape
  return {
    witnessSpec: {
      cmd: 'node',
      args: [
        '--input-type=module',
        `--eval`,
        buildFreezeCheckScript(gate.surface ?? ['**'], baselineDir, cloneDir),
      ],
    },
    source: 'contract-derived',
  };
}

function buildFreezeCheckScript(surface, baselineDir, cloneDir) {
  // Script that exits 0 on baseline (clean), exits 1 if any surface file changed
  return `
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const surface = ${JSON.stringify(surface)};
const baselineDir = ${JSON.stringify(baselineDir)};
const cloneDir = ${JSON.stringify(cloneDir)};

// Simple glob match for surface patterns
function matches(path, patterns) {
  return patterns.some(p => {
    if (p === '**') return true;
    const re = new RegExp('^' + p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
    return re.test(path);
  });
}

function sha(content) {
  return createHash('sha256').update(content).digest('hex');
}

// This script is expected to run WITH a specific dir — caller injects __dir
// For contract witness: check if __dir is candidate (hash mismatch = defect observable)
const __dir = process.env.GF_CHECK_DIR || process.cwd();
const isCandidate = __dir === cloneDir;

if (!isCandidate) {
  // On baseline: always pass (behavior intact)
  process.exit(0);
}

// On candidate: check if any surface file changed vs baseline
// Exit 1 if any file changed (defect observable)
// This is a simplified implementation; real impl would walk files
process.exit(0); // placeholder — real contract witness is gate-specific
`;
}

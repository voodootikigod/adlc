export const VS_SDLC_ROWS = [
  {
    dimension: 'Defends against',
    sdlc: 'Human failure: forgetfulness, ego, fatigue',
    adlc: 'Model failure: premature satisfaction, sycophancy, context rot, reward hacking',
  },
  {
    dimension: 'The spec',
    sdlc: 'A requirements document humans interpret',
    adlc: 'Tests are the spec, frozen as rails before the build starts',
  },
  {
    dimension: 'Review',
    sdlc: 'Peer code review: does a colleague approve?',
    adlc: 'Prosecution: fresh reviewers charged with breaking the change, and findings must reproduce before the builder sees them',
  },
  {
    dimension: 'Unit of trust',
    sdlc: 'The engineer who wrote it',
    adlc: 'Explicit exit contracts: deterministic evidence plus human attestation',
  },
  {
    dimension: 'Audit trail',
    sdlc: 'Commit messages and ticket comments',
    adlc: 'gate-manifest: a verdict ledger auditors can read',
  },
  {
    dimension: 'Cost over time',
    sdlc: 'Process overhead compounds',
    // Mechanism, not an economic promise: P7 turns review findings into
    // deterministic lints and skills, so the same defect class is caught by a
    // machine on the next run. Stated as what the lifecycle does, not what it
    // will save.
    adlc: 'Findings distill into deterministic defenses (P7), so the same failure is caught by a lint next time',
  },
];

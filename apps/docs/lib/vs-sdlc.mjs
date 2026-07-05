export const VS_SDLC_ROWS = [
  {
    dimension: 'Defends against',
    sdlc: 'Human failure: forgetfulness, ego, fatigue',
    adlc: 'Model failure: premature satisfaction, sycophancy, context rot, reward hacking',
  },
  {
    dimension: 'The spec',
    sdlc: 'A requirements document humans interpret',
    adlc: 'Tests are the spec — rails frozen before the build starts',
  },
  {
    dimension: 'Review',
    sdlc: 'Peer code review: does a colleague approve?',
    adlc: 'Prosecution: fresh contexts chartered to refute, findings verified by reproduction before reaching the builder',
  },
  {
    dimension: 'Unit of trust',
    sdlc: 'The engineer who wrote it',
    adlc: 'The gate evidence — machine-checkable artifacts per phase',
  },
  {
    dimension: 'Audit trail',
    sdlc: 'Commit messages and ticket comments',
    adlc: 'gate-manifest: a verdict ledger auditors can read',
  },
  {
    dimension: 'Cost over time',
    sdlc: 'Process overhead compounds',
    adlc: 'Lifecycle gets cheaper — findings distill into permanent defenses',
  },
];

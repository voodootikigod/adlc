export const TOOLKIT_GROUPS = [
  {
    group: 'Spec & ticket shaping',
    packages: ['tickets', 'parallax', 'spec-lint', 'premortem', 'coldstart', 'ticket-sync', 'ticket-prune'],
  },
  {
    group: 'Execution supervision & rails',
    packages: ['preflight', 'model-router', 'merge-forecast', 'rails-guard', 'build-gate', 'flail-detector', 'consensus-fix', 'runner', 'fleet'],
  },
  {
    group: 'Review evidence & calibration',
    packages: ['behavior-diff', 'gate-manifest', 'hollow-test', 'prosecute', 'review-calibration', 'model-ratchet', 'gate-fuzzing'],
  },
  {
    group: 'Compounding defenses',
    packages: ['lesson-foundry', 'rejection-mining', 'skill-rot'],
  },
  {
    group: 'Shared foundation',
    packages: ['cli', 'core'],
  },
];

export const ALL_PACKAGES = TOOLKIT_GROUPS.flatMap((g) => g.packages);

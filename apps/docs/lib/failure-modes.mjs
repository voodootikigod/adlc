export const FAILURE_MODES = {
  F1: {
    name: 'Premature satisfaction',
    tagline: 'Declares victory the moment code plausibly compiles.',
    defense: { tool: 'spec-lint', phase: 'P1' },
  },
  // ADLC.md names F2 in both P3 ("self-validation") and P5; P5/prosecute is the
  // canonical kill — prosecution is the adversarial check sycophancy can't satisfy.
  F2: {
    name: 'Sycophancy',
    tagline: 'Agrees with whatever framing the prompt implies.',
    defense: { tool: 'prosecute', phase: 'P5' },
  },
  F3: {
    name: 'Context rot',
    tagline: 'Loses the plot as the session grows.',
    defense: { tool: 'coldstart', phase: 'P2' },
  },
  F4: {
    name: 'Confident hallucination',
    tagline: 'Invents APIs, files, and facts with total certainty.',
    defense: { tool: 'premortem', phase: 'P1' },
  },
  F5: {
    name: 'Reward hacking',
    tagline: 'Games the check instead of doing the work.',
    defense: { tool: 'hollow-test', phase: 'P3' },
  },
  F6: {
    name: 'Finding-count prior',
    tagline: 'Stops at the usual dozen findings, whether or not more exist.',
    defense: { tool: 'review-calibration', phase: 'P5' },
  },
  // No packages/simplify exists; lesson-foundry is the nearest real P7 tool (proxy).
  F7: {
    name: 'Generative bloat',
    tagline: 'Writes ten files where a diff would do.',
    defense: { tool: 'lesson-foundry', phase: 'P7' },
  },
  // model-router self-identifies as a D1 cost-dial tool; it defends F8 where the
  // damage happens (P4 build), the closest phase id PHASES offers.
  F8: {
    name: 'Coherence loss',
    tagline: 'Switches models mid-task and leaves the seams showing.',
    defense: { tool: 'model-router', phase: 'P4' },
  },
};

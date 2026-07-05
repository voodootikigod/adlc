export const FAILURE_MODES = {
  F1: {
    name: 'Premature satisfaction',
    tagline: 'Declares victory the moment code plausibly compiles.',
    defense: { tool: 'spec-lint', phase: 'P1' },
  },
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
  F7: {
    name: 'Generative bloat',
    tagline: 'Writes ten files where a diff would do.',
    defense: { tool: 'lesson-foundry', phase: 'P7' },
  },
  F8: {
    name: 'Coherence loss',
    tagline: 'Switches models mid-task and leaves the seams showing.',
    defense: { tool: 'model-router', phase: 'P4' },
  },
};

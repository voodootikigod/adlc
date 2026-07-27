// Executable command surface shared by the homepage terminal treatments.
// Keep commands aligned with the real CLI; tests invoke every tool's --help.
//
// IMPORTANT: `output` is a one-line SUMMARY of each gate's verdict, authored for
// the page — it is not a captured transcript. The real `spec-lint` prints a
// per-criterion table ending "spec-lint: all criteria verified."; it never emits
// the line below. The commands and the exit-code semantics are real, and the
// homepage says so in exactly those terms. Do not add copy claiming these are
// verbatim captures without first replacing these strings with real captures
// (deterministic fixtures + a test asserting the capture still matches).
export const MARKETING_GATES = [
  {
    name: 'spec-lint',
    gate: 'Is the spec executable?',
    command: 'adlc spec-lint ticket.md',
    state: 'pass',
    detail: 'acceptance checks are named',
    output: '$ adlc spec-lint ticket.md\n✓ PASS: every acceptance criterion names a verification method',
  },
  {
    name: 'rails-guard',
    gate: 'Are the frozen tests untouched?',
    command: 'adlc rails-guard --base main --ticket T42 --tickets .adlc/tickets.json',
    state: 'fail',
    detail: 'a frozen rail changed',
    output: '$ adlc rails-guard --base main --ticket T42 --tickets .adlc/tickets.json\n✗ FAIL: a frozen rail changed',
  },
  {
    name: 'hollow-test',
    gate: 'Do the tests detect behavior changes?',
    command: 'adlc hollow-test --test-cmd "npm test" --base main',
    state: 'fail',
    detail: 'a mutant survived',
    output: '$ adlc hollow-test --test-cmd "npm test" --base main\n✗ FAIL: one changed-code mutant survived',
  },
  {
    name: 'review-calibration',
    gate: 'Would review catch a planted defect?',
    command: 'adlc review-calibration --review-cmd "adlc review --base {base}" --plants 3',
    state: 'pass',
    detail: 'review recall met threshold',
    output: '$ adlc review-calibration --review-cmd "adlc review --base {base}" --plants 3\n✓ PASS: planted-defect recall met the configured threshold',
  },
];

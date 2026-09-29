// Prose tool-log shapes and the count each must produce. Shared by the
// build-gate depth-signal tests and the plugin hook parity test.
export const PROSE_CASES = [
  ['line-leading', 'Writing src/a.mjs\nEditing src/b.mjs', 2],
  ['clock timestamp', '12:00:01 Writing src/a.mjs\n12:00:02 Editing src/b.mjs', 2],
  ['bracketed timestamp', '[12:00:01] Created src/a.mjs\n[12:00:02.123] Writing src/b.mjs', 2],
  ['ISO timestamp', '2026-09-28T12:00:01Z Writing src/a.mjs\n2026-09-28T12:00:02.5+02:00 Editing src/b.mjs', 2],
  ['indented', '  Writing src/a.mjs\n\tEditing src/b.mjs', 2],
  ['indented after timestamp', '12:00:01   Writing src/a.mjs', 1],
  ['CRLF lines', '12:00:01 Writing src/a.mjs\r\n12:00:02 Editing src/b.mjs\r\n', 2],
  ['mid-sentence mention', 'I am Writing src/a.mjs now\nthen Editing src/b.mjs', 0],
  ['word before the verb', 'note: Writing src/a.mjs', 0],
  ['number that is not a timestamp prefix', '42 Writing src/a.mjs', 0],
  ['JSONL string content', '{"type":"text","text":"Writing src/a.mjs"}\n{"message":"12:00:01 Editing src/b.mjs"}', 0],
  ['verb with no target', 'Writing\n12:00:01 Editing', 0],
];

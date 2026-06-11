// Prompt construction for the three parallax modes.
// Pure functions — no I/O, testable offline.

/**
 * Build the spec-reader prompt for one cheap-tier fan agent.
 * Each agent commits to ONE reading and outputs JSON.
 * @param {string} request - The feature request text.
 * @returns {string}
 */
export function buildSpecReaderPrompt(request) {
  return `You are given a feature request. Write the concrete spec you would execute.
Commit to ONE reading; do NOT ask questions.
Output JSON with exactly these keys:
{
  "spec": "full prose spec you would hand to an engineer",
  "assumptions": ["assumption you made", ...],
  "decisions": [{"point": "ambiguous point", "choice": "how you resolved it"}, ...]
}

Feature request:
${request}`;
}

/**
 * Build the divergence-analysis prompt for a mid-tier completion.
 * Given N readings as JSON, find agreements and divergences.
 * @param {Array<object>} readings - Parsed spec reading objects.
 * @returns {string}
 */
export function buildDivergencePrompt(readings) {
  const readingText = readings.map((r, i) =>
    `=== Reading ${i + 1} ===\n${JSON.stringify(r, null, 2)}`
  ).join('\n\n');

  return `You are given ${readings.length} independent readings of the same feature request.
Analyse them and output JSON with exactly these keys:
{
  "agreements": ["thing all readings agreed on", ...],
  "divergences": [
    {
      "point": "what the readings disagree about",
      "options": [
        {"label": "A", "reading": "what reading 1 (and possibly others) chose"},
        {"label": "B", "reading": "what reading 2 (and possibly others) chose"}
      ]
    },
    ...
  ]
}

Agreements: facts, constraints, outcomes that ALL readings converged on identically.
Divergences: any point where two or more readings made different, mutually-exclusive choices.
Options must be labelled A, B, C … in order.
Output ONLY the JSON object. No prose outside the JSON.

${readingText}`;
}

/**
 * Build the edge-interface prompt for one cheap fan agent.
 * Each agent independently authors the interface implied by two tickets.
 * @param {object} ticketA - First ticket object.
 * @param {object} ticketB - Second ticket object.
 * @returns {string}
 */
export function buildEdgePrompt(ticketA, ticketB) {
  return `You are given two adjacent tickets in a parallel development plan.
Write the exact interface/contract (types, function signatures, endpoint shapes, error cases)
implied between these two tickets. Commit to ONE interpretation; do NOT ask questions.
Output JSON with exactly these keys:
{
  "spec": "prose description of the interface",
  "assumptions": ["assumption you made", ...],
  "decisions": [{"point": "ambiguous point", "choice": "how you resolved it"}, ...]
}

=== Ticket A: ${ticketA.id} — ${ticketA.title} ===
${ticketA.body ?? '(no body)'}

=== Ticket B: ${ticketB.id} — ${ticketB.title} ===
${ticketB.body ?? '(no body)'}`;
}

/**
 * Build the route-answer prompts for cheap fan agents.
 * Each agent answers the question given context file contents.
 * @param {string} question - The routing question.
 * @param {Array<{path: string, content: string}>} contextFiles - Context files.
 * @returns {string}
 */
export function buildRouteAnswerPrompt(question, contextFiles) {
  const ctxSection = contextFiles.length > 0
    ? '\n\n' + contextFiles.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n')
    : '';

  return `You are a technical analyst. Answer the following question as precisely and concisely as possible.
Base your answer ONLY on the provided context. If the context does not answer it, say so plainly.
Do NOT hedge or ask clarifying questions — commit to one answer.${ctxSection}

Question: ${question}`;
}

/**
 * Build the equivalence-judge prompt for a single cheap completion.
 * Judges whether multiple route answers are semantically equivalent.
 * @param {string} question - Original question.
 * @param {string[]} answers - The answers from the fan.
 * @returns {string}
 */
export function buildRouteJudgePrompt(question, answers) {
  const answerText = answers.map((a, i) => `=== Answer ${i + 1} ===\n${a}`).join('\n\n');

  return `You are judging whether several answers to a question are semantically equivalent.
"Semantically equivalent" means: any reasonable developer reading each answer would make the same implementation decision.
Minor wording differences, detail level differences, or ordering differences do NOT make answers non-equivalent.
Real divergence means the answers point to different implementations, different APIs, or different behaviours.

Output JSON with exactly these keys:
{
  "equivalent": true or false,
  "answer": "the single best answer (if equivalent) or empty string (if not)",
  "variants": ["short label for option A", "short label for option B", ...]
}

If equivalent is true: answer must be non-empty; variants may be empty.
If equivalent is false: answer must be empty string; variants must list each distinct interpretation.
Output ONLY the JSON object.

Question: ${question}

${answerText}`;
}

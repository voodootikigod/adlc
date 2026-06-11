# The Agentic Development Lifecycle — blog series

Seven posts, drafted from [ADLC.md](../../ADLC.md). Narrative arc: *why → the lifecycle → trust (rails) → judgment (prosecution) → scale (parallelism) → compounding → proof + adoption*. Each post opens with a callback to the previous one and closes with a teaser for the next — publish in order.

| # | Post | Big idea | Tools featured |
|---|------|----------|----------------|
| 1 | [Stop Running the SDLC on Models That Aren't Human](./01-stop-running-the-sdlc-on-models-that-arent-human.md) | Flaw inventory F1–F8; flaws-as-features E1–E5; the design rule | — |
| 2 | [Two Human Gates and Everything Between Is Machine-Checked](./02-two-human-gates.md) | P0–P7; two human gates; barbell economics; norms rejected | `coldstart`, `spec-lint` |
| 3 | [Tests Are the Spec in the Only Language the Builder Can't Argue With](./03-tests-are-the-spec.md) | Rails; frozen by hook not instruction; Goodhart annex; why not coverage % | `rails-guard`, `hollow-test` |
| 4 | [Prosecution, Not Code Review](./04-prosecution-not-code-review.md) | Refute charters; findings-as-claims; loop-until-dry; measure reviewer recall | `review-calibration`, `adversarial-review`, `premortem` |
| 5 | [Three Dials: Parallel Agents Without Merge Hell](./05-three-dials-parallel-agents.md) | Cost/wall-clock/accuracy coupling; lanes not boss agent; width formula; measured ambiguity | `merge-forecast`, `model-router`, `parallax`, `preflight` |
| 6 | [The Lifecycle That Gets Cheaper Every Run](./06-the-lifecycle-that-gets-cheaper.md) | Distill; lessons ledger; skill rot; model ratchet; cost per merged verified change | `lesson-foundry`, `skill-rot`, `model-ratchet`, `rejection-mining` |
| 7 | [We Built the Toolkit With the Lifecycle](./07-we-built-the-toolkit-with-the-lifecycle.md) | Dogfood story; full toolkit index; frontier-free doctrine; adoption path | all 18 |

## Before publishing

- [ ] Post 4: optionally add measured recall / false-positive numbers from a real `review-calibration --scorer judge` run against a configured LLM provider. (The unsubstantiated-numbers TODO was removed; the post no longer claims measured figures it doesn't have.)
- [ ] Add repo / npm links once package publishing status is settled (posts reference `npx <tool>` invocations).
- [ ] Diagrams: post 2 (lifecycle flow), post 5 (orchestrator lanes) use ASCII — consider rendering as images for platforms that mangle code blocks.
- [ ] Cadence suggestion: weekly; have posts 1–2 live at launch so the hook converts.

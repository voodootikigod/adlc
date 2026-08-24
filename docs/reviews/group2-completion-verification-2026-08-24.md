# Group-2 completion-verification findings — for accuracy review

Context (facts, not instructions): thirteen tickets were verified against pinned commit
e6fb5df7 of voodootikigod/adlc by two independent agents under a fail-closed gate (per-AC
artifact mapping; verify commands with negative controls against the pre-ship tree; mutation
proofs for test artifacts; refutation duty on prose; any unmapped criterion results in
STAYS-OPEN). Consequence asymmetry, as a property of the system under review: completed:true
is the canonical shipped claim and removes a ticket from every backlog consumer, so an
erroneous COMPLETE has larger blast radius than an erroneous STAYS-OPEN. All claims below
cite the pin; the repository is available.

Negative-control provenance (auditable): B4-B6 use 1bfafab2 = the verified first parent of
ship commit beafd956 (git rev-parse beafd956^ = 1bfafab2…0527; merge-base --is-ancestor
confirms). I3 uses e8ab70f0, a verified ancestor of I3's ship commit 340b31c2; v1.10.0 was
rejected as a control for I3 because the ship commit predates the tag.

## COMPLETE verdicts (4): T-01KZRQF41GMGMTXG8MFVN8FJW8, T-01M05MH142KEXEY28HM4SRSDC8, T-01M05MJR1E645A1Q26Z8VSDF7X, T-01M05MJXYFRB8BKY5ZWFQDPG05

### A2 — T-01KZRQF41GMGMTXG8MFVN8FJW8 (spec-lint zero-criteria + run-tests completeness)
- Both halves shipped in ONE commit (5d6daa60, PR #494) — corrects the briefed premise that
  the second half lagged.
- AC1: packages/spec-lint/test/zero-criteria.test.mjs — 4/4 pass on pin; file absent at
  v1.10.0 (negative control fails there).
- AC2: scripts/test/run-tests-completeness.test.mjs — 3/3 pass; absent at v1.10.0. Mutation:
  deleting the gemini segment from scripts/run-tests.mjs turned "every plugin test dir on
  disk is run by some SEGMENT" red; the test also carries its own load-bearing self-case.

### B4 — T-01M05MH142KEXEY28HM4SRSDC8 (gate 1 machine-checked: spec-approval in p1, coldstart in p0)
- Shipped beafd956 (PR #518). 6/6 ACs; runner suite 143/143 on pin.
- Negative control: pin's p0-p1-gates.test.mjs copied into the pre-ship (1bfafab2) worktree:
  36/41 fail there.
- Mutations: dropping 'spec-approval' from the p1 array → 2 tests fail; removing the p0 key
  → 11 fail; neutering the unresolved!==0 rejection → 1 fails.
- Refutations attempted and failed: no harness left emitting the legacy payload (copilot +
  gemini SKILL.md emit the full new shape); no legacy carve-out in the validator; the
  cursor commands/ scope path is a COMMITTED SYMLINK to command/ (not a typo, not untracked
  — one blob, byte-identical targets).

### B5 — T-01M05MJR1E645A1Q26Z8VSDF7X (P0 authoring interrogates before the store write)
- 5/5 ACs on pin; every grep AC exits 1 at pre-ship 1bfafab2.
- Section "## 1b. Interrogate the human" exists at the specified position; §4 loop-until-
  zero-gaps THEN record-verdict verbatim-verified; all four peer harnesses reference
  interrogation-protocol.
- Adjudicated exclusion, with the norm stated: in this repo's ticket schema the ACCEPTANCE
  CRITERIA section is the completion contract (spec-lint gates specs on criteria, and every
  completion in the 1.11 arc was judged on ACs); the "What to change" build steps are
  non-normative guidance toward them. B5's AC3 enumerates the exact file list and is fully
  satisfied. The build step naming "the pi ticket flow" targets a flow that does not exist
  in pi (plugins/adlc-pi/prompts/ has no adlc-ticket prompt) — there is nothing to modify;
  the harness-parity gap itself is tracked by issue #241 (harness-capability-matrix), so
  the exclusion is justified and the gap is owned elsewhere, not silently dropped.

### B6 — T-01M05MJXYFRB8BKY5ZWFQDPG05 (/adlc-spec for CC + parallax --questions-json)
- 5/5 ACs. parallax suite 96/96; questions-json.test.mjs asserts payload shape, variant
  labels, both mutual-exclusion exits.
- Mutations: dropping options from renderQuestionsJson → red; <=→< on the gate threshold →
  red; neutering the --questions-json+--prompt-only guard → red.
- 3-round cap + approved-assumptions escape hatch verbatim in the command file AND
  docs/interrogation-protocol.md; cursor + opencode carry the same wording.

## STAYS-OPEN verdicts (9)

- I3 — VERDICT: STAYS-OPEN. Authoritative single status: not complete today. Becomes
  completable only after a one-line guard hardening (assert heroInstall > the hero
  MarketingSection opening index in apps/docs/test/install-cta.test.mjs) ships in its own
  prior PR and both previously-green AC-violating mutations are re-run red. REOPENING GATE,
  fully specified: on the guard PR's head commit, (M-a) move the `<IntegrationCard` JSX out
  of the hero — insert it ABOVE the `<MarketingSection headingLevel={1}` opening — in
  apps/docs/app/integrations/[slug]/page.tsx; (M-b) relocate the same element inside
  `function NativeBundle`'s returned JSX. After EACH single mutation:
  `node --test apps/docs/test/install-cta.test.mjs` must exit 1 with the NEW assertion
  ("the install card must sit inside the hero section" / the heroInstall > hero-open index
  check) as the failing case; restore between mutations; suite green after restores. Details:
Original verdict was COMPLETE on manual source inspection despite a disclosed half-width
guard (two acceptance-criterion-violating mutations leave all 7 test cases green). That
contradicts the gate's mutation-proof basis, so the verdict is revised: the one-line guard
assertion (heroInstall > hero MarketingSection opening index) ships in its own prior PR;
I3 completes only after that guard is in and proven load-bearing by re-running the two
mutations (both must go red). Until then I3 is functionally STAYS-OPEN.
Evidence retained for the eventual completion:
- Shipped 340b31c2 (PR #351, 2026-07-26 — predates the v1.10.0 tag, so v1.10.0 is INVALID as
  a negative control; control ran instead at pre-ship e8ab70f0 with the test ported in:
  5/7 fail there).
- apps/docs/test/install-cta.test.mjs 7/7 on pin, CI-wired via scripts/run-tests.mjs:152.
- Per-AC source positions verified independently of the tests (line indices in
  integration page, index page L30<L81, homepage L137<L178); single-source literal grep:
  exactly one hit at apps/docs/lib/install-commands.mjs:15.
- DISCLOSED CAVEAT: AC3.1's guard is one-sided (asserts heroInstall < surfaces, never
  > hero-open); two AC-violating mutations leave all 7 cases green. Shipped STATE verified
  correct by source inspection; the GUARD is half-width (follow-up filed, not a blocker per
  the verifier).



- A1 T-01KZRQF3RWQBHSXN3K7VR3B25W — wrapper-timeout half shipped + mutation-proven (#497); the
  cross-harness floor half has ZERO artifact (no conformance suite; "enforcement floor"
  greps only to the ticket's own source audit doc; capability matrix is ungated prose
  predating the ticket).
- A3 T-01M0122WMF8EJTB7ERHTEG8HMJ — EMPIRICALLY refuted: in a throwaway repo with rails frozen,
  ADLC_RAILS_BYPASS=1 + no key: create wrote the store, exit 0, ZERO manifest entries.
  evidenceRequired is only set on sensitive paths (transaction.mjs:180/:252,
  service.mjs); key-contract defines key:null as legal-unsigned, never refuses.
- A4 T-01M0122X45P80PY9Z8FG3XK3MV — no --base option in the gate-manifest CLI (grep 0), no new test;
  the near-hit (forest.mjs resolveAnchor) predates the ticket (PR #384) and passes on
  both trees ⇒ vacuous; prosecute packet embeds no anchor context.
- A5 T-01M0122Z30GW4GXEYW948FMYXF — premise CONFIRMED live: adlc-hook-run.mjs:102-104 has no guard;
  probe with argv[1]=/nonexistent/x.mjs → uncaught ENOENT from realpathSync, exit 1
  (fail-open past the #497 fix). Directory argv[1] imports cleanly; only the missing-path
  case throws.
- A6 T-01M0DF85FK1J0ZK3B46GK81YKV — 7/8 ACs shipped and mutation-proven (bwrap containment tests ran for
  real, 23/23); AC7(b) FAILS: apps/docs/content/docs/toolkit/quartermaster.mdx (in the
  commit) still carries the PRE-FIX callout asserting the model plane is "deliberately not
  filesystem-sandboxed" and the hole is open/tracked-in-#395 — three now-false published
  claims; PR #530 never touched it. (docs/tools/quartermaster.md exists only UNTRACKED in
  the working tree, judged absent at the commit.)
- B1 T-01M07VMFBMC28FNKZAMN32Q13Q — no decision recorded; its AC1 grep is SELF-SATISFYING (the ticket
  body contains the word "decision" — the command passed at authoring time); no signature
  verification anywhere in assertions.mjs; 2 "Open question" sections remain where the AC
  demands 0.
- B2 T-01M07VMV85W3SX2ZZHTR23DD0A — pi still emits rounds/questions = priorEntryCount (commands.mjs:351,
  :401-405, with an in-code comment documenting it as the deliberate current choice); same
  self-satisfying AC1; grep -c returns 2 where the AC wants exactly 1.
- B3 T-01M0122XKWCJ8N8W6EGDMFBJ9R — suppressions.mjs unchanged since BEFORE v1.10.0; behavioral probes on
  the pin itself: ticket-store shard with a literal marker → FLAGGED (AC wants inert);
  '# noqa' inside a .mjs string → FLAGGED (AC wants language-scoped); no per-marker
  language map exists (AC4 unimplementable as-is).

## Cross-report consistency claims to check
- Both verifiers used the same pin and never modified the primary working tree.
- v1.10.0 was used as negative control ONLY where the work post-dates the tag; I3 and B4-B6
  used earlier pre-ship SHAs instead — verify the control SHAs are actually pre-ship for
  their artifacts.
- No COMPLETE verdict rests on scope-file existence, ticket-prune inference, or a verify
  command that passes on both trees.


## Reproducibility appendix

Environment: Node v24.14.1, Linux; primary checkout at pin e6fb5df790ff6c9b845d13580757cce2e3263590; all probes in throwaway git worktrees (removed + pruned afterward). Node-24 note: `node --test <dir>` no longer accepts directories — all suite invocations used explicit `*.test.mjs` globs; AC texts written in directory form were executed in glob form over the identical files.

Ancestry (commands + outputs):
- `git rev-parse beafd956^` → 1bfafab2fecc6368d0ada4ddc007b5e308180527; `git merge-base --is-ancestor 1bfafab2 beafd956` → exit 0. (Negative control for T-01M05MH142…, T-01M05MJR1E…, T-01M05MJXYF….)
- `git merge-base --is-ancestor e8ab70f0 340b31c2` → exit 0. (Pre-ship control for I3; v1.10.0 rejected because 340b31c2 predates the tag.)

Key command lines + observed outputs (verbatim from the verifier reports; full per-AC tables including every mutation description are preserved in the two verifier reports, which accompany this artifact in the batch PR):
- `node --test 'packages/runner/test/*.test.mjs'` → exit 0, "tests 143 / pass 143 / fail 0" (pin). Same suite's p0-p1-gates.test.mjs transplanted to 1bfafab2 worktree → exit 1, "tests 41 / pass 5 / fail 36".
- `node --test packages/spec-lint/test/zero-criteria.test.mjs` → exit 0, "tests 4 / pass 4 / fail 0"; at v1.10.0: "Could not find" (file absent) → non-vacuous.
- `node --test scripts/test/run-tests-completeness.test.mjs` → exit 0, "tests 3 / pass 3 / fail 0"; absent at v1.10.0. Mutation: deleted the `['gemini', 'node --test plugins/adlc-gemini/test/*.test.mjs']` segment from scripts/run-tests.mjs → "pass 2 / fail 1" (the SEGMENT-coverage case red). Restored.
- `node --test 'packages/parallax/test/*.test.mjs'` → exit 0, "tests 96 / pass 96 / fail 0". Mutations (each restored after): drop `options` from renderQuestionsJson → 1 fail; `score <= threshold` → `<` → 1 fail; neuter the --questions-json/--prompt-only exclusivity guard → 1 fail.
- B4 mutations (each restored): remove 'spec-approval' from PHASE_REQUIREMENTS.p1 → 2 fail; remove the p0 key → 11 fail; `if (data.unresolved !== 0)` → `if (false)` → 1 fail.
- A3 empirical probe: throwaway repo, directory store bootstrapped with rails-declaring ticket; `ADLC_RAILS_BYPASS=1` env, ADLC_MANIFEST_KEY unset; `adlc ticket create --input t2.json --write` → exit 0, shard written, `find .adlc -name 'manifest*'` → nothing.
- A5 probe: `node --input-type=module -e "process.argv[1]='/nonexistent/virtual-entry.mjs'; await import('file://<pin>/plugins/adlc-claude-code/hooks/adlc-hook-run.mjs')"` → uncaught `Error: ENOENT ... lstat '/nonexistent'` at adlc-hook-run.mjs:103, exit 1.
- B3 behavioral probes ran the pin's own findSuppressions export against constructed fixtures (ticket-store shard containing `.skip(` → flagged; `# noqa` inside a .mjs string literal → flagged); required-inert behavior absent on the pin, so no negative control applies.

Mutation-patch hygiene: every plant was a single-line edit in a throwaway worktree, reverted by checkout of the pinned blob, with suite re-run green after restore (both verifiers report primary tree byte-identical at end: `git status --porcelain` unchanged vs session start).

## Appendix A/B: the two verifier reports, embedded verbatim

The complete per-AC evidence tables from both independent verifiers are attached below
unedited (they were previously referenced as external documents; embedded here so this
artifact is self-contained for audit).

### Appendix A — Verifier A report (verbatim)

GROUP-2 VERIFICATION A — 7 tickets, verified on clean checkouts of e6fb5df790ff6c9b845d13580757cce2e3263590. Primary working tree untouched; all worktrees removed, git worktree prune run. RESULT: 2 COMPLETE (A2, A7/I3 — I3 since revised down by the accuracy review) — 5 STAYS-OPEN (A1, A3, A4, A5, A6). PIN NOTE: untracked docs/tools/*.md in the working tree are NOT in the commit; every presence/absence call used git cat-file against the commit.

A1 T-01KZRQF3RWQBHSXN3K7VR3B25W — STAYS-OPEN. AC1 (CC wrapper enforcing timeout→exit 2): plugins/adlc-claude-code/hooks/adlc-hook-run.mjs:26-28 + hooks/test/wrapper-timeout-deny.test.mjs; node --test → exit 0, tests 14/14; v1.10.0: file absent (control fails). Mutation: `ENFORCING_MODES.has(mode) ? 2 : 0` → `? 1 : 0` reddens 4 tests incl. "never exits 1 for an enforcing mode". SHIPPED (#497/29ced23a). AC2 (conformance test: each integration meets the floor): NONE — integration-parity-floor.test.mjs does not exist; git grep -i "enforcement floor" hits exactly one file (delta.md, the ticket's own source); near-miss toolkit-floor.test.mjs ruled out (version floor, different ticket). UNMAPPED. AC3 (existing wrapper + live-deny tests pass): 242/242. Matrix-as-gate item: docs/integrations/harness-capability-matrix.md exists, ungated prose predating the ticket (PR #290); no code references it.

A2 T-01KZRQF41GMGMTXG8MFVN8FJW8 — COMPLETE. AC1: packages/spec-lint/test/zero-criteria.test.mjs, 4/4 incl. "exits 2 when criteria sit under an unrecognized heading"; absent at v1.10.0. AC2: scripts/test/run-tests-completeness.test.mjs 3/3; absent at v1.10.0; mutation (deleting the gemini segment from scripts/run-tests.mjs) reddens "every plugin test dir on disk is run by some SEGMENT"; test carries its own load-bearing self-case. Both halves shipped in 5d6daa60 (PR #494) — briefed premise corrected.

A3 T-01M0122WMF8EJTB7ERHTEG8HMJ — STAYS-OPEN. Static: `ticket-mutation`, `storeHashBefore/After` → zero hits repo-wide; --allow-unsigned exists only in packages/prosecute. Code: transaction.mjs:180/:252 record only if evidenceRequired; service.mjs sets it only on sensitive paths; key-contract.mjs defines key:null as legal-unsigned. EMPIRICAL: throwaway repo, rails-declaring ticket in store, ADLC_RAILS_BYPASS=1, no key: `adlc ticket create --write` → exit 0, store MUTATED, ZERO manifest entries (no manifest.jsonl, no manifest.d/). AC1 fails (no entry), AC2 fails (no keyless refusal), AC3 vacuous, AC4 fails.

A4 T-01M0122X45P80PY9Z8FG3XK3MV — STAYS-OPEN. gate-manifest CLI options enumerated: no `base` option (grep -c '^\s*base:' → 0); no new test in packages/gate-manifest/test/. AC2 near-hit forest.mjs:186 resolveAnchor emits "anchor lineHash mismatch" but landed in fcf750f9/PR #384, predating the ticket — passes both trees, vacuous. AC3: git grep -i anchor over packages/prosecute → only unrelated senses; no anchor context in the review packet. Doc item: only "chain broken" string in tracked docs is an unrelated prosecute README line.

A5 T-01M0122Z30GW4GXEYW948FMYXF — STAYS-OPEN, premise CONFIRMED. adlc-hook-run.mjs:102-104 unguarded: `realpathSync(process.argv[1])` with argv[1]=/nonexistent/virtual-entry.mjs → uncaught ENOENT at :103, exit 1 (probe command in the reproducibility appendix). Directory argv[1] (/tmp) imports cleanly, exit 0. AC1 (exit 2 + deny message) FAILS; no covering test exists. The fail-open path bypasses the #497 dispatch/timeout handling entirely.

A6 T-01M0DF85FK1J0ZK3B46GK81YKV — STAYS-OPEN, 7/8 shipped. bwrap present; containment tests ran for real: model-plane-sandbox.test.mjs 23 pass 0 skip. AC1/AC2 mutation `--ro-bind / /`→`--bind / /` reddens both; real wiring locked by live-deps.test.mjs:86 (wrapper.cmd === 'bwrap'). AC3 substance passes (MODEL_PLANE_AMBIENT_ADLC_VARS = empty Set; withheld by construction) though the AC cites the wrong test file (env-scrub.test.mjs stays green on the registry-passthrough mutation; model-plane-sandbox.test.mjs reddens ×2) — ticket-text defect. AC4: bwrap no --unshare-net, Seatbelt allow network*, repo-plane regression asserts deny. AC5: refused===true, mode null, override ENV_SCRUB_ONLY, repo-committed config cannot enable. AC6/AC8 spec §7.3/§13 verbatim-verified. AC7(b) FAILS: apps/docs/content/docs/toolkit/quartermaster.mdx (in the commit; #530 never touched it) still asserts the worker "is deliberately not filesystem-sandboxed", candidate code "could rewrite the registry itself", closing "tracked in [#395]" — three now-false published claims. docs/tools/quartermaster.md exists only untracked.

A7/I3 — original verdict COMPLETE (revised by the accuracy review to STAYS-OPEN pending guard hardening). Shipped 340b31c2 (PR #351). install-cta.test.mjs 7/7 on pin, CI-wired (run-tests.mjs:152). Per-AC source positions verified independently (hero L231 < card L256 < surfaces L261; index L30 < L81; homepage L137 < L178); single-source literal: exactly one hit, apps/docs/lib/install-commands.mjs:15; mutations for 3.2/3.3/3.4/3.5/3.6 all red. Control at pre-ship e8ab70f0 (test ported): 5/7 fail. CAVEAT that drove the revision: AC3.1's guard asserts only heroInstall < surfaces (never > hero-open); two AC-violating mutations left all 7 green. Also: install-commands.mjs:12 points at a wrong guard path; content/ dir excluded from the single-source walk (copilot.mdx hand-types the literal, outside AC scope).

### Appendix B — Verifier B report (verbatim)

GROUP-2 VERIFICATION B — pin e6fb5df7; primary checkout unmodified; own worktrees removed. VERDICTS: B1 STAYS-OPEN, B2 STAYS-OPEN, B3 STAYS-OPEN, B4 COMPLETE, B5 COMPLETE, B6 COMPLETE. Shared: the interrogation arc shipped in ONE commit beafd956 (PR #518); parent 1bfafab2 is the negative control; that commit AUTHORED the B1/B2 shards as its own follow-ups; f1d9c151 (#510) authored B3's. `npm test` on pin: 54/54 segments. Node-24 note: directory args to node --test rejected; glob form used. Cursor commands/ finding: a COMMITTED SYMLINK commands -> command (one blob; git check-ignore exits 1; byte-identical targets) — scope strings accurate as written, not a typo.

B4 T-01M05MH142KEXEY28KM4SRSDC8 [id verbatim from store: T-01M05MH142KEXEY28HM4SRSDC8] — COMPLETE, 6/6. AC1 p1 requires spec-approval: assertions.mjs:13 + two named tests; suite 143/143; NC: pin's p0-p1-gates.test.mjs in the 1bfafab2 worktree → 36/41 fail. M1 drop 'spec-approval' → 2 red. AC2 p0 coldstart: assertions.mjs:12 + 12 p0 cases; M2 remove p0 key → 11 red. AC3 unresolved>0 rejected: assertions.mjs:434-435; M3 `if(false)` → 1 red. AC4 grep both harnesses' adlc-approve-spec.md for 'unresolved' → exit 0 both (fresh worktree); exit 1 at NC. AC5 CC commands file exists (63 lines in beafd956); absent at NC. AC6 npm test → 54/54. Refutations failed: copilot+gemini SKILL.md already emit the full new payload (no legacy emitter left); no version carve-out in the validator; "rejects a legacy spec-approval" test passes.

B5 T-01M05MJR1E645A1Q26Z8VSDF7X — COMPLETE, 5/5. AC1 grep AskUserQuestion in CC adlc-ticket.md → 2 (§1b line 57 + §4 line 191); 0 at NC. AC2 grep record-verdict → exit 0 (§4 step 3 line 207); exit 1 at NC. AC3 grep -l interrogation-protocol matches all four peers (copilot SKILL, cursor command, opencode command, codex skill); none at NC. AC4 loop-until-zero-gaps THEN record: verbatim quotes captured (loop cap, --record-verdict, --expect CAS handling). AC5 npm test 54/54. Non-blocking: build step names "the pi ticket flow"; pi has no ticket prompt (adjudicated non-normative; parity owned by #241).

B6 T-01M05MJXYFRB8BKY5ZWFQDPG05 — COMPLETE, 5/5. AC1 adlc-spec.md exists + greps parallax (both exit 0; file absent at NC). AC2 AskUserQuestion ×2. AC3 questions-json.test.mjs 6 cases (point/options[], A/B/C labels, both mutual-exclusion exits); parallax suite 96/96; grep questions-json in bin exits 1 at NC. M4 drop options → 1 red; M5 <=→< → 1 red; M6 neuter exclusivity guard → 1 red. AC4 3-round cap + approved-assumptions escape hatch verbatim in adlc-spec.md:67-72 AND docs/interrogation-protocol.md:101-109; cursor:53-55 + opencode:50-52 carry the same wording. AC5 npm test 54/54.

B1 T-01M07VMFBMC28FNKZAMN32Q13Q — STAYS-OPEN. AC1's grep is SELF-SATISFYING (3 matches, all the ticket's own pre-existing prose; shard has exactly one commit — beafd956 — body never updated; the only spec referencing the id is not new and defers the decision verbatim). AC2: zero signature verification in assertions.mjs (grep for verifyEntrySig|verifySignature|requireSignatures|sig|hmac → exit 1); approver check is nonempty-string only. AC3: 2 "Open question" sections remain (AC demands 0). AC4: nothing documented. Pro-completion refutation failed: crediting the self-satisfying grep would complete the ticket at birth.

B2 T-01M07VMV85W3SX2ZZHTR23DD0A — STAYS-OPEN. pi still emits rounds/questions = priorEntryCount (commands.mjs:351, :401-405; in-code comment documents it as the deliberate current choice); no test asserts N-structured-questions→questions:N; no refusal path; grep -c 'Open question' → 2 where AC wants exactly 1; same self-satisfying AC1 pattern.

B3 T-01M0122XKWCJ8N8W6EGDMFBJ9R — STAYS-OPEN, nothing shipped. suppressions.mjs unchanged since 0ff2cc0d (#432), an ancestor of v1.10.0; the three in-window rails-guard commits touch unrelated surfaces; zero credit given to neighbor work. Behavioral probes on the pin's own findSuppressions: ticket-store shard line with `.skip(` → FLAGGED (AC1 wants inert); archive shard `# noqa` → FLAGGED (AC1b); `# noqa` in a .mjs string → FLAGGED (AC2a wants language-scoped); AC2b/AC3 pass only vacuously (scan is language-blind / pre-existing); AC4 has NO mechanism (SUPPRESSION_MARKERS is a flat string array, no per-marker language map). findSuppressions docstring confirms only .md/.markdown/.mdx-fence/inline-code skips; ticket-store paths appear nowhere; no covering test among the 17 rails-guard test files.

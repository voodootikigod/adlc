---
description: Distill repeated review findings and PR rejections into permanent, deterministic defenses (ADLC P7).
argument-hint: (no arguments)
---

# /adlc-distill — compound the lifecycle (P7)

P7 is where the lifecycle compounds: repeated findings become deterministic
defenses (lint checks, skills, spec-gap templates) so the same mistake cannot
recur. This is idle-time work — run it after a batch of reviews, or on a schedule
(see "Scheduling" below).

Both gates here are LLM-backed, and inside Claude Code **you are the model** —
use `--prompt-only`, answer the printed prompt yourself, and apply the result.
No API keys. Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`).

## 1. Lesson foundry — mine repeated findings (C9)

```
adlc lesson-foundry --prompt-only
```

- If it prints `(no clusters to refine)`, there are not yet enough repeated
  findings in `.adlc/findings.jsonl` to distill — report that and stop here.
- Otherwise it prints one prompt per cluster of repeated findings. For each,
  **answer the prompt yourself**: decide the cheapest *deterministic* defense that
  would have caught the whole cluster — a lint rule, a skill, or a spec-gap
  template — preferring a machine-checkable gate over a prose reminder.
- Present the proposed defenses. After the user approves, materialize them:
  1. Run `adlc lesson-foundry --write --out-dir .adlc/lessons` (the writer is
     dry-run by default, so nothing is created without `--write`). This scaffolds
     one defense file per cluster from the finding data, with **default wording**.
  2. **Then edit the scaffolded files** to match the defenses you decided above.
     `--write` on its own does NOT apply your prompt-only refinement — that is
     only auto-applied with `--llm` (which needs an API key). So in the keyless
     in-Claude flow you scaffold with `--write`, then refine the wording yourself.
  3. **For any defense that is a *skill* (a `SKILL.md`), validate it before PR.**
     lesson-foundry only scaffolds the stub; it does not dedup against the public
     ecosystem or confirm the skill is usable cold. Hand the scaffolded `SKILL.md`
     to **skill-mining** for the registry-management half of P7 (see ADLC.md §P7):

     ```
     npx skills add voodootikigod/skill-mining   # once per machine
     ```
     Then hand it the scaffolded stub with a **scoped** request — point it at the
     specific staged file rather than asking for a full-repo mine, e.g.:

     > "Validate the scaffolded skill at `.adlc/lessons/<name>.SKILL.md`: dedup it
     > against installed skills and the skills.sh registry, then run Gate B on it.
     > Report REUSE/EXTEND/BUILD/REJECT and SHIP/FIX/REJECT — do not mine the rest
     > of the repo."

     (lesson-foundry writes a **flat** file, `.adlc/lessons/<name>.SKILL.md` — not
     a `<name>/SKILL.md` directory. The skills CLI expects a skill *directory*
     containing a `SKILL.md`, so to install it you first move the flat file into
     its own subdir: `<name>/SKILL.md`.)

     Validation reads the **file content** — Gate B hands a fresh agent the
     `SKILL.md` text directly, so it works on the flat staged file and does **not**
     require the skill to be installed/discoverable first. Lifecycle, in order:

     1. **Validate the staged flat file** (`.adlc/lessons/<name>.SKILL.md`):
        - **dedup** against installed skills + the `skills.sh` registry (via its
          `find-skills` subagent) → REUSE / EXTEND / BUILD / REJECT. If a maintained
          public skill already covers it, install that and drop the stub.
        - **Gate B** (artifact red-team): a fresh-context agent gets only the
          `SKILL.md` and attempts a real repo task → SHIP / FIX / REJECT, proving
          the skill carries specific commands/paths/invariants, not generic prose.
     2. **Only for a SHIP verdict, install it** so it becomes live. `.adlc/lessons/`
        is a staging area, **not** on the skill-discovery path — a `SKILL.md` left
        there is inert. The skills CLI expects a skill *directory*, so move the flat
        file into `<name>/SKILL.md`, then let **skill-mining's author step** (or the
        skills CLI) place it in the correct location for the active harness. Don't
        hand-guess the path or the exact subcommand — run `npx skills --help` for
        the install verb your CLI version uses; skill-mining's author step does this
        for you.
     3. **Verify by outcome, then PR** — the skill is installed correctly only when
        the **agent can actually discover it** (it shows up in the harness's
        available-skills list / can be invoked). Confirm that, not a specific CLI
        string. Then PR only the installed, SHIP-verdict skill, and remove the
        leftover flat `.adlc/lessons/<name>.SKILL.md` staging copy so it isn't
        committed twice.

     (skill-mining today is repo-wide by design; a single-stub scoped mode is a
     desired enhancement — until then, constrain it via the prompt above.)

     Lint-rule and spec-gap defenses do not go through skill-mining — PR them
     directly from `.adlc/lessons/`.

     This step is **keyless** (skill-mining is agentic — Claude is the agent, no
     API key), but it is **not** a deterministic gate: no `--prompt-only`/exit-code
     contract, and `npx skills add` is an interactive, once-per-machine developer
     action — never run it from a scheduled/headless `/adlc-distill` (see
     "Scheduling"). If skill-mining is unavailable, **do not PR the skill stubs** —
     hold them for explicit human review rather than landing default-worded,
     un-deduped, cold-untested skills. Report them as held-unvalidated in the
     summary so the coverage stays honest.

## 2. Rejection mining — mine human PR objections (C13)

```
adlc rejection-mining --prompt-only
```

- This reads recent PR review rejections via the `gh` CLI. If it errors with a
  `gh`/auth/repo message, the repo is not GitHub-linked or `gh` is not
  authenticated — note that this gate was skipped and why, then continue.
- Otherwise answer the printed prompt(s): turn each repeated human objection into
  a reusable **review lens** (a question a future prosecutor should ask). Present
  the lenses; materialize with `--write` only after approval.

## 3. Summarize

Report: how many finding clusters and rejection lenses were found, the concrete
defenses proposed, which were written (if any), and which gates were skipped
(e.g. rejection-mining when `gh` is unavailable) so the coverage is honest. For
any *skill* defense, report its skill-mining verdict (REUSE/EXTEND/BUILD/REJECT +
Gate B SHIP/FIX/REJECT), or flag it as **held for human review (not PR'd)** if
skill-mining was not run. Point the user at `/adlc-maintain` for the decay-driven
checks.

## Scheduling

This command is idle-time metabolism. To run it automatically, schedule a Claude
routine (e.g. via `/schedule`) that invokes `/adlc-distill` on a cadence — Claude
is the model, so no API keys are needed.

**Headless runs are advisory by default.** The write steps above require human
approval, so an unattended scheduled run will *propose* defenses (in its summary)
without materializing them — that is intentional: auto-writing lint rules/skills
from clustered findings unattended is risky. A scheduled routine should surface
the proposals for a human to review and then approve `--write`. Only wire an
auto-`--write` routine if you have explicitly accepted that the generated
defenses land without review. The skill-mining handoff (step 1.3) is likewise
**interactive only** — a headless run must never `npx skills add` or auto-validate
skills; it surfaces the scaffolded stubs for a human to validate later. The
deterministic maintenance checks (`/adlc-maintain`) can additionally run in CI on
a cron; see `docs/ci/adlc-maintenance.yml`.

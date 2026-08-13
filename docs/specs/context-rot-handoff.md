# Spec — Proactive context-rot handoff (ADLC F3)

Status: draft (multi-round adversarial review).
Scope: design contract for `@adlc/context-handoff` + harness adapters.

## Problem

Absolute context pressure → handoff checkpoint before hard → **session-terminal
deny for denier** → other sessions only after **signed** consume.

## Constraints

Doctrine F3/E4/P2/P4; absolute build-gate hard; host compactors non-goal.

## Package

Signal owner `@adlc/context-handoff`; build-gate consumes absolute
`isHardDegraded()`. Thresholds only via `lib/thresholds.mjs` (adapters MUST import; literal-ban CI is a later slice). Band edges are inclusive (`>=`); build-gate today uses strict `>` for depth/bytes — slice-3 migration must adopt inclusive or document a flip.

### Absolute bands & multi-signal join

Thresholds: warn < handoff < hard. Defaults PCT 50/60/80; depth 20/30/40;
bytes 128/192/256 KiB (proxies provisional); cooldown 15; min remaining-to-hard
0.25 (**nags only**); max-age 72h applies to **model-field injection staleness**
only (`written_at`). Deny/open-handoff-deny **do not silently expire**.

**Join (normative):** for each band, fire if **any** available signal is past
its threshold (OR / worst-band). Missing signal kinds are ignored, not zero. Total signal absence (every kind absent) is treated the same as a healthy low-pressure session in slice-1 — fail-open by design so a dead telemetry source does not hard-lock the repo; adapters SHOULD surface a health warning when no signals are present.

## Tiers

Enforcing: Pi, OpenCode, CC, Codex. Advisory: Cursor, Antigravity. Manual: Copilot.

## Normative mutation gate (enforcing)

```
band(signal) uses OR-join across available signals

if absolute_hard: apply build-gate

if absolute_handoff:
  ensure_deny_marker(current_session_id)  # retry every eval; fail closed

Deny record `status`: `open` | `consumed`.

DENY entire deny-set if:
  (D1) process_sticky_deny
  (D2) valid deny record with session_id == current_session_id
       (any status — denier sticky for process/session lifetime)
  (D3) exists any valid deny record R with status==open for which
       NOT authorized(caller, R)
```

`authorized(caller, R)` is **per open deny record** (every `open` R must be
authorized; `consumed` R do not participate in D3):

- If `R.ticket_id` is null (pre-bind): **never** via resume-auth — only TTY
  bypass `--unbound-reason=operator-override` or **privileged host bind**
  (§Host repair) that sets ticket_id + non-null content_hash.
- If `R.content_hash` is null: resume-auth never suffices; unbound bypass or
  host repair only.
- If both non-null: signed resume-auth for that ticket_id with attested hash
  **equals** `R.content_hash`, or valid bypass for `current_session_id`.
- Unverifiable/missing manifest ⇒ not authorized.

**Deny-set** (while D1|D2|D3): structured edits; ticket/manifest tools; agent
commits; **Shell/Bash fail-closed-all** on enforcing tiers (no classifier
fork in v1 — simpler, testable); agent Shell to `adlc handoff *` mutating
subcommands. Unticketed mutators included. Advisory tiers stay disclosure-only.

### ensure_deny_marker / deny files

Write `.adlc/handoffs/denies/<session_id>.json` with matching
`session_id == filename`. Invalid JSON, schema fail, or session_id mismatch ⇒
treat as DENY for **current** session if filename == current_session_id;
**unrelated** junk filenames: quarantine to `denies/quarantine/` on sight and
ignore for D2 (still logged). Re-entry without readable self-marker: retry
write + DENY until valid.

Slice-1 durability for "deny store was initialized" is the filesystem sentinel
`.adlc/.deny-store` (sibling of `handoffs/`, JSON `{schema,sessions}` written
only after a marker is verified on disk; `sessions` lists denied session ids so
selective marker delete cannot clear D2) plus the marker files under `denies/`. A signed per-deny
manifest ledger is a later slice — until then, deleting `handoffs/` while the
sentinel remains must surface store-unavailable (D0), and per-session
marker-vanished sticky is caller-threaded (`denyEverWritten`), not the global
sentinel. Absence of the sentinel must not be treated as proof of a clean store
on any tier once adapters exist; hooks must protect the path.

Null `ticket_id` at handoff: durable `open` deny persists across absolute
cooling. Binding/ticket select uses §Host repair only (not agent Write).

### Host repair (privileged, outside agent tools)

`adlc handoff repair --ticket <id> --write` (human TTY or host PreCompact/hook
only — never via agent Shell under deny):

- May update deny record fields `ticket_id` + `content_hash` (from a successful
  final checkpoint) while leave `status=open`.
- May create/refresh final handoff file via the same privileged writer path as
  hooks.
- Manifest-records `context-handoff-repair`. Agent Write/Shell cannot invoke.

### Authorization / resume-auth / consume

- Denier session: always D2 (open or consumed self-record); consume never
  clears D2 for denier.
- Same-session consume ⇒ exit 2.
- Other-session consume (TTY/CLI with new session_id): requires final with
  non-null hash; signs `context-handoff-resume`; sets that deny record
  `status=consumed` (D3 drops for that R only); writes resume-auth cache.
- Other sessions mutating: must satisfy `authorized` for **every open** deny.
  File cache ignored unless signature verifies; verify error ⇒ DENY.
- Wrong-hash / stale resume-auth ⇒ DENY.
- Hooks deny agent Write to denies/*, `.adlc/.deny-store`, *.resume-auth.json, *.model-ok, *.lock, content/**.

### Bypass / unlock / PreCompact / missing-final

TTY+key bypass one-shot (can authorize denier briefly); unlock TTY; PreCompact
≤1 model capture, final, deny stays; missing-final → host repair / unbound
bypass. Unbound operator override (`{ unboundReason }`) may clear
`D0:deny_store_unavailable` and `D3:invalid_record` (host repair / unlock);
legacy bound-only `true` bypass does not. Host repair may also remove a stale
`.adlc/.deny-store` when restoring a never-initialized tree.

### Locks

`{pid,started_at,host,nonce}`; reclaim only dead PID + same host + full match;
else unlock command.

### Inject / model / Proven

Active ticket: CLI → pointer → env-if-equal. Model: signed model-attest only.
Proven: harness-attested tool_calls; dead_end_influenced evidence-only.

## Continuation (2026-08 amendment — host-orchestrated successor)

The sanctioned recovery for a handoff deny is a **host-orchestrated successor
spawn** (this supersedes the former successor-spawn non-goal). The denier is
never un-denied (D2 sticky); continuation replaces the session, never revives
it.

### Capture

Content artifact `.adlc/handoffs/content/<session_id>.md`, written ONLY by
host-privileged code (CLI / supervisor / hook-host) — never agent tools. The
protected-path set (package adapter + every harness copy) covers
`.adlc/handoffs/content/**`. Content = deterministic brief (active ticket
id+title, gate-manifest evidence tail, git branch + status summary, flail
signals when present) + optional model narrative extracted host-side from the
harness transcript (trailing assistant message). With a capture present, final
`content_hash` = sha256 over the canonicalized capture body; absent a capture,
the metadata hash (§final) stands. The 72h `written_at` staleness rule applies
to model-narrative injection.

### Continue

`adlc handoff continue --deny-session <old> [--session <new>]
[--capture-from <transcript>] [--write] [--json]` composes capture → `write`
(final + bind; ticket: CLI → pointer → env-if-equal) → `resume` for the
successor id → bootstrap payload on stdout:
`{ successor_session_id, ticket_id, content_path, content_hash,
bootstrap_prompt }`. Mutating posture identical to write/resume: `--write` +
`ADLC_MANIFEST_KEY`, denier lock held, evidence gate
`context-handoff-continue`, rollback of this run's file mutations when the
evidence append fails. Degrade (exit 2, nothing consumed): unbound deny;
missing/corrupt `--capture-from` source; consumed deny. The successor id comes
from `--session` or is minted by the command — never derived from agent input.
`continue` joins write|resume|bypass|repair|unlock in
HANDOFF_MUTATING_SUBCOMMANDS (package adapter + every harness copy).

### Supervised-only auto-consume

Only the continuation machinery's own minted/known successor id is consumed
for. Arbitrary fresh sessions never auto-consume. Hooks never consume
(keyless). This is the v1 policy; no config relaxes it in this program.

## Slice-1 contract tests

1. Absolute OR-join bands; no floor-delta comparator.
2. Floor ∈ [handoff, hard) ⇒ deny.
3. Denier denied after consume; same-session consume exit 2.
4. Fresh session cannot mutate under open deny pre-consume (incl. file edits).
5. Other-session needs signed resume-auth with matching content_hash; forged/wrong-hash insufficient; verify fail ⇒ deny.
6. Null-ticket deny persists after absolute < handoff; pre-bind resume-auth never authorizes; bind only via host repair.
7. Null-hash auth only via unbound bypass / host repair; multi-open-deny needs auth for every open record.
8. After other-session consume: that R is consumed (D3 clear for it); denier still D2; third session OK only if no other open denies.
9. deny write-fail + re-entry ⇒ deny; corrupt self-marker ⇒ deny; junk quarantined.
10. Checkpoint failure ≠ no-deny.

> **Slice-1 package coverage:** items 1–9 are enforced by `@adlc/context-handoff` pure helpers + tests. Items 10–16 require harness adapters / host hooks (slices 4–6) and are listed here as the frozen contract those slices must meet; they are not implemented in this package.

11. Shell fail-closed-all under deny (incl. attempts to create deny/handoff files).
12. Agent cannot invoke repair/write/bypass via Shell under deny.
13. model-attest required.
14. unlock live PID / nonce mismatch.
15. proven-check rejects cli-observed.
16. Missing-final + host-repair fixtures.
17. Multi-signal OR-join fixtures.
18. continue happy path consumes exactly the minted successor and emits the payload.
19. continue on unbound deny exits 2 and consumes nothing.
20. continue rolls back on evidence-append failure: deny stays open, no resume-auth survives.
21. Agent Write to `.adlc/handoffs/content/**` denied on enforcing tiers.
22. Content-hash binding: tampered capture content fails resume verification.
23. Agent Shell invoking `handoff continue` denied under deny-set.
24. Supervisor env-scrub: spawned successor drops CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT.

> **Continuation coverage:** items 18–23 are package-level (`@adlc/context-handoff` helpers + CLI tests); item 24 is harness-adapter level (supervisor slice).

## Slices

1 Freeze+tests → 2 package → 3 build-gate → 4–6 harnesses → 7 Proven changes.

## Acceptance Criteria

Slice-1 freeze (this ticket's deliverable). Later slices are out of scope here.

- Binding design lives at `docs/specs/context-rot-handoff.md` and is copied to `.adlc/specs/context-rot-handoff.md`. verify: `test -f docs/specs/context-rot-handoff.md && test -f .adlc/specs/context-rot-handoff.md`
- `@adlc/context-handoff` package exists with `lib/thresholds.mjs` exporting warn < handoff < hard constants (no adapter literals). verify: `node --test packages/context-handoff/test/thresholds.test.mjs`
- Pure gate helpers encode D1–D3 + per-record `authorized` (hash match; null-ticket/null-hash never via resume-auth). verify: `node --test packages/context-handoff/test/mutation-gate.test.mjs`
- Absolute OR-join across pct/depth/bytes; floor-delta is not used for band compare. verify: `node --test packages/context-handoff/test/bands.test.mjs`
- Headroom/cooldown never suppress deny; floor ∈ [handoff, hard) still denies. verify: `node --test packages/context-handoff/test/bands.test.mjs`
- Denier sticky after consume; same-session consume rejected; consumed clears D3 only for that record. verify: `node --test packages/context-handoff/test/deny-lifecycle.test.mjs`
- ensure_deny_marker fail-closed (write-fail / corrupt / re-entry). verify: `node --test packages/context-handoff/test/deny-marker.test.mjs`
- `adlc spec-lint docs/specs/context-rot-handoff.md` exits 0 (no wishes). verify: `adlc spec-lint docs/specs/context-rot-handoff.md`

## Non-goals

Host compactors; replacing tickets; runtime-binding dead_ends;
committing handoffs; env/label controls; denier unlock via consume;
harness adapter wiring (slices 4–6); build-gate migration (slice 3);
unsupervised auto-consume (v1); warn-band model checkpoint (v1);
in-place context wipe of a denied session (successor session only).

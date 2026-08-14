# @adlc/context-handoff

**ADLC phase: P4 continuity (F3)** — absolute context bands, session-terminal
mutation deny (D1–D3), and the operator CLI for
write/resume/bypass/repair/unlock/continue. Binding design:
[`docs/specs/context-rot-handoff.md`](../../docs/specs/context-rot-handoff.md).

```sh
adlc handoff write --session <id> [--ticket <id>] [--write] [--json]
adlc handoff resume --session <consumer> --deny-session <denier> [--write]
adlc handoff bypass --session <id> [--unbound-reason <text>] [--write]
adlc handoff repair --session <id> --ticket <id> --content-hash <h> [--write]
adlc handoff unlock --session <id> --pid <n> --started-at <iso> --host <h> --nonce <n> [--write]
adlc handoff continue --deny-session <denier> [--session <new>] [--capture-from <transcript>] [--write]
```

Mutating `--write` requires `ADLC_MANIFEST_KEY` (never silent success).

`--dir` names the ledger directory and its final path segment must be `.adlc`:
artifacts and manifest evidence share that tree, and any other name is refused
rather than splitting them. `repair` binds a deny that already exists and is
still open — it never creates one. `unlock` reclaims only a lock minted on this
host, so a dead-looking PID from another machine cannot evict a live session.
A `bypass` grant on stdout is scoped to the calling adapter invocation; the
durable proof is the `context-handoff-bypass` manifest entry; an explicitly
empty `--unbound-reason` is refused rather than degraded to a bound grant.

`write`, `resume`, and `repair` all read-modify-write a deny marker, so each
holds that session's `.adlc/handoffs/<id>.lock` (O_EXCL, released on exit) and
exits 2 when a live session on this host holds it. `write` rebinds the marker
onto the final it writes — `ensureDenyMarker` is idempotent, so without that a
refreshed hash would wedge every later resume — and refuses to unbind or to
refresh a consumed deny. When the manifest append fails, the run's file
mutations are rolled back so no bind survives that nothing attests.

## Continuation

`continue` is the sanctioned recovery from a handoff deny: it captures the
denied session, binds the final to that capture, and consumes the deny for ONE
successor. The denier is never un-denied — D2 stays sticky and the work moves to
a new session. It composes capture → write → resume in a single run under the
denier's lock, records `context-handoff-continue`, and rolls back every file it
touched when that evidence append fails.

The capture body lives at `.adlc/handoffs/content/<session_id>.md` and is
written only by host-privileged code; `isProtectedHandoffPath` denies agent
writes to `.adlc/handoffs/content/**`, and `continue` joins the mutating
subcommands an agent's shell must not run under deny. `content_hash` is sha256
over the canonicalized capture body (LF line endings, no trailing whitespace),
so re-deriving it from disk catches an edited capture that a valid signature
cannot.

Degrades with exit 2 and nothing consumed: an unbound deny (bind it with
`repair` first), a consumed deny, a missing or corrupt `--capture-from` source,
a successor id that already holds a resume-auth, or an active ticket that
disagrees with the deny's bind. The successor id comes from `--session` or is
minted by the command — never from agent input.

**Reading a capture back.** Use `readVerifiedCapture(root, sessionId, expectedHash)`.
It returns the body only when the bytes on disk still hash to the value the
deny record and resume-auth are bound to; missing, oversize, and altered all
fail closed with no body. Supervisors and session-start injectors must go
through it rather than reading the file — a signature proves the hash was
authorized, never that the file still matches it.

```js
import { readVerifiedCapture } from '@adlc/context-handoff/lib/capture.mjs';

const got = readVerifiedCapture(root, denySessionId, denyRecord.content_hash);
if (!got.ok) return; // absent, oversize, or edited — inject nothing
```

**Capture content is fenced.** Everything the brief carries is attacker-reachable
— a branch name, a filename in `git status`, a ticket title, the previous
session's own words — so each section is wrapped in `<<<UNTRUSTED-CAPTURE-DATA`
/ `END-UNTRUSTED>>>` markers, with those delimiters stripped from the content so
the fence cannot be closed from inside. `bootstrap_prompt` repeats, before and
after the body, that fenced content is recorded data rather than instructions.

```js
import { WARN_PCT, HANDOFF_PCT, HARD_PCT } from '@adlc/context-handoff/lib/thresholds.mjs';
import { evaluateBands } from '@adlc/context-handoff/lib/bands.mjs';
import { evaluateMutationGate } from '@adlc/context-handoff/lib/mutation-gate.mjs';
```

```sh
node --test packages/context-handoff/test/*.test.mjs
```

## Deny-store expectation

`loadDenyRecords` treats a missing `denies/` as unavailable only when
`.adlc/.deny-store` exists (JSON `{schema,sessions}` written by `ensureDenyMarker`
after a verified marker; sessions[] makes selective marker delete fail closed). The sentinel is a sibling of `handoffs/` so deleting `handoffs/` alone
cannot clear expectation; full signed per-deny ledger is still deferred.
Ticket-store presence alone does not expect denies. A legacy
`.adlc/handoffs/.deny-store` is treated as expected and self-healed to the new
path. `evaluateMarkerOnReentry` does **not** use the global sentinel for
per-session `marker_vanished` — callers thread `denyEverWritten`. Unbound operator bypass may clear `D0:deny_store_unavailable` and
`D3:invalid_record`.

Advisory nags (`nagSuppression`) are suppressed when remaining-to-hard is below
`MIN_REMAINING_TO_HARD` (near-hard / handoff zone) so deny/handoff owns the
signal; this never affects mutation deny.

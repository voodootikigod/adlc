# adlc-antigravity

Embrace the ADLC inside Google Antigravity (`agy`): a phase-router plus doctrine
skills and a `PreToolUse` rails-guard that freezes ADLC rails. Requires the
`@adlc/cli` gate toolkit (`npm i -g @adlc/cli`).

## Install

**One-liner via npx (recommended):**

```sh
(cd "$(mktemp -d)" && npx @adlc/antigravity@latest install)
```

**Global npm install:**

```sh
npm install -g @adlc/antigravity
adlc-agy install
```

**Local project install:**

```sh
npm install @adlc/antigravity
./node_modules/.bin/adlc-agy install
```

**From local checkout:**

```sh
node /abs/path/to/adlc/plugins/adlc-antigravity/bin/cli.mjs install
```

Never hand `agy` a plugin directory yourself. `agy` resolves its target as
`plugin@marketplace` before deciding whether it is a filesystem path, so the `@`
in `.../@adlc/antigravity` is read as that separator and the install fails with
`unknown marketplace: adlc/antigravity`. A source checkout is not reliably safe
either — an `@` in any parent directory (a clone under `/home/user@example.com/…`)
reproduces it. The helper stages the plugin under an `@`-free path and installs
from there.

The `@latest` above is load-bearing too: `npx @adlc/antigravity` resolves a bare
name against the current project first, so a repo shipping a workspace or
dependency named `@adlc/antigravity` would have its binary run instead. A version
spec forces registry resolution — it pins nothing, it only refuses local
shadowing.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADLC_AGY_TIMEOUT_MS` | `120000` | Wall-clock bound on each `agy` subprocess, in **milliseconds**. Must be a positive, finite number — anything else (including `0` and `Infinity`, both of which would disable the bound) is refused rather than silently ignored. Raise it if `agy` is legitimately slow: a cold cache or network-mounted storage can exceed 120s. |
| `ADLC_P4_ENFORCEMENT` | unset | Set to `1`, with an active ticket, to arm in-session rail enforcement. |

If an install fails with `timed out after 120000ms`, that is this bound, not `agy`
crashing — retry with a larger `ADLC_AGY_TIMEOUT_MS`.

## Manifest: `version` and `adlcContract`

`plugin.json` is the authoritative manifest. `agy plugin install` copies the whole
plugin directory (including `plugin.json`) to
`~/.gemini/config/plugins/adlc-antigravity/`, so consumers can read these fields
directly from the installed source — no build step.

- **`version`** — `plugin.json`'s own agy-native manifest version, independent of
  `package.json`'s npm lockstep release version by design (see
  `test/packaging.test.mjs`: "plugin.json version is untouched by this ticket, still
  agy-native, not lockstep"). The two are never synced, and no test asserts they
  match.
- **`adlcContract`** — a positive integer that versions the runtime contract between
  this plugin and its consumers. It exists so a consumer's manifest handshake can
  read it from the installed `plugin.json` to detect drift. The antigravity-booster
  handshake (voodootikigod/antigravity-booster#12) uses it this way; before this
  field existed, the booster could only substring-match `agy plugin list`, which
  proved a plugin was *named* but never that its schema *matched*.

### When to bump `adlcContract`

`adlcContract` versions three interfaces. **Any breaking change to any one of them
bumps the integer by 1.** Additive, backward-compatible changes do NOT bump it.

1. **The `tickets.json` schema accepted by `core-inline.mjs`.**
   `loadTickets()` parses `.adlc/tickets.json` as `{ tickets: [...] }`, and
   `validateTicket()` enforces each ticket's shape. Only `id` and `title` are
   required (both must be strings); `scope`, `rails`, `edges` (each with a string
   `to`), and `duration` (a positive number) are optional but validated when
   present. Requiring a new field, removing/renaming a required one, tightening
   validation so previously-valid tickets are rejected, or changing the top-level
   envelope is breaking.

2. **The hook stdin payload shape.**
   The `PreToolUse` hook reads agy's `{ toolCall: { name, args } }` from stdin, with
   file-path args under PascalCase keys (`TargetFile`, `AbsolutePath`, …) and
   workspace roots under `workspacePaths`. Changing which keys the hook must read to
   locate the tool name, args, target paths, or workspace roots is breaking.

3. **The hook decision output shape.**
   The hook writes agy's verdict to stdout: `{ allow_tool: true }` to allow, or
   `{ allow_tool: false, deny_reason: "..." }` to deny. Renaming these keys or
   changing their types/semantics is breaking.

If you change one of these three interfaces in a backward-incompatible way, bump
`adlcContract` in `plugin.json` and update this list.

## Tests

```bash
node --test plugins/adlc-antigravity/test/*.test.mjs
```

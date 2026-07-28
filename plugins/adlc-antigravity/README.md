# adlc-antigravity

Embrace the ADLC inside Google Antigravity (`agy`): a phase-router plus doctrine
skills and a `PreToolUse` rails-guard that freezes ADLC rails. Requires the
`@adlc/cli` gate toolkit (`npm i -g @adlc/cli`).

## Install

**Global npm install (recommended):**

```sh
npm install -g @adlc/antigravity
agy plugin install $(npm root -g)/@adlc/antigravity
```

**One-liner via npx:**

```sh
npx adlc-agy install
```

**Local project install:**

```sh
npm install @adlc/antigravity
agy plugin install ./node_modules/@adlc/antigravity
```

**From local checkout:**

```sh
agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity
```

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

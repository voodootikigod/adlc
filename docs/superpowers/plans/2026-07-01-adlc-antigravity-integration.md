# ADLC × Antigravity (`adlc-antigravity`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native Google Antigravity (`agy`) plugin that installs the ADLC phase-router + doctrine skills and a `PreToolUse` rails-guard hook denying edits to frozen rails, on parity with the five existing `plugins/adlc-*` integrations.

**Architecture:** A native agy plugin (`plugins/adlc-antigravity/`) whose root `hooks.json` wires a `PreToolUse` hook. A tiny dependency-free `.cjs` shim registers process error handlers, then dynamic-imports the ESM adapter. The adapter maps agy's stdin (`toolCall.name`/`args`) onto the editor-agnostic `checkRail()` (copied verbatim from `adlc-cursor/rails-checker.mjs`, which delegates to `@adlc/core`), then emits agy's `{"allow_tool", "deny_reason"}` verdict and **always exits 0**. The in-session hook is advisory; the commit-time CI diff gate (`scripts/rails-guard-ci.mjs`) is the guarantee.

**Tech Stack:** Node ≥18 ESM + a CommonJS shim; `node:test`; `@adlc/core` (workspace dep); the `agy` CLI (native plugin system).

**Spec:** `docs/superpowers/specs/2026-07-01-adlc-antigravity-integration-design.md` (read it first — V1–V9 facts, F1–F4/G1–G7/H1–H3 resolutions).

## Global Constraints

- **Node ≥ 18**; the rails-guard **deny path imports only `node:` builtins + `@adlc/core`** (no third-party deps), matching the other plugins.
- **Deny contract (V5):** stdout `{"allow_tool": false, "deny_reason": "…"}` denies; `{"allow_tool": true}` allows; the hook process **must always `exit 0`** (non-zero = agy fail-open).
- **Enforcement gate:** all rail logic is a no-op unless `ADLC_P4_ENFORCEMENT === '1'`.
- **Fail direction:** under enforcement, a mutating/opaque tool the hook cannot fully resolve **fails closed** (deny); when enforcement is off, allow. The process never *intentionally* exits non-zero.
- **hooks.json schema (V3):** `{ "<hook-name>": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type":"command", "command":"…", "timeout":<sec> } ] } ] } }` — top level keyed by hook name; event is an **array**; `matcher` is a tool-name regex (`.*` = all).
- **Command path (V9, F3/G6):** `node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs` — POSIX (`$HOME` expands); Windows in-session is unsupported (documented; CI gate covers it).
- **Trust roots:** `.adlc/tickets.json` and `.adlc/current-ticket.json` are always frozen under enforcement (inherited from `rails-checker.mjs`).
- **Naming:** plugin `name` == install dir name == `adlc-antigravity` (V1; asserted by the smoke test).
- **Attribution disabled** in commits (repo convention).

---

### Task 1: Package skeleton + verbatim reuse of the editor-agnostic checker

**Files:**
- Create: `plugins/adlc-antigravity/plugin.json`
- Create: `plugins/adlc-antigravity/package.json`
- Create: `plugins/adlc-antigravity/rails-checker.mjs` (copied verbatim)
- Create: `plugins/adlc-antigravity/constants.mjs`

**Interfaces:**
- Produces: `rails-checker.mjs` exporting `checkRail({filePath, tool, root, env}) → {decision:'allow'|'deny', reason}`, `railPreconditions`, `classifyTool`, `isShellTool`, `normalizeToolName`, `PURE_READS`, `MUTATING_TOOL_HINTS`, `TRUST_ROOT_RAILS`. `constants.mjs` exporting `PRETOOL_MATCHER='.*'`.

- [ ] **Step 1: Copy the editor-agnostic checker and constants verbatim**

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/adlc-antigravity
mkdir -p plugins/adlc-antigravity/hooks plugins/adlc-antigravity/test
cp plugins/adlc-cursor/rails-checker.mjs plugins/adlc-antigravity/rails-checker.mjs
cp plugins/adlc-cursor/constants.mjs   plugins/adlc-antigravity/constants.mjs
```

- [ ] **Step 2: Write the agy plugin manifest**

Create `plugins/adlc-antigravity/plugin.json`:

```json
{
  "name": "adlc-antigravity",
  "version": "0.2.0",
  "description": "Embrace the ADLC inside Google Antigravity (agy): phase-router + doctrine skills and a PreToolUse rails-guard that freezes ADLC rails. Requires the @adlc/cli gate toolkit (npm i -g @adlc/cli)."
}
```

- [ ] **Step 3: Write the npm package manifest**

Create `plugins/adlc-antigravity/package.json`:

```json
{
  "name": "@adlc/antigravity-package",
  "private": true,
  "type": "module",
  "version": "0.2.0",
  "description": "ADLC native integration for Google Antigravity (agy)",
  "dependencies": { "@adlc/core": "*" },
  "agy": { "hooks": "./hooks.json", "skills": "./skills/", "command": "./commands/adlc-init.md" }
}
```

- [ ] **Step 4: Verify the checker copy delegates to core (no inlined engine)**

Run: `grep -c "from '@adlc/core'" plugins/adlc-antigravity/rails-checker.mjs`
Expected: `1` (imports core; does not re-implement globMatch/loadTickets).

- [ ] **Step 5: Commit**

```bash
git add plugins/adlc-antigravity/plugin.json plugins/adlc-antigravity/package.json plugins/adlc-antigravity/rails-checker.mjs plugins/adlc-antigravity/constants.mjs
git commit -m "feat(adlc-antigravity): package skeleton + reuse editor-agnostic rails-checker"
```

---

### Task 2: agy tool-name audit (BLOCKING — spec F4/G3)

Confirm every agy mutating tool classifies `mutating` and every read/non-file tool is allowed, extending the classifier sets if needed. This is a correctness gate, not a follow-up.

**Files:**
- Modify (only if a gap is found): `plugins/adlc-antigravity/rails-checker.mjs` (extend `PURE_READS` / `MUTATING_TOOL_HINTS` / `isShellTool`'s `SHELL_TOOL_NAMES`)
- Create: `plugins/adlc-antigravity/test/tool-classification.test.mjs`

**Interfaces:**
- Consumes: `classifyTool`, `isShellTool` from `rails-checker.mjs`.

- [ ] **Step 1: Enumerate agy's real tool names**

Run (records the live tool set to reason from):
```bash
strings -n 4 "$(command -v agy)" | grep -xiE '(write_to_file|create_file|edit|replace_file_content|multi_replace_file_content|run_command|view_file|list_dir|grep_search|codebase_search|read_file|search_web|ask_question)' | sort -u
```
Also confirm from a live transcript: `grep -aoE '"name":"[a-z_]+"' ~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript*.jsonl | sort | uniq -c | sort -rn | head -30`
Expected: a concrete list. Known-verified: `write_to_file`, `create_file`, `edit`, `run_command`, `view_file`, `list_dir`, `grep_search`.

- [ ] **Step 2: Write the failing classification table test**

Create `plugins/adlc-antigravity/test/tool-classification.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, isShellTool } from '../rails-checker.mjs';

// Every agy MUTATING file tool must classify 'mutating' (so a rail write is denied).
for (const t of ['write_to_file', 'create_file', 'edit', 'replace_file_content', 'multi_replace_file_content']) {
  test(`agy mutating tool "${t}" classifies mutating`, () => {
    assert.equal(classifyTool(t), 'mutating');
  });
}
// Every agy READ tool must classify 'readonly' (never blocked).
for (const t of ['view_file', 'list_dir', 'grep_search', 'codebase_search', 'read_file']) {
  test(`agy read tool "${t}" classifies readonly`, () => {
    assert.equal(classifyTool(t), 'readonly');
  });
}
// The shell tool is recognized (allowed in-session; CI-gated).
test('run_command is a shell tool', () => {
  assert.equal(isShellTool('run_command'), true);
});
```

- [ ] **Step 3: Run — expect failures for any uncovered agy name**

Run: `node --test plugins/adlc-antigravity/test/tool-classification.test.mjs`
Expected: FAILs for `codebase_search` (not in `PURE_READS`) and `read_file` (only `readfile` is in the set — `read_file`→`readfile` IS covered; `codebase_search`→`codebasesearch` IS in the set). Run to discover the ACTUAL gaps from Step 1's real list, then fix in Step 4.

- [ ] **Step 4: Close any gap in the classifier sets**

For each name that failed, add its `normalizeToolName` form (lowercase, non-alpha stripped) to the right set in `plugins/adlc-antigravity/rails-checker.mjs`. Example if `codebase_search` were missing:

```javascript
// in PURE_READS (whole normalized tokens):
export const PURE_READS = new Set([
  'read', 'readfile', 'readlints', 'grep', 'grepsearch', 'glob', 'globsearch',
  'codebasesearch', 'semanticsearch', 'filesearch', 'list', 'listdir', 'ls',
  'cat', 'view', 'viewfile', 'webfetch', 'websearch', 'fetch', 'fetchrules', 'search',
]);
```

Add a comment `// agy: <raw name>` beside any name added specifically for agy.

- [ ] **Step 5: Run to green**

Run: `node --test plugins/adlc-antigravity/test/tool-classification.test.mjs`
Expected: PASS (all agy mutating tools → mutating; all reads → readonly; run_command → shell).

- [ ] **Step 6: Commit**

```bash
git add plugins/adlc-antigravity/test/tool-classification.test.mjs plugins/adlc-antigravity/rails-checker.mjs
git commit -m "test(adlc-antigravity): pin agy tool-name classification (F4/G3 audit)"
```

---

### Task 3: agy wire parsing — tool name + defensive path extraction

**Files:**
- Create: `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs` (start it here)
- Create: `plugins/adlc-antigravity/test/wire.test.mjs`

**Interfaces:**
- Produces: `extractToolName(payload) → string`, `extractFilePaths(payload) → string[]` handling agy's `toolCall.{name,args}` with PascalCase keys.

- [ ] **Step 1: Write the failing wire test**

Create `plugins/adlc-antigravity/test/wire.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToolName, extractFilePaths } from '../hooks/adlc-rails-guard.mjs';

const writePayload = { toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/src/a.js', CodeContent: 'x', Overwrite: true } } };
const viewPayload  = { toolCall: { name: 'view_file', args: { AbsolutePath: '/repo/src/a.js' } } };
const runPayload   = { toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > /repo/x' } } };

test('extractToolName reads toolCall.name', () => {
  assert.equal(extractToolName(writePayload), 'write_to_file');
});
test('extractFilePaths reads write_to_file TargetFile', () => {
  assert.deepEqual(extractFilePaths(writePayload), ['/repo/src/a.js']);
});
test('extractFilePaths reads view_file AbsolutePath', () => {
  assert.deepEqual(extractFilePaths(viewPayload), ['/repo/src/a.js']);
});
test('extractFilePaths does NOT treat CommandLine as a file path', () => {
  // run_command is shell-gated by classification, not path — CommandLine is not a file path.
  assert.deepEqual(extractFilePaths(runPayload), []);
});
test('extractToolName on empty payload is empty string', () => {
  assert.equal(extractToolName({}), '');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/adlc-antigravity/test/wire.test.mjs`
Expected: FAIL — cannot import `extractToolName` (module not created yet).

- [ ] **Step 3: Implement the parsing head of the adapter**

Create `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`:

```javascript
#!/usr/bin/env node
// adlc-rails-guard.mjs — the agy PreToolUse hook adapter (ESM core).
// Invoked via the .cjs shim (adlc-rails-guard.cjs) which registers process error
// handlers first. Maps agy's stdin { toolCall: { name, args } } onto the
// editor-agnostic checkRail() and emits agy's { allow_tool, deny_reason } verdict.
// Deny path imports ONLY node: builtins + the sibling checker (→ @adlc/core).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { checkRail, classifyTool, isShellTool, railPreconditions } from '../rails-checker.mjs';

// agy nests the call under toolCall; args is the parameter bag. Read defensively.
const TOOLCALL_KEYS = ['toolCall', 'tool_call', 'tool'];
const NAME_KEYS = ['name', 'toolName', 'tool_name'];
const ARGS_KEYS = ['args', 'arguments', 'params', 'parameters', 'input', 'tool_input'];
// agy file-path arg keys are PascalCase (V7): write_to_file→TargetFile,
// view_file→AbsolutePath. Include common fallbacks. CommandLine/CodeContent are
// deliberately EXCLUDED — they are a shell string / file body, not a path.
const PATH_KEYS = ['TargetFile', 'AbsolutePath', 'FilePath', 'Path', 'path', 'file_path', 'filePath', 'target_file', 'targetFile'];

function toolCallOf(p) {
  if (!p || typeof p !== 'object') return undefined;
  for (const k of TOOLCALL_KEYS) if (p[k] && typeof p[k] === 'object') return p[k];
  return p; // some shapes may put name/args at top level
}
function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
  return undefined;
}

export function extractToolName(payload) {
  return firstString(toolCallOf(payload), NAME_KEYS) ?? '';
}
export function extractArgs(payload) {
  const tc = toolCallOf(payload);
  if (!tc || typeof tc !== 'object') return {};
  for (const k of ARGS_KEYS) if (tc[k] && typeof tc[k] === 'object') return tc[k];
  return {};
}
export function extractFilePaths(payload) {
  const args = extractArgs(payload);
  const out = new Set();
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out.add(v);
    else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) out.add(e);
  }
  return [...out];
}
```

- [ ] **Step 4: Run to green**

Run: `node --test plugins/adlc-antigravity/test/wire.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs plugins/adlc-antigravity/test/wire.test.mjs
git commit -m "feat(adlc-antigravity): agy stdin parsing + PascalCase path extraction"
```

---

### Task 4: root derivation with NO cwd fallback (spec H1/H2/H3)

The agy-specific crux: the hook cwd is the plugin dir (V8), so — unlike the Cursor adapter — we must **never** fall back to `process.cwd()`. Derive the repo root by walking up from the **absolute** target path to `.adlc/tickets.json`; a relative/unanchorable path or a missing path fails closed under enforcement.

**Files:**
- Modify: `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`
- Create: `plugins/adlc-antigravity/test/root.test.mjs`

**Interfaces:**
- Produces: `findAdlcRoot(absPath) → string | null` (nearest ancestor dir containing `.adlc/tickets.json`), `anchorPath(rawPath, payload) → {abs: string|null, anchored: boolean}`.

- [ ] **Step 1: Write the failing root test**

Create `plugins/adlc-antigravity/test/root.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAdlcRoot, anchorPath } from '../hooks/adlc-rails-guard.mjs';

function repoWithAdlc() {
  const root = mkdtempSync(join(tmpdir(), 'agy-root-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('findAdlcRoot walks up to the .adlc/ ancestor', () => {
  const root = repoWithAdlc();
  assert.equal(findAdlcRoot(join(root, 'src', 'a.js')), root);
});
test('findAdlcRoot returns null when no .adlc up-tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-noadlc-'));
  assert.equal(findAdlcRoot(join(root, 'a.js')), null);
});
test('anchorPath keeps an absolute path as-is', () => {
  const r = anchorPath('/abs/a.js', {});
  assert.deepEqual(r, { abs: '/abs/a.js', anchored: true });
});
test('anchorPath anchors a relative path via workspacePaths[0]', () => {
  const r = anchorPath('src/a.js', { workspacePaths: ['/ws'] });
  assert.deepEqual(r, { abs: join('/ws', 'src/a.js'), anchored: true });
});
test('anchorPath cannot anchor a relative path with empty workspacePaths', () => {
  const r = anchorPath('src/a.js', { workspacePaths: [] });
  assert.equal(r.anchored, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/adlc-antigravity/test/root.test.mjs`
Expected: FAIL — `findAdlcRoot`/`anchorPath` not exported.

- [ ] **Step 3: Implement root derivation (append to the adapter)**

Append to `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`:

```javascript
const WORKSPACE_KEYS = ['workspacePaths', 'workspace_paths', 'workspaceRoots', 'workspace_roots'];

/** Nearest ancestor dir of absPath containing .adlc/tickets.json, or null. */
export function findAdlcRoot(absPath) {
  let cur = dirname(absPath);
  const { root: fsRoot } = parse(cur);
  // Bounded walk to the filesystem root — never uses process.cwd() (the plugin dir).
  while (true) {
    if (existsSync(join(cur, '.adlc', 'tickets.json'))) return cur;
    if (cur === fsRoot) return null;
    cur = dirname(cur);
  }
}

/** Make a raw target path absolute using workspacePaths[0]; report if we could. */
export function anchorPath(rawPath, payload) {
  if (!rawPath) return { abs: null, anchored: false };
  if (isAbsolute(rawPath)) return { abs: rawPath, anchored: true };
  const ws = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
    .find((s) => typeof s === 'string' && s.trim());
  if (ws) return { abs: join(ws, rawPath), anchored: true };
  return { abs: null, anchored: false };
}
```

- [ ] **Step 4: Run to green**

Run: `node --test plugins/adlc-antigravity/test/root.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs plugins/adlc-antigravity/test/root.test.mjs
git commit -m "feat(adlc-antigravity): .adlc root derivation with no cwd fallback (H1/H2/H3)"
```

---

### Task 5: the decision function `decide()` — the §5 tree → agy verdict

**Files:**
- Modify: `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`
- Create: `plugins/adlc-antigravity/test/decide.test.mjs`

**Interfaces:**
- Consumes: `checkRail`, `classifyTool`, `isShellTool`, `railPreconditions` (checker); `extractToolName`, `extractFilePaths`, `findAdlcRoot`, `anchorPath` (Tasks 3–4).
- Produces: `decide(payload, {env}) → {allow_tool: boolean, deny_reason?: string}`.

- [ ] **Step 1: Write the failing decision tests (one per spec finding)**

Create `plugins/adlc-antigravity/test/decide.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../hooks/adlc-rails-guard.mjs';

const ENF = { ADLC_P4_ENFORCEMENT: '1' };

function adlcRepo({ rails = [], id = 'T1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-dec-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id, title: 't', body: 'b', scope: ['src/**'], rails }] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}
const call = (name, args, env = ENF, extra = {}) => decide({ toolCall: { name, args }, ...extra }, { env });

test('G1: non-file tool (search_web) allowed under enforcement', () => {
  assert.equal(call('search_web', { query: 'x' }).allow_tool, true);
});
test('read-only tool (view_file) allowed under enforcement', () => {
  assert.equal(call('view_file', { AbsolutePath: '/anything/a.js' }).allow_tool, true);
});
test('shell tool (run_command) allowed in-session', () => {
  assert.equal(call('run_command', { CommandLine: 'echo hi > /x' }).allow_tool, true);
});
test('G2: write with ABSOLUTE path in non-ADLC repo allowed under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-noadlc-'));
  assert.equal(call('write_to_file', { TargetFile: join(root, 'a.js') }).allow_tool, true);
});
test('rail hit: mutating write to a frozen rail denied', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  const v = call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') });
  assert.equal(v.allow_tool, false);
  assert.match(v.deny_reason, /frozen rail/i);
});
test('non-rail write in ADLC repo allowed', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src', 'ok.js') }).allow_tool, true);
});
test('H1/H3: relative path + empty workspacePaths (headless) denied under enforcement', () => {
  const v = call('write_to_file', { TargetFile: 'src/frozen.js' }, ENF, { workspacePaths: [] });
  assert.equal(v.allow_tool, false);
});
test('H2: name-mutating tool with unknown path key (no path) denied under enforcement', () => {
  const v = call('write_to_file', { DirectoryPath: '/repo/src' }); // key not in PATH_KEYS
  assert.equal(v.allow_tool, false);
});
test('enforcement OFF is a no-op allow even on a rail', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') }, {}).allow_tool, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/adlc-antigravity/test/decide.test.mjs`
Expected: FAIL — `decide` not exported.

- [ ] **Step 3: Implement `decide()` (append to the adapter)**

Append to `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`:

```javascript
const allow = () => ({ allow_tool: true });
const deny = (reason) => ({ allow_tool: false, deny_reason: `ADLC rails-guard: ${reason}` });

/**
 * Pure decision over a parsed agy PreToolUse payload → agy verdict.
 * Never throws (the caller also wraps it). Implements the §5 decision tree.
 */
export function decide(payload, { env = process.env } = {}) {
  const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
  try {
    const tool = extractToolName(payload);
    const cls = classifyTool(tool);

    // Step 2 — classify first. Reads and shell tools are never rail-gated in-session.
    if (cls === 'readonly') return allow();
    if (isShellTool(tool)) return allow(); // run_command → CI diff gate

    const paths = extractFilePaths(payload);

    // Step 2 (cont.) — an 'other' tool with NO path and no mutating hint is not a file
    // op (e.g. search_web) → allow. A 'mutating' name with no path is opaque (H2).
    if (!paths.length) {
      if (cls === 'other') return allow();
      return enforcing
        ? deny(`mutating tool "${tool}" exposed no inspectable target path — failing closed`)
        : allow();
    }

    // Steps 3–4 — resolve each target; fail closed on anything unanchorable (H1/H2/H3),
    // no-op allow only for an absolute path in a genuinely non-ADLC location (G2).
    for (const raw of paths) {
      const { abs, anchored } = anchorPath(raw, payload);
      if (!anchored) {
        if (enforcing) return deny(`unanchorable path "${raw}" (relative, no workspace root) — failing closed`);
        continue;
      }
      const root = findAdlcRoot(abs);
      if (root === null) continue; // absolute path, not an ADLC repo → no-op allow (G2)
      const verdict = checkRail({ filePath: abs, tool, root, env });
      if (verdict.decision === 'deny') return deny(`frozen rail — ${verdict.reason}`);
    }
    return allow();
  } catch (err) {
    // Categorical fail-safe: under enforcement an unexpected error is more likely
    // tamper/corruption than a benign bug → fail CLOSED; off → no-op allow.
    return enforcing ? deny(`internal error while enforcing — ${err?.message ?? err}`) : allow();
  }
}
```

- [ ] **Step 4: Run to green**

Run: `node --test plugins/adlc-antigravity/test/decide.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs plugins/adlc-antigravity/test/decide.test.mjs
git commit -m "feat(adlc-antigravity): decide() implements the §5 rail decision tree (G1/G2/H1/H2)"
```

---

### Task 6: stdin/stdout main + the always-exit-0 fail-safe `.cjs` shim (spec F1/G4)

**Files:**
- Modify: `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs` (add `main()`)
- Create: `plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs` (the shim entry)
- Create: `plugins/adlc-antigravity/hooks.json`
- Create: `plugins/adlc-antigravity/test/shim.test.mjs`

**Interfaces:**
- Produces: `runFromStdin(rawString, env) → verdictObject` (pure, testable); the `.cjs` shim as the hooks.json entry point.

- [ ] **Step 1: Write the failing main/shim tests**

Create `plugins/adlc-antigravity/test/shim.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runFromStdin } from '../hooks/adlc-rails-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, '..', 'hooks', 'adlc-rails-guard.cjs');

test('runFromStdin: malformed JSON under enforcement fails closed', () => {
  const v = runFromStdin('{not json', { ADLC_P4_ENFORCEMENT: '1' });
  assert.equal(v.allow_tool, false);
});
test('runFromStdin: malformed JSON with enforcement off allows', () => {
  const v = runFromStdin('{not json', {});
  assert.equal(v.allow_tool, true);
});
test('shim: exits 0 and prints an allow verdict for a read tool', () => {
  const out = execFileSync(process.execPath, [SHIM], {
    input: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: '/x' } } }),
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { allow_tool: true });
});
test('shim: exit code is 0 even when the ESM module path is broken (fail-open is agy default; we still must not crash noisily)', () => {
  // Point the shim at a non-existent module via env override to simulate a load failure.
  let code = 0;
  try {
    execFileSync(process.execPath, [SHIM], {
      input: '{}', encoding: 'utf8',
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_AGY_ADAPTER_OVERRIDE: '/no/such/module.mjs' },
    });
  } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/adlc-antigravity/test/shim.test.mjs`
Expected: FAIL — `runFromStdin` missing and the `.cjs` shim does not exist.

- [ ] **Step 3: Add `runFromStdin` + `main` to the ESM adapter**

Append to `plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`:

```javascript
/** Parse a raw stdin string and return the agy verdict. Enforcement-aware on bad JSON. */
export function runFromStdin(raw, env = process.env) {
  const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
  let payload = {};
  if (raw && raw.trim()) {
    try { payload = JSON.parse(raw); }
    catch { return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : allow(); }
  }
  return decide(payload, { env });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  const raw = await readStdin();
  process.stdout.write(JSON.stringify(runFromStdin(raw, process.env)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
```

- [ ] **Step 4: Write the dependency-free `.cjs` shim (F1/G4 — smallest possible surface)**

Create `plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs`:

```javascript
#!/usr/bin/env node
/* adlc-rails-guard.cjs — fail-safe entry for the agy PreToolUse hook (spec F1/G4).
 * agy fails OPEN on a non-zero exit (V5), so this shim's ONLY jobs are: register
 * error handlers FIRST, then dynamic-import the ESM adapter inside try/catch, and
 * ALWAYS exit 0. Minimal syntax surface, zero imports at load time. */
'use strict';
var enforcing = process.env.ADLC_P4_ENFORCEMENT === '1';
function emit(v) { try { process.stdout.write(JSON.stringify(v)); } catch (_) {} process.exit(0); }
function failSafe(reason) {
  emit(enforcing ? { allow_tool: false, deny_reason: 'ADLC rails-guard: ' + reason } : { allow_tool: true });
}
process.on('uncaughtException', function (e) { failSafe('uncaught ' + (e && e.message)); });
process.on('unhandledRejection', function (e) { failSafe('rejection ' + (e && e.message)); });

var mod = process.env.ADLC_AGY_ADAPTER_OVERRIDE || (__dirname + '/adlc-rails-guard.mjs');
(async function () {
  try {
    var chunks = [];
    for await (var c of process.stdin) chunks.push(c);
    var raw = Buffer.concat(chunks).toString('utf8');
    var adapter = await import(require('node:url').pathToFileURL(mod).href);
    emit(adapter.runFromStdin(raw, process.env));
  } catch (e) { failSafe('load/exec ' + (e && e.message)); }
})();
```

- [ ] **Step 5: Write hooks.json (V3 schema, `$HOME` command per V9/F3)**

Create `plugins/adlc-antigravity/hooks.json`:

```json
{
  "adlc-rails": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Run the shim tests to green**

Run: `node --test plugins/adlc-antigravity/test/shim.test.mjs`
Expected: PASS (4 tests) — note the broken-module case asserts **exit 0** (we cannot make agy fail-closed on process death; the CI gate is the guarantee, per §6.0).

- [ ] **Step 7: Commit**

```bash
git add plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs plugins/adlc-antigravity/hooks.json plugins/adlc-antigravity/test/shim.test.mjs
git commit -m "feat(adlc-antigravity): fail-safe .cjs shim + hooks.json (always exit 0; F1/G4/V3/V9)"
```

---

### Task 7: Skills, prosecutor agent, and the `/adlc-init` command

**Files:**
- Create: `plugins/adlc-antigravity/skills/adlc/SKILL.md` (phase-router, stamped with V1–V9)
- Create: `plugins/adlc-antigravity/skills/adlc-doctrine/SKILL.md` (vendored)
- Create: `plugins/adlc-antigravity/skills/adlc-prosecutor/SKILL.md` (vendored)
- Create: `plugins/adlc-antigravity/skills/adlc-self-orchestrate/SKILL.md` (vendored)
- Create: `plugins/adlc-antigravity/agents/prosecutor.md`
- Create: `plugins/adlc-antigravity/commands/adlc-init.md`

**Interfaces:**
- Produces: skill/command/agent markdown discoverable by `agy plugin validate`.

- [ ] **Step 1: Vendor the three booster skills**

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/adlc-antigravity
mkdir -p plugins/adlc-antigravity/skills/adlc-doctrine plugins/adlc-antigravity/skills/adlc-prosecutor plugins/adlc-antigravity/skills/adlc-self-orchestrate plugins/adlc-antigravity/agents plugins/adlc-antigravity/commands
cp ../../../antigravity-booster/skills/adlc-doctrine/SKILL.md       plugins/adlc-antigravity/skills/adlc-doctrine/SKILL.md
cp ../../../antigravity-booster/skills/adlc-prosecutor/SKILL.md     plugins/adlc-antigravity/skills/adlc-prosecutor/SKILL.md
cp ../../../antigravity-booster/skills/adlc-self-orchestrate/SKILL.md plugins/adlc-antigravity/skills/adlc-self-orchestrate/SKILL.md
```
(Path note: the worktree is `.worktrees/adlc-antigravity` under the repo, so `antigravity-booster` is three levels up. Verify with `ls ../../../antigravity-booster/skills` first; adjust depth if needed.)

- [ ] **Step 2: Author the phase-router skill stamped with the verified agy facts**

Create `plugins/adlc-antigravity/skills/adlc/SKILL.md` by adapting the Claude Code router. Copy the phase table, then append an agy-specific "Rails in Antigravity" section. Base:

```bash
cp plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-antigravity/skills/adlc/SKILL.md
```
Then edit its frontmatter `name`/`description` for agy and append this section verbatim (facts from spec §2):

```markdown
## Rails in Antigravity (agy)

This plugin installs a `PreToolUse` rails-guard hook. It is **advisory** in-session —
agy fails OPEN on a non-zero hook exit, so a frozen-rail write can slip through a hook
crash/timeout. **The unbypassable guarantee is the commit-time CI gate**
(`scripts/rails-guard-ci.mjs`). Enforcement activates only when `ADLC_P4_ENFORCEMENT=1`
and an active ticket declares `rails[]`. Shell (`run_command`) writes are not gated
in-session; the CI gate catches them.
```

- [ ] **Step 3: Author the prosecutor agent**

```bash
cp plugins/adlc-claude-code/agents/prosecutor.md plugins/adlc-antigravity/agents/prosecutor.md
```
Verify it has YAML frontmatter with `name:` and `description:` (agy loads `agents/*.md`). No content change needed.

- [ ] **Step 4: Author the `/adlc-init` command**

Create `plugins/adlc-antigravity/commands/adlc-init.md`:

```markdown
---
name: adlc-init
description: Bootstrap ADLC in this repo for Antigravity — install the plugin into agy and scaffold .adlc/.
---

# /adlc-init (Antigravity)

Bootstrap the ADLC runtime for use with `agy`.

1. **Install this plugin into agy** (idempotent):
   ```sh
   agy plugin install /absolute/path/to/plugins/adlc-antigravity
   agy plugin list   # confirm "adlc-antigravity" with a "hooks" component
   ```
2. **Initialize the ADLC workspace** (creates `.adlc/`, requires `npm i -g @adlc/cli`):
   ```sh
   adlc init || npx @adlc/cli init
   ```
3. **Add the .gitignore stanza** so only the ticket file is tracked:
   ```
   .adlc/*
   !.adlc/tickets.json
   ```
4. **Wire the CI gate** (the real guarantee): copy `docs/ci/rails-guard.yml` into your
   pipeline and make it a required check. The in-session hook is advisory.
5. **Activate enforcement** for a build: `export ADLC_P4_ENFORCEMENT=1` with an active
   ticket whose `rails[]` are frozen.
```

- [ ] **Step 5: Validate the plugin loads in agy**

Run: `agy plugin validate plugins/adlc-antigravity`
Expected: `[ok]` with `skills`, `agents`, `commands`, `hooks` all processed (commands convert to skills).

- [ ] **Step 6: Commit**

```bash
git add plugins/adlc-antigravity/skills plugins/adlc-antigravity/agents plugins/adlc-antigravity/commands
git commit -m "feat(adlc-antigravity): phase-router + vendored doctrine skills, prosecutor agent, adlc-init"
```

---

### Task 8: Marketplace registration + integration doc

**Files:**
- Modify: `.agents/plugins/marketplace.json`
- Create: `docs/integrations/antigravity.md`
- Modify: `docs/README.md`, `README.md` (link the new doc)

**Interfaces:** none (docs/registry).

- [ ] **Step 1: Add the marketplace entry**

Modify `.agents/plugins/marketplace.json` — add to `plugins[]` (after the `adlc-codex` object):

```json
{
  "name": "adlc-antigravity",
  "source": { "source": "local", "path": "./plugins/adlc-antigravity" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools"
}
```

- [ ] **Step 2: Verify the marketplace JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('.agents/plugins/marketplace.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Write the integration doc (mirror cursor.md structure)**

Create `docs/integrations/antigravity.md` with these required sections (the smoke test in Task 9 asserts them): a two-layer framing that names the CI gate `scripts/rails-guard-ci.mjs` and calls the in-session hook **advisory**; a **Formal ADLC Coverage** table (P0–P7); and a **Verified hook-contract appendix** carrying V1–V9 from the spec. Skeleton:

```markdown
# ADLC × Google Antigravity (`agy`)

Native ADLC integration for the Antigravity CLI. Two layers:

1. **In-session rails-guard (advisory).** A `PreToolUse` plugin hook denies edits to
   frozen rails. It is best-effort: agy fails **open** on a non-zero hook exit, so a
   hook crash/timeout/Windows-path failure can let a rail write through.
2. **CI diff gate (the guarantee).** `scripts/rails-guard-ci.mjs` (`docs/ci/rails-guard.yml`)
   is the unbypassable, cross-platform control. Make it a required check.

## Install

```sh
agy plugin install adlc-antigravity@adlc     # via the .agents marketplace
# or, from a local checkout:
agy plugin install /abs/path/plugins/adlc-antigravity
```
Then `/adlc-init`. Enforcement: `export ADLC_P4_ENFORCEMENT=1` with an active ticket.

## Formal ADLC Coverage

| Phase | Antigravity surface |
|-------|---------------------|
| P0 Triage | `/adlc-init`, `adlc-ticket` skill → `.adlc/tickets.json` |
| P1 Interrogate | `adlc spec-lint/premortem/parallax` via the `adlc` CLI |
| P2 Decompose | `adlc coldstart/model-router/merge-forecast` |
| P3 Rail | **PreToolUse rails-guard hook** (advisory) + CI gate (guarantee) |
| P4 Build | doctrine skill; `adlc flail-detector/consensus-fix` |
| P5 Prosecute | `adlc-prosecutor` skill + `prosecutor` agent; `adlc hollow-test/behavior-diff` |
| P6 Integrate | human gate — `adlc gate-manifest` |
| P7 Distill | `adlc lesson-foundry/rejection-mining` |

## Platform notes / limitations

- **POSIX only in-session** (`$HOME` command path); Windows in-session is unsupported —
  the CI gate protects Windows users.
- Shell (`run_command`) writes are not gated in-session (CI gate catches them).

## Appendix: verified `agy` hook contract (agy 1.0.13)

(Carry V1–V9 verbatim from the design spec §2.)
```

- [ ] **Step 4: Link the doc**

Add a bullet to the integrations list in `docs/README.md` and `README.md` (match the format of the existing `cursor.md`/`pi.md` links):
`- [Google Antigravity](docs/integrations/antigravity.md)` (adjust relative path per file).

- [ ] **Step 5: Commit**

```bash
git add .agents/plugins/marketplace.json docs/integrations/antigravity.md docs/README.md README.md
git commit -m "docs(adlc-antigravity): marketplace entry + integration doc (advisory + CI-gate framing)"
```

---

### Task 9: Install smoke test + wire into the root test script

**Files:**
- Create: `scripts/antigravity-install-smoke.mjs`
- Modify: `package.json` (root `test` script)

**Interfaces:**
- Consumes: the whole `plugins/adlc-antigravity/` package.

- [ ] **Step 1: Write the smoke test (mirrors cursor-install-smoke.mjs)**

Create `scripts/antigravity-install-smoke.mjs`:

```javascript
#!/usr/bin/env node
// antigravity-install-smoke.mjs — verify the adlc-antigravity package shape,
// hooks.json schema (V3), always-exit-0 deny contract (V5), $HOME command path,
// name/dir invariant, doc framing, and run the plugin unit tests. No agy binary
// required. Exit 0 = pass, 2 = fail.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const PLUGIN = join(ROOT, 'plugins', 'adlc-antigravity');
let failures = 0;
const fail = (m) => { console.error(`antigravity-install-smoke: FAIL — ${m}`); failures++; };
const ok = (m) => console.log(`  ok — ${m}`);
const read = (p) => readFileSync(p, 'utf8');

// manifest + name/dir invariant (F3)
const manifest = JSON.parse(read(join(PLUGIN, 'plugin.json')));
if (manifest.name !== 'adlc-antigravity') fail(`plugin.json name is ${manifest.name}`); else ok('plugin.json name == dir name');

// hooks.json V3 schema + $HOME command + catch-all matcher + .cjs entry
const hj = JSON.parse(read(join(PLUGIN, 'hooks.json')));
const spec = hj['adlc-rails']?.PreToolUse?.[0];
if (!spec) fail('hooks.json: adlc-rails.PreToolUse[0] missing'); else ok('hooks.json V3 shape (named hook → PreToolUse array)');
if (spec?.matcher !== '.*') fail(`matcher is "${spec?.matcher}", not catch-all`); else ok('catch-all matcher');
const cmd = spec?.hooks?.[0]?.command ?? '';
if (!/\$HOME\/\.gemini\/config\/plugins\/adlc-antigravity\/hooks\/adlc-rails-guard\.cjs/.test(cmd)) fail(`command is not the $HOME .cjs path: ${cmd}`); else ok('command uses $HOME .cjs path (V9)');

// deny path: only node: + @adlc/core
const chk = read(join(PLUGIN, 'rails-checker.mjs'));
const guard = read(join(PLUGIN, 'hooks', 'adlc-rails-guard.mjs'));
const imports = [...chk.matchAll(/from '([^']+)'/g), ...guard.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
if (imports.some((s) => !s.startsWith('node:') && !s.startsWith('.') && s !== '@adlc/core')) fail('deny path imports third-party deps'); else ok('deny path: node: + @adlc/core only');

// always exit 0 + allow_tool contract: drive the shim with a rail-hit fixture
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = mkdtempSync(join(tmpdir(), 'agy-smoke-'));
mkdirSync(join(repo, '.adlc'), { recursive: true });
writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 't', body: 'b', scope: ['src/**'], rails: ['src/frozen.js'] }] }));
writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
mkdirSync(join(repo, 'src'), { recursive: true });
const SHIM = join(PLUGIN, 'hooks', 'adlc-rails-guard.cjs');
const drive = (name, args) => {
  const out = execFileSync(process.execPath, [SHIM], { input: JSON.stringify({ toolCall: { name, args } }), env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8' });
  return JSON.parse(out);
};
if (drive('write_to_file', { TargetFile: join(repo, 'src', 'frozen.js') }).allow_tool !== false) fail('shim did not DENY a rail write'); else ok('shim denies a frozen-rail write (exit 0 + allow_tool:false)');
if (drive('write_to_file', { TargetFile: join(repo, 'src', 'ok.js') }).allow_tool !== true) fail('shim did not ALLOW a non-rail write'); else ok('shim allows a non-rail write');

// doc framing
const doc = read(join(ROOT, 'docs', 'integrations', 'antigravity.md'));
if (!/rails-guard-ci\.mjs|ci\/rails-guard\.yml/.test(doc)) fail('doc does not name the CI gate'); else ok('doc names the CI gate');
if (!/advisor/i.test(doc)) fail('doc does not frame the hook as advisory'); else ok('doc frames hook as advisory');
if (!/Formal ADLC Coverage/.test(doc)) fail('doc missing Formal ADLC Coverage table'); else ok('doc has coverage table');

// run the plugin unit tests
try {
  const tests = readdirSync(join(PLUGIN, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join(PLUGIN, 'test', f));
  execFileSync(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'pipe' });
  ok('plugin unit tests pass');
} catch (e) { fail(`unit tests failed:\n${e.stdout?.toString() ?? e.message}`); }

if (failures) { console.error(`\nantigravity-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\nantigravity-install-smoke: PASS');
```

(Move the `import` statements to the top of the file when writing — they are shown inline here only for locality.)

- [ ] **Step 2: Run the smoke test**

Run: `node scripts/antigravity-install-smoke.mjs .`
Expected: a list of `ok —` lines then `antigravity-install-smoke: PASS`.

- [ ] **Step 3: Wire into the root test script**

Modify the `scripts.test` string in `package.json` — append before its closing quote:
```
 && node --test plugins/adlc-antigravity/test/*.test.mjs && node scripts/antigravity-install-smoke.mjs .
```

- [ ] **Step 4: Run the full repo test suite**

Run: `npm test`
Expected: all existing tests still pass, plus the new adlc-antigravity tests and smoke PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/antigravity-install-smoke.mjs package.json
git commit -m "test(adlc-antigravity): install smoke (V3 schema, exit-0 deny, name invariant) + wire into npm test"
```

---

### Task 10: Live end-to-end verification against agy (manual gate)

Prove the hook actually denies a rail write through a real `agy --print` run (mirrors the probe that validated the design). This is a manual acceptance step; it needs a working agy session.

- [ ] **Step 1: Install the plugin into agy**

Run: `agy plugin install plugins/adlc-antigravity && agy plugin list`
Expected: `adlc-antigravity` listed with a `hooks` component.

- [ ] **Step 2: Prepare a throwaway ADLC repo with a frozen rail** (outside the worktree, e.g. under `/tmp`): create `.adlc/tickets.json` with one ticket whose `rails: ["rail.txt"]`, `.adlc/current-ticket.json` `{"id":"T1"}`, and `export ADLC_P4_ENFORCEMENT=1`.

- [ ] **Step 3: Ask agy to write the rail**

Run (from the throwaway repo): `printf 'Create rail.txt containing X here. Then stop.' | agy --print --add-dir "$PWD" --model "Gemini 3.5 Flash (High)"`
Expected: agy reports the write was **denied** (`tool call denied with reason: ADLC rails-guard: … frozen rail`), and `rail.txt` does **not** exist.

- [ ] **Step 4: Confirm a non-rail write is allowed** — ask agy to write `ok.txt`; it should succeed.

- [ ] **Step 5: Uninstall the probe** (leave the user's agy clean if this was just verification): `agy plugin uninstall adlc-antigravity` (or keep it if the user wants it installed).

- [ ] **Step 6: Record the result** in the PR description (verified deny + allow). No commit needed unless a fix was required.

---

## Self-Review

**Spec coverage:** §3 layers → Tasks 6/7/8; §4 layout → Tasks 1/6/7/8/9; §5 decision tree → Tasks 3/4/5; §6 F1/G4 → Task 6; F2/G1/G2/H1/H2/H3 → Tasks 4/5 (tests per finding); F3/G6 → Tasks 6/8; F4/G3 (blocking audit) → Task 2; F8/G7 (fast hook) → inherent (small reads); §8 testing → Tasks 2–6 + 9; marketplace/docs → Task 8; live proof → Task 10. All covered.

**Placeholder scan:** every code step carries real code; copy steps carry exact commands. The doc/skill authoring steps give concrete required content and assertions. No TBDs.

**Type consistency:** `decide(payload,{env})→{allow_tool,deny_reason?}`, `runFromStdin(raw,env)`, `extractToolName/extractFilePaths/extractArgs`, `findAdlcRoot(abs)`, `anchorPath(raw,payload)→{abs,anchored}` are used consistently across Tasks 3–6 and the smoke test. `checkRail`/`classifyTool`/`isShellTool`/`railPreconditions` match the copied `rails-checker.mjs` exports.

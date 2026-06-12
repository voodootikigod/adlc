# behavior-diff — ADLC C14

Behavior-space diff for the **P6 human gate**. Review *what changed* in behavior,
not 5,000-line diffs. Captures observable HTTP surface (status, content-type, body
structure) before and after a change, then diffs in behavior-space: "3 endpoints
changed shape, 1 removed, everything else identical."

The code diff is 5,000 lines; the behavior diff is six items. The human reviews
**intent vs behavior** — the one judgment machines cannot make — while the manifest
(C11) proves the machines already did the rest.

---

## ADLC phase

**P6 — Human Gate**. Consumed directly by the human reviewer during the gate step.
Pairs with `gate-manifest` (C11): manifest proves machine checks passed; behavior-diff
proves observable behavior is within expected bounds.

---

## Verbs

### `capture`

Hit each route in a config file and record the observable HTTP behavior to a JSON
snapshot.

```
behavior-diff capture --config behavior.json --out before.json
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--config <path>` | yes | Path to the behavior config JSON file |
| `--out <path>` | yes | Output path for the snapshot JSON |
| `--json` | no | Print machine-readable result summary to stdout |

**Config format** (`behavior.json`):

```json
{
  "baseUrl": "http://localhost:3000",
  "routes": [
    { "method": "GET", "path": "/health" },
    { "method": "GET", "path": "/api/users" },
    { "method": "POST", "path": "/api/items", "body": { "name": "test" } },
    { "method": "GET", "path": "/api/data", "headers": { "Accept": "application/json" } }
  ]
}
```

Each route: `{ method, path, body?, headers? }`. `body` is serialized as JSON with
`Content-Type: application/json` automatically added.

**Per-route errors are recorded** (as `{ method, path, error }`) without aborting
the run. The snapshot always contains an entry for every route in the config.

**Exit codes for capture:**

| Code | Meaning |
|------|---------|
| `0` | All routes attempted, snapshot written (even if some routes errored) |
| `1` | Operational error: config file unreadable, invalid config, cannot write output |

---

### `compare`

Compare two snapshots and produce a human-readable behavior report.

```
behavior-diff compare before.json after.json [--json]
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--json` | no | Print machine-readable diff result to stdout |

**Output (human-readable):**

```
2 routes identical, 2 changed, 0 errored

  + GET /metrics: route added (absent in before, present in after)
  ~ GET /health:
      body (json): 2 changes:
        ~ version: "1.0.0" → "2.0.0"
        + newField: "added"
  ~ GET /users:
      status: 200 → 503
      body (json): 2 changes:
        - users: [...]
        + error: "Service Unavailable"
```

**Diff rules:**

- Routes matched by `METHOD path`.
- Status change: reported directly.
- Content-type change: reported (parameters like `; charset=utf-8` stripped for comparison).
- JSON bodies: structural recursive diff. Paths use dot notation (`body.items[3].price`).
  Arrays: length change reported + first divergent index drilled. Capped at 50 paths.
- Text/binary bodies: compared by SHA-256 hash.
- Route only in before → "removed". Route only in after → "added".

**Exit codes for compare:**

| Code | Meaning |
|------|---------|
| `0` | Gate passes — all routes identical |
| `1` | Operational error: snapshot file unreadable or invalid JSON |
| `2` | Gate fails — one or more routes changed, removed, or added |

---

## Typical workflow

```bash
# Before the change: capture baseline
behavior-diff capture --config behavior.json --out before.json

# Make your code change, restart the service, then:
behavior-diff capture --config behavior.json --out after.json

# Review behavior diff (exits 0 if clean, 2 if changes found)
behavior-diff compare before.json after.json
```

---

## Snapshot format

```json
{
  "baseUrl": "http://localhost:3000",
  "capturedAt": "2024-01-15T10:30:00.000Z",
  "routes": [
    {
      "method": "GET",
      "path": "/health",
      "status": 200,
      "contentType": "application/json",
      "body": { "status": "ok" }
    },
    {
      "method": "GET",
      "path": "/large-html",
      "status": 200,
      "contentType": "text/html",
      "body": { "textHash": "sha256hex...", "bytes": 4096 }
    },
    {
      "method": "GET",
      "path": "/broken",
      "error": "timeout after 10000ms"
    }
  ]
}
```

- JSON responses: body is parsed and stored as a JSON value.
- Non-JSON responses: body stored as `{ textHash, bytes }`.
- Errors: route stored as `{ method, path, error }` (no status/body).

---

## Future work (noted in spec)

**Browser/headless mode** — render routes via headless browser and diff rendered DOM
or screenshots. Documented as future work; not yet implemented. HTTP fixture mode
(this tool) is the current supported mode.

---

## Core gaps

None. This tool is self-contained and uses only `parseArgs`, `pass`, `gateFail`,
`opError`, and `printJson` from `@adlc/core`. Hashing is done locally via
`node:crypto` rather than the core `sha256` helper to avoid coupling the capture
serialization format to a shared library.

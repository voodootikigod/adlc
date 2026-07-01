# @adlc/docs

Private documentation site for the Agentic Development Lifecycle toolkit.

## Overview

This is the **@adlc/docs** documentation site built with:
- **Framework:** Next.js 15 (App Router)
- **Theme:** An Old Hope (dark-only)
- **Documentation Library:** Fumadocs v16 with built-in search (Orama)
- **Components:** Shared illustrative components (phase diagrams, failure mode visualizations, Mermaid)

## Deployment

Deploy on **Vercel** with:
- **Root Directory:** `apps/docs`

The `vercel.json` in this directory specifies the build command and framework detection.

## Local Development

Install dependencies in the worktree root:
```bash
cd /path/to/adlc
pnpm install
```

Start the dev server:
```bash
npm run dev --workspace @adlc/docs
```

Access at `http://localhost:3000`.

## Build

Build the site:
```bash
npm run build --workspace @adlc/docs
```

Output is in `.next/`.

## Testing

Run the docs logic tests (exemplar pages, theory link resolution, phase diagrams, failure modes):
```bash
node --test apps/docs/test/*.test.mjs
```

Or as part of the full test suite:
```bash
npm test
```

## Documentation Structure

- **Home:** Product-level overview and core concepts
- **Theory:** ADLC principles, lifecycle phases, failure modes
- **Lifecycle:** Gate-by-gate walkthrough with role guidance
- **Toolkit:** Tool reference pages with lifecycle positioning
- **Integrations:** Codex, Claude Code, and platform integrations
- **Reference:** FAQ, glossary, and architectural decision records

## Deployment Notes

- Deployment is **maintainer-triggered** (not automated)
- The docs site is private to the ADLC core team
- Content is versioned with the toolkit (lockstep release)

## License

MIT

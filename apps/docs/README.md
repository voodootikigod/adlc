# @adlc/docs

Documentation site for the Agentic Development Lifecycle (ADLC) toolkit.

> **On "private":** the `@adlc/docs` package sets `"private": true` in `package.json`
> only to keep it **unpublished to npm** — it is a deployable app, not a released
> library. The documentation **content is public**: it documents the open-source
> (MIT) `@adlc` toolkit and is intended to be served publicly and indexed. There is
> no access-control requirement; do not add auth expecting the content to be secret.

## Overview

This is the **@adlc/docs** documentation site built with:
- **Framework:** Next.js 16 (App Router)
- **Theme:** An Old Hope (dark-only)
- **Documentation Library:** Fumadocs v16 with built-in search (Orama)
- **Components:** Shared illustrative components (phase diagrams, failure mode visualizations, Mermaid)

## Deployment

Deploy on **Vercel** with:
- **Root Directory:** `apps/docs`

The `vercel.json` in this directory specifies the build command and framework detection.

## Local Development

> **Requires Node ≥ 20.9** (Next.js 16). This is higher than the rest of the
> `@adlc` repo, whose zero-dependency CLIs support Node ≥ 18 — the floor is
> declared in this app's `package.json` `engines` so the CLIs' Node-18 contract
> is unchanged.

Install dependencies from the repo root (npm workspaces):
```bash
cd /path/to/adlc
npm install
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

## Marketing Site

`@adlc/docs` now serves the ADLC marketing pages at `/` (home, `/lifecycle`,
`/failure-modes`, `/vs-sdlc`, `/toolkit`, `/integrations` and its per-agent
pages, `/enterprise`) alongside Fumadocs at `/docs`, unaffected.

- **`scripts/generate-images.mjs`** — reproducible image-generation pipeline
  for the site's illustrative art. Needs `OPENAI_API_KEY` or `GEMINI_API_KEY`
  in the environment (exits 1 with neither set); output is gitignored and
  regenerated from the checked-in provenance manifest. Use `--force` to
  regenerate existing images and `--only <slug>` to target a single image.
- **`scripts/check-links.mjs <base-url>`** — fetches every URL in the running
  server's `sitemap.xml`, plus four known legacy docs paths, and fails on any
  non-2xx response. It does not crawl in-page links. This is the **cutover
  gate**: run it against a local build before flipping the marketing site live.

## Documentation Structure

- **Home:** Product-level overview and core concepts
- **Theory:** ADLC principles, lifecycle phases, failure modes
- **Lifecycle:** Gate-by-gate walkthrough with role guidance
- **Toolkit:** Tool reference pages with lifecycle positioning
- **Integrations:** Claude Code, Codex, Cursor, OpenCode, Pi, and Antigravity
- **Reference:** conventions, exit codes, the `.adlc/` runtime, and ADRs

## Deployment Notes

- Deployment is **maintainer-triggered** (not automated)
- The docs are **public** documentation for the open-source toolkit; `@adlc/docs`
  is `private` only in the npm sense (unpublished app, not access-controlled content)
- Content is versioned alongside the toolkit

## License

MIT

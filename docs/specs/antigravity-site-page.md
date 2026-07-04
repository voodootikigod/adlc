# Spec — Antigravity docs-site page (closes #66)

**Issue:** `apps/docs/content/docs/integrations/` had pages for claude-code, codex, cursor,
opencode, and pi, but nothing for Antigravity (`agy`), and `index.mdx` was a literal
"coming soon" stub. Real prose already existed at `docs/integrations/antigravity.md` but was
never ported onto the public Fumadocs site.

## Acceptance criteria

- **AC1** — `apps/docs/content/docs/integrations/antigravity.mdx` exists, carries the same
  frontmatter shape (`title` + `description`) as the other five integration pages, and is not
  a "coming soon" stub — it carries the real two-layer rails-guard content ported from
  `docs/integrations/antigravity.md`.
- **AC2** — `apps/docs/content/docs/integrations/meta.json`'s `pages` array includes
  `"antigravity"` alongside the existing five harnesses.
- **AC3** — `apps/docs/content/docs/integrations/index.mdx` is a real landing page (no
  "coming soon" stub) that enumerates and links to all six harness pages (claude-code, codex,
  cursor, opencode, pi, antigravity).
- **AC4** — the docs site still typechecks and builds (Fumadocs MDX + `next build`) with the
  new page and updated nav.

## Verify

```sh
node --test apps/docs/test/*.test.mjs
cd apps/docs && npm run types:check && npm run build
```

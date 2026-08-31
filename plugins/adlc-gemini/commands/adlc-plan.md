---
name: adlc-plan
description: Compile an Antigravity brain implementation plan into ADLC tickets.
---

# /adlc-plan (Antigravity)

Compile an Antigravity brain artifact (`implementation_plan.md`) into ADLC `.adlc/tickets/` shards.

## Usage

1. **Find brain artifacts**:
   ```sh
   npx agb brains
   ```

2. **Compile implementation plan to tickets**:
   ```sh
   npx agb plan <brain-id> /path/to/repo
   ```

3. **Verify generated ticket DAG**:
   ```sh
   adlc ticket list
   npx agb validate plan.json
   ```

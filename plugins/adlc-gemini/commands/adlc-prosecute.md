---
name: adlc-prosecute
description: Execute 5-lens parallel prosecution fan-out via invoke_subagent for Antigravity.
---

# /adlc-prosecute (Antigravity)

Execute the ADLC P5 multi-lens prosecution protocol using Antigravity's native `invoke_subagent` capability.

## Prosecution Workflow

1. **Fan out 5 concurrent subagent lenses** with a single `invoke_subagent` call:
   - `prosecutor-contract`: Verify explicit boundary and interface conformance.
   - `prosecutor-correctness`: Look for algorithmic bugs, error swallowing, and race conditions.
   - `prosecutor-diff`: Verify changes against the ticket's stated acceptance criteria.
   - `prosecutor-security`: Inspect for path injection, unsafe executions, and secret leaks.
   - `prosecutor-tests`: Audit tests to ensure assertions are non-vacuous and kill mutants.

2. **Collect structured findings**: Each lens emits JSON findings conforming to:
   ```json
   {
     "lens": "<lens-name>",
     "findings": [
       {
         "file": "path/to/file",
         "desc": "description of bug",
         "category": "correctness|security|contract|diff|tests",
         "severity": "critical|high|medium|low"
       }
     ],
     "verdict": "ship|block"
   }
   ```

3. **Verify findings**: Dispatch any surviving `critical` or `high` findings to the `prosecutor-verifier` subagent to reproduce or refute.

4. **Bank verified findings** (P5 → P7 bridge):
   ```sh
   adlc prosecute --record-finding --file <file> --desc "<pattern>" --category <cat> --severity <sev>
   ```

5. **Emit final verdict**:
   - `SHIP`: Zero open critical/high findings across all 5 lenses and green rails.
   - `BLOCKED`: Explicit list of reproduced blocker findings.

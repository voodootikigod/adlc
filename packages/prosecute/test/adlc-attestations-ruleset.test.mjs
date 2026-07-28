// Concern: the adlc-attestations branch ruleset must actually be append-only for
// non-bypass actors. A cross-model review round (codex) caught that `non_fast_forward`
// alone blocks force-pushes/history rewrites but NOT an ordinary, everyday fast-forward
// commit that just edits attestations.jsonl to drop a line — `update` is the rule that
// restricts ALL pushes (fast-forward included) to bypass-only actors.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RULESET_PATH = join(new URL('../../../', import.meta.url).pathname, 'docs/github-rulesets/adlc-attestations-ruleset.json');
const ruleset = JSON.parse(readFileSync(RULESET_PATH, 'utf8'));

describe('adlc-attestations-ruleset.json', () => {
  it('targets the adlc-attestations branch specifically', () => {
    assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/adlc-attestations']);
  });

  it('blocks ALL updates for non-bypass actors, not just force-pushes (the ordinary-commit rollback gap)', () => {
    const types = ruleset.rules.map((r) => r.type);
    assert.ok(types.includes('update'), 'ruleset must include an "update" rule — non_fast_forward alone permits an ordinary edit-and-push that drops a line');
    assert.ok(types.includes('non_fast_forward'), 'still block force-push/history rewrite too');
    assert.ok(types.includes('creation'), 'block non-bypass branch (re)creation');
    assert.ok(types.includes('deletion'), 'block non-bypass branch deletion');
  });

  it('the only bypass actor is the real, API-verified GitHub Actions app integration', () => {
    assert.deepEqual(ruleset.bypass_actors, [
      { actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' },
    ]);
  });

  it('enforcement is active, not evaluate-only', () => {
    assert.equal(ruleset.enforcement, 'active');
  });
});

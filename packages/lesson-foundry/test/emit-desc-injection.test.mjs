// A finding's description is reviewer- or model-authored text. It may only
// ever land in generated artifacts as inert text: never as a line of the
// generated gate script, never as an extra SKILL.md frontmatter key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckScript, buildSkillStub } from '../lib/emit.mjs';

const PAYLOADS = [
  "bad thing\nprocess.stdout.write('INJECTED'); process.exit(42);\n//",
  "bad thing\r\nprocess.exit(42);",
  "bad thing\u2028process.exit(42);",
  "bad thing\u2029process.exit(42);",
];

const finding = (desc) => ({ desc, category: 'lint', file: 'a.mjs', line: 1 });

/** Every source line before the first import: must be the shebang, a comment, or blank. */
function headerLines(content) {
  const lines = content.split(/\r\n|[\n\r\u2028\u2029]/);
  return lines.slice(0, lines.findIndex((l) => l.startsWith('import ')));
}

for (const desc of PAYLOADS) {
  test(`check script header stays comment-only for ${JSON.stringify(desc)}`, () => {
    const { content } = buildCheckScript('demo', [finding(desc)]);
    for (const line of headerLines(content)) {
      assert.ok(line === '' || line.startsWith('#!') || line.startsWith('//'), `executable header line: ${JSON.stringify(line)}`);
    }
    assert.match(content, /\/\/ Grep gate: bad thing.*process\.exit\(42\)/);
  });

  test(`SKILL.md frontmatter keeps its fixed keys for ${JSON.stringify(desc)}`, () => {
    const { content } = buildSkillStub('demo', [finding(desc)], null);
    const front = content.split('---')[1];
    const keys = front.split(/\r\n|[\n\r\u2028\u2029]/).filter((l) => /^[A-Za-z-]+:/.test(l)).map((l) => l.split(':')[0]);
    assert.deepEqual(keys, ['name', 'description', 'category', 'mined-from', 'cluster-id', 'cluster-members', 'triggers']);
    assert.match(front, /^description: bad thing.*process\.exit\(42\)/m);
  });
}

test('an LLM-refined description and name are single-lined too', () => {
  const { content } = buildSkillStub('demo', [finding('x')], { name: 'n\ncategory: evil', description: 'd\nmined-from: 999' });
  const front = content.split('---')[1];
  assert.equal((front.match(/^category:/gm) ?? []).length, 1);
  assert.equal((front.match(/^mined-from:/gm) ?? []).length, 1);
});

test('backticks in the description still cannot close a template literal', () => {
  const { content } = buildCheckScript('demo', [finding('a `b` c')]);
  assert.match(content, /\/\/ Grep gate: a 'b' c/);
});

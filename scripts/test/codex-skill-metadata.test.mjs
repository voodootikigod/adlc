import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillsRoot = path.join(repoRoot, 'plugins/adlc-codex/skills');

test('every native Codex skill has valid frontmatter and interface metadata', () => {
  const names = readdirSync(skillsRoot).sort();
  assert.deepEqual(names, ['adlc', 'adlc-distill', 'adlc-init', 'adlc-prosecute', 'adlc-rail-build', 'adlc-spec']);
  for (const name of names) {
    const skill = readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
    const metadata = readFileSync(path.join(skillsRoot, name, 'agents/openai.yaml'), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`), `${name}: frontmatter name`);
    assert.match(skill, /\ndescription: .+\n---\n/, `${name}: frontmatter description`);
    assert.match(metadata, /^interface:\n/m, `${name}: interface root`);
    assert.match(metadata, /  display_name: ".+"/, `${name}: display name`);
    assert.match(metadata, /  short_description: ".{1,64}"/, `${name}: short description`);
    assert.match(metadata, new RegExp(`  default_prompt: ".*\\$${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}.*"`), `${name}: default prompt trigger`);
  }
});

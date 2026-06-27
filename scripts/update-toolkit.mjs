import fs from 'fs';
import path from 'path';

const toolkitPath = 'docs/toolkit.md';
let content = fs.readFileSync(toolkitPath, 'utf-8');

// Use regex to replace \`adlc tool\` with [\`adlc tool\`](./tools/tool.md)
// This requires a bit of parsing since some are in table cells, some in text.
// Or just globally replace \`adlc <tool>\` where <tool> is one of our known tools.

const tools = [
  'behavior-diff', 'cli', 'coldstart', 'consensus-fix', 'core', 'flail-detector',
  'gate-fuzzing', 'gate-manifest', 'hollow-test', 'lesson-foundry', 'merge-forecast',
  'model-ratchet', 'model-router', 'parallax', 'preflight', 'premortem', 'prosecute',
  'rails-guard', 'rejection-mining', 'review-calibration', 'runner', 'skill-rot', 'spec-lint'
];

for (const tool of tools) {
  // Replace `adlc tool`
  const regex = new RegExp(`\\\`adlc ${tool}\\\``, 'g');
  content = content.replace(regex, `[\`adlc ${tool}\`](./tools/${tool}.md)`);
}

fs.writeFileSync(toolkitPath, content);
console.log('Updated docs/toolkit.md');

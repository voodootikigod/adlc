import { GROUPS, TOOLS } from './registry.mjs';

export function renderHelp(version) {
  const lines = [];
  lines.push(`adlc ${version} - Agentic Development Lifecycle toolkit dispatcher`);
  lines.push('');
  lines.push('Usage:');
  lines.push('  adlc <tool> [args...]       run an ADLC tool');
  lines.push('  adlc run <phase> [args...]  assert phase evidence');
  lines.push('  adlc accept [args...]       record P6 acceptance evidence');
  lines.push('  adlc --help                 this help');
  lines.push('  adlc --version              print the dispatcher version');
  lines.push('');
  lines.push('Exit codes mirror the routed tool: 0 = pass, 1 = operational error, 2 = gate fail.');
  lines.push('');
  lines.push(`Tools (${TOOLS.length}):`);

  const width = Math.max(...TOOLS.map((tool) => tool.name.length));
  for (const group of GROUPS) {
    lines.push('');
    lines.push(`  ${group.title}`);
    for (const tool of group.tools) {
      lines.push(`    ${tool.name.padEnd(width)}  ${tool.summary}`);
    }
  }

  return lines.join('\n');
}

// help.mjs — render the dispatcher's top-level help: usage, then every tool
// grouped by ADLC cluster. Pure string building; no I/O.

import { GROUPS, TOOLS } from './registry.mjs';

/**
 * @param {string} version  The dispatcher's version, for the header.
 * @returns {string}
 */
export function renderHelp(version) {
  const lines = [];
  lines.push(`adlc ${version} — Agentic Development Lifecycle toolkit dispatcher`);
  lines.push('');
  lines.push('Usage:');
  lines.push('  adlc <tool> [args...]   run an ADLC tool (args pass through verbatim)');
  lines.push('  adlc <tool> --help      help for a specific tool');
  lines.push('  adlc --help             this help');
  lines.push('  adlc --version          print the dispatcher version');
  lines.push('');
  lines.push(`Exit codes mirror the tool: 0 = gate passes · 1 = operational error · 2 = gate fails.`);
  lines.push('');
  lines.push(`Tools (${TOOLS.length}):`);

  const width = Math.max(...TOOLS.map((t) => t.name.length));
  for (const group of GROUPS) {
    lines.push('');
    lines.push(`  ${group.title}`);
    for (const t of group.tools) {
      lines.push(`    ${t.name.padEnd(width)}  ${t.summary}`);
    }
  }
  return lines.join('\n');
}

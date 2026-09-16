// mcp-spawn.mjs — shell-free launch resolution for the Cursor MCP child.

import { accessSync, constants, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function isRunnableFile(path) {
  try {
    const stat = statSync(path);
    accessSync(path, constants.R_OK);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function nodeModulesForPrefix(prefix, platform) {
  if (platform === 'win32') {
    return [join(prefix, 'node_modules')];
  }
  return [join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules')];
}

function npmGlobalRoots(env, platform, execPath) {
  const roots = [];
  const add = (root) => {
    if (root && !roots.includes(root)) {
      roots.push(root);
    }
  };
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (prefix) {
    for (const root of nodeModulesForPrefix(prefix, platform)) {
      add(root);
    }
  }

  const binDir = dirname(execPath);
  if (platform === 'win32') {
    add(join(binDir, 'node_modules'));
    if (env.APPDATA) {
      add(join(env.APPDATA, 'npm', 'node_modules'));
    }
  } else {
    add(join(binDir, '..', 'lib', 'node_modules'));
    add(join(binDir, 'node_modules'));
  }

  if (env.NODE_PATH) {
    for (const root of env.NODE_PATH.split(platform === 'win32' ? ';' : ':')) {
      add(root);
    }
  }
  if (env.VOLTA_HOME) {
    // Volta installs the package entry under its package-image dependency tree:
    // <VOLTA_HOME>/tools/image/packages/@adlc/cli/node_modules/@adlc/cli/bin/adlc.mjs
    add(join(env.VOLTA_HOME, 'tools', 'image', 'packages', '@adlc', 'cli', 'node_modules'));
  }
  if (env.PNPM_HOME) {
    // pnpm's global virtual store is versioned (for example global/5). Keep
    // this bounded to its standard layout instead of interpreting a shim.
    for (const version of ['5', '6', '7', '8', '9', '10']) {
      add(join(env.PNPM_HOME, 'global', version, 'node_modules'));
    }
  }
  return roots;
}

function entryAt(nodeModules) {
  return join(nodeModules, '@adlc', 'cli', 'bin', 'adlc.mjs');
}

/**
 * Resolve the frozen CLI MCP entrypoint without invoking a Windows `.cmd` shim.
 *
 * npm's Windows shims run Node against a JavaScript entrypoint. Spawning that
 * shim directly is not safe: Node refuses `.cmd` without a shell after
 * CVE-2024-27980 hardening, while a shell would re-parse JSON-RPC-derived argv.
 * Resolve the package's JavaScript bin and run it through this Node instead.
 *
 * `npm_config_prefix`, NODE_PATH, Volta and pnpm's documented global layout are
 * all paths that can supply the CLI to Cursor without being beside node.exe.
 * Every candidate is returned in `probed` to make a missing global install
 * actionable, rather than looking like an MCP protocol failure.
 */
export function resolveAdlcMcpSpawn(
  env = process.env,
  platform = process.platform,
  { execPath = process.execPath, isFile = isRunnableFile } = {},
) {
  if (env.ADLC_CLI_BIN) {
    return {
      command: execPath,
      args: [env.ADLC_CLI_BIN, 'mcp-server'],
      resolved: true,
      probed: [env.ADLC_CLI_BIN],
    };
  }

  const probed = [];
  for (const nodeModules of npmGlobalRoots(env, platform, execPath)) {
    const entry = entryAt(nodeModules);
    probed.push(entry);
    if (isFile(entry)) {
      return { command: execPath, args: [entry, 'mcp-server'], resolved: true, probed };
    }
  }

  if (platform !== 'win32') {
    return {
      command: 'adlc',
      args: ['mcp-server'],
      resolved: false,
      probed,
      diagnostic: `ADLC MCP CLI was not found in the Node/npm global locations (${probed.join(', ')}); falling back to adlc on PATH`,
    };
  }

  return {
    command: null,
    args: [],
    resolved: false,
    probed,
    diagnostic: `ADLC MCP CLI was not found in the Node/npm global locations (${probed.join(', ')}). Install @adlc/cli globally for the Node Cursor uses, or set ADLC_CLI_BIN to its adlc.mjs entrypoint`,
  };
}

#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'install';

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
ADLC Google Antigravity Plugin Helper

Usage:
  npx adlc-agy install             Install and register the ADLC plugin with agy
  npx @adlc/antigravity install    Alternative package name invocation
  adlc-agy install                 Install when @adlc/antigravity is installed globally
  adlc-agy --help                  Display this help message

Description:
  Registers the @adlc/antigravity plugin with Google Antigravity (agy).
  First attempts to run \`agy plugin install <path>\`. If agy is not found,
  copies the plugin to ~/.gemini/config/plugins/adlc-antigravity.
`);
  process.exit(0);
}

if (command === 'install' || command === '--install') {
  console.log(`Installing @adlc/antigravity plugin from: ${packageRoot}`);

  let agyInstalled = false;
  try {
    const res = spawnSync('agy', ['--version'], { encoding: 'utf8' });
    if (res.status === 0) {
      agyInstalled = true;
    }
  } catch {
    agyInstalled = false;
  }

  if (agyInstalled) {
    console.log('Google Antigravity (agy) detected. Running agy plugin install...');
    const result = spawnSync('agy', ['plugin', 'install', packageRoot], {
      stdio: 'inherit',
    });
    if (result.status === 0) {
      console.log('✓ Successfully installed @adlc/antigravity plugin via agy!');
      process.exit(0);
    } else {
      console.error('⚠️ `agy plugin install` returned non-zero status.');
    }
  }

  // Fallback / manual placement into plugin dir
  const targetDir = join(homedir(), '.gemini', 'config', 'plugins', 'adlc-antigravity');
  console.log(`Copying plugin files directly to ${targetDir}...`);
  try {
    mkdirSync(targetDir, { recursive: true });
    cpSync(packageRoot, targetDir, { recursive: true });
    console.log(`✓ Plugin copied to ${targetDir}`);
    console.log('Note: Run `/adlc-init` inside your agent session to complete setup.');
    process.exit(0);
  } catch (err) {
    console.error(`Failed to copy plugin files to ${targetDir}:`, err.message);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run `npx adlc-agy --help` for available commands.');
  process.exit(1);
}

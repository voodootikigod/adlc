#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const command = args[0] || 'install';

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
ADLC Pi Extension Helper

Usage:
  npx adlc-pi install             Install the ADLC extension into Pi (per-project -l)
  npx adlc-pi install --global    Install globally for all Pi projects
  adlc-pi --help                  Display this help message

Description:
  Registers @adlc/pi with the pi coding agent.
  Runs \`pi install -l npm:@adlc/pi\` by default, or \`pi install npm:@adlc/pi\` with --global.
`);
  process.exit(0);
}

if (command === 'install' || command === '--install') {
  const isGlobal = args.includes('--global') || args.includes('-g');
  const installArgs = isGlobal
    ? ['install', 'npm:@adlc/pi']
    : ['install', '-l', 'npm:@adlc/pi'];

  console.log(`Installing @adlc/pi via: pi ${installArgs.join(' ')}`);

  let piInstalled = false;
  try {
    const res = spawnSync('pi', ['--version'], { encoding: 'utf8' });
    if (res.status === 0) {
      piInstalled = true;
    }
  } catch {
    piInstalled = false;
  }

  if (piInstalled) {
    const result = spawnSync('pi', installArgs, { stdio: 'inherit' });
    if (result.status === 0) {
      console.log('✓ Successfully installed @adlc/pi extension in Pi!');
      process.exit(0);
    } else {
      console.error('⚠️ `pi install` returned a non-zero exit status.');
      process.exit(result.status || 1);
    }
  } else {
    console.error('⚠️ `pi` command not found in PATH.');
    console.error('Install pi first, then run: pi install -l npm:@adlc/pi');
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run `npx adlc-pi --help` for available commands.');
  process.exit(1);
}

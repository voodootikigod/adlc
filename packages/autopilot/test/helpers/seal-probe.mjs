import { realpathSync, writeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { active, activeSeams, enable, seamsSealed } from '../../lib/mutations.mjs';

// Guarantee synchronous stdout output so piped spawnSync cannot lose buffered help text before process.exit
console.log = (...args) => {
  writeSync(1, args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
};

enable('keys.leakKey');

process.on('exit', () => {
  let enableRefused = false;
  try {
    enable('keys.leakKey');
  } catch {
    enableRefused = true;
  }
  const payload = {
    sealed: seamsSealed(),
    active: active('keys.leakKey'),
    activeSeams: activeSeams(),
    enableRefused,
  };
  writeSync(2, `seal-probe ${JSON.stringify(payload)}\n`);
});

const binPath = realpathSync(fileURLToPath(new URL('../../bin/adlc-autopilot.mjs', import.meta.url)));
process.argv[1] = binPath;
await import(pathToFileURL(binPath).href);

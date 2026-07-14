import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export function fsyncFile(path) {
  // Open read-WRITE: Windows FlushFileBuffers (what fsyncSync maps to) requires a
  // handle with write access and returns EPERM on a read-only ('r') handle. 'r+'
  // works identically on POSIX and lets file-content durability hold on both.
  const descriptor = openSync(path, 'r+');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

// Node cannot portably open directory handles on Windows. File contents are still
// flushed there; POSIX platforms additionally persist directory-entry changes.
export function fsyncDirectory(path) {
  if (process.platform === 'win32') return false;
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  return true;
}

export function durableMkdir(path) {
  const missing = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(path, { recursive: true });
  if (missing.length === 0) {
    fsyncDirectory(resolve(path));
    return;
  }
  for (const directory of missing.reverse()) {
    fsyncDirectory(directory);
    fsyncDirectory(dirname(directory));
  }
}

export function durableWrite(path, content) {
  const descriptor = openSync(path, 'w');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  fsyncDirectory(dirname(resolve(path)));
}

export function durableCopy(source, target) {
  copyFileSync(source, target);
  fsyncFile(target);
  fsyncDirectory(dirname(resolve(target)));
}

export function durableRename(source, target) {
  const sourceParent = dirname(resolve(source));
  const targetParent = dirname(resolve(target));
  renameSync(source, target);
  fsyncDirectory(targetParent);
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent);
}

export function durableRemove(path, options) {
  const parent = dirname(resolve(path));
  rmSync(path, options);
  fsyncDirectory(parent);
}

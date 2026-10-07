// Preloaded into every CLI the suite spawns: reaching fetch ends the process
// with a status no real code path produces, so the calling test fails.
globalThis.fetch = () => {
  process.stderr.write('decision-layer test: fetch was called\n');
  process.exit(97);
};

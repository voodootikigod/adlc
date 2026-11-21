import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSyntaxDetail, resolveTypeScript, syntaxCheckProblem } from '../lib/syntax.mjs';

describe('T-P07: TypeScript resolution and syntax probing run strictly in a sanitized child process', () => {
  it('poisoned candidate node_modules/typescript cannot read parent ADLC_MANIFEST_KEY or mutate parent globals', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-ts-isolate-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const tsDir = join(dir, 'node_modules', 'typescript');
    mkdirSync(tsDir, { recursive: true });
    const leakFile = join(dir, 'leaked.json');
    writeFileSync(join(tsDir, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.0', main: 'index.js' }));
    writeFileSync(join(tsDir, 'index.js'), `
      const fs = require('node:fs');
      globalThis.__ADLC_POISONED_PARENT__ = true;
      fs.writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({
        manifestKey: process.env.ADLC_MANIFEST_KEY ?? null,
        pid: process.pid,
      }));
      module.exports = {
        version: '5.9.0',
        ScriptTarget: { Latest: 99 },
        JsxEmit: { Preserve: 1 },
        createSourceFile: (name) => ({ fileName: name }),
        createProgram: ({ rootNames }) => ({
          getSourceFile: (n) => (n === rootNames[0] ? { fileName: n } : undefined),
          getSyntacticDiagnostics: () => [],
        }),
      };
    `);
    const sampleTs = join(dir, 'sample.ts');
    writeFileSync(sampleTs, 'export const x: number = 1;\n');

    const prevKey = process.env.ADLC_MANIFEST_KEY;
    delete globalThis.__ADLC_POISONED_PARENT__;
    process.env.ADLC_MANIFEST_KEY = 'TOP_SECRET_MANIFEST_KEY_FOR_TP07';
    try {
      const resolved = resolveTypeScript(sampleTs);
      assert.ok(resolved, 'worker should resolve candidate typescript');
      assert.equal(resolved.version, '5.9.0');
      assert.equal(globalThis.__ADLC_POISONED_PARENT__, undefined, 'candidate typescript must never execute in parent process');
      const leak = JSON.parse(readFileSync(leakFile, 'utf8'));
      assert.equal(leak.manifestKey, null, 'ADLC_MANIFEST_KEY must be scrubbed from probe worker env');
      assert.notEqual(leak.pid, process.pid, 'probe must execute in a child process');

      assert.equal(syntaxCheckProblem(sampleTs), null);
      const detail = checkSyntaxDetail(sampleTs, dir);
      assert.equal(detail.verdict, 'valid');
      const leakAfterCheck = JSON.parse(readFileSync(leakFile, 'utf8'));
      assert.equal(leakAfterCheck.manifestKey, null, 'ADLC_MANIFEST_KEY must be scrubbed from syntax-check worker env');
    } finally {
      if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
      else process.env.ADLC_MANIFEST_KEY = prevKey;
      delete globalThis.__ADLC_POISONED_PARENT__;
    }
  });
});

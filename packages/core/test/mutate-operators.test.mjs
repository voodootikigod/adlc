import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { generateMutants, maskStringLiterals, OPERATORS } from '../lib/mutate.mjs';
import { createTypeScriptSyntaxWorker } from '../lib/syntax.mjs';

test('maskStringLiterals blanks quoted and template contents while preserving length', () => {
  const line = `const s = "a === b && true"; const t = \`x ?? y \${a === b}\`; if (a === b) return true;`;
  const masked = maskStringLiterals(line);
  assert.equal(masked.length, line.length);
  assert.ok(!masked.includes('true";'));
  assert.ok(!masked.includes('??'));
  assert.ok(masked.includes('${a === b}'), 'executable template interpolation remains visible for mutation');
  assert.ok(masked.includes('if (a === b) return true;'));
});

test('operators ignore string/template literals and splice single offset spans instead of /g', () => {
  // Two === on one line: only the FIRST non-string === is mutated
  const multi = 'const ok = a === 1 && b === 2;';
  const invOp = OPERATORS.find((o) => o.name === 'invert-comparison');
  assert.equal(invOp.apply(multi), 'const ok = a !== 1 && b === 2;');

  // Comparison / boolean inside string literal must not be mutated
  const strOnly = 'const msg = "a === b && true";';
  assert.equal(invOp.apply(strOnly), null);
  const boolOp = OPERATORS.find((o) => o.name === 'bool-flip');
  assert.equal(boolOp.apply(strOnly), null);

  // ?? operator mutated by logic-swap
  const logicOp = OPERATORS.find((o) => o.name === 'logic-swap');
  assert.equal(logicOp.apply('const v = a ?? b;'), 'const v = a && b;');

  // if (!expr) -> if (expr) mutated by negate-guard-subclause
  const negOp = OPERATORS.find((o) => o.name === 'negate-guard-subclause');
  assert.equal(negOp.apply('if (!ready) return;'), 'if (ready) return;');
  assert.equal(negOp.apply('if (!cfg.enabled) return;'), 'if (cfg.enabled) return;');

  const mutants = generateMutants('if (!ready) return a ?? b;\n');
  assert.ok(mutants.some((m) => m.operator === 'negate-guard-subclause' && m.mutated === 'if (ready) return a ?? b;'));
  assert.ok(mutants.some((m) => m.operator === 'logic-swap' && m.mutated === 'if (!ready) return a && b;'));
});

test('createTypeScriptSyntaxWorker checks multiple TypeScript files over one persistent worker', async (t) => {
  const dir = tmp(t, 'ts-worker-');
  const validFile = join(dir, 'ok.ts');
  const invalidFile = join(dir, 'bad.ts');
  writeFileSync(validFile, 'export const add = (a: number, b: number): number => a + b;\n');
  writeFileSync(invalidFile, 'export const broken: number = (;\n');

  const worker = createTypeScriptSyntaxWorker();
  try {
    const repoTs = fileURLToPath(new URL('../../../plugins/adlc-pi/index.ts', import.meta.url));
    const r1 = await worker.check(repoTs);
    assert.equal(r1.verdict, 'valid');
    // Unresolvable TS from /tmp returns unknown cleanly
    const r2 = await worker.check(validFile);
    assert.ok(['valid', 'unknown'].includes(r2.verdict));
  } finally {
    worker.close();
  }
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractPolyglotSpecifiers, resolvePolyglotCandidates } from '../lib/polyglot-imports.mjs';
import { signalImportRadius, signalMigrationCollision, walkTree } from '../lib/signals.mjs';
import { runForecast } from '../lib/forecast.mjs';

function makeTmpDir(t, prefix = 'mf-polyglot-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRel(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('polyglot-imports: workspace specifiers', () => {
  test('resolves bare @scope/pkg via exports["."] object/default/string, main, index.mjs, and subpaths', (t) => {
    const root = makeTmpDir(t);
    writeRel(
      root,
      'packages/alpha/package.json',
      JSON.stringify({
        name: '@acme/alpha',
        exports: { '.': { import: './esm/entry.mjs', default: './cjs/entry.cjs' }, './utils': './lib/utils.mjs' },
      }),
    );
    writeRel(root, 'packages/alpha/esm/entry.mjs', 'export const a = 1;\n');
    writeRel(root, 'packages/alpha/lib/utils.mjs', 'export const u = 2;\n');

    writeRel(
      root,
      'packages/defpkg/package.json',
      JSON.stringify({ name: '@acme/defpkg', exports: { '.': { default: './lib/def.mjs' } } }),
    );
    writeRel(root, 'packages/beta/package.json', JSON.stringify({ name: '@acme/beta', main: 'dist/main.js' }));
    writeRel(root, 'packages/gamma/package.json', JSON.stringify({ name: '@acme/gamma' }));
    writeRel(root, 'packages/escape/package.json', JSON.stringify({ name: '@acme/escape', main: '../../outside.js' }));

    writeRel(
      root,
      'packages/consumer/lib/run.mjs',
      "import { a } from '@acme/alpha';\nconst u = require('@acme/alpha/utils');\nimport '@acme/gamma/helper';\n",
    );

    const specs = extractPolyglotSpecifiers(
      "import { a } from '@acme/alpha';\nconst u = require('@acme/alpha/utils');\nimport '@acme/gamma/helper';\n",
      'packages/consumer/lib/run.mjs',
    );
    assert.deepEqual(specs, ['@acme/alpha', '@acme/alpha/utils', '@acme/gamma/helper']);

    assert.deepEqual(resolvePolyglotCandidates('@acme/alpha', 'packages/consumer/lib/run.mjs', root), [
      'packages/alpha/esm/entry.mjs',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('@acme/defpkg', 'packages/consumer/lib/run.mjs', root), [
      'packages/defpkg/lib/def.mjs',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('@acme/beta', 'packages/consumer/lib/run.mjs', root), [
      'packages/beta/dist/main.js',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('@acme/gamma', 'packages/consumer/lib/run.mjs', root), [
      'packages/gamma/index.mjs',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('@acme/escape', 'packages/consumer/lib/run.mjs', root), []);
    assert.deepEqual(resolvePolyglotCandidates('@acme/unknown', 'packages/consumer/lib/run.mjs', root), []);

    const subMapped = resolvePolyglotCandidates('@acme/alpha/utils', 'packages/consumer/lib/run.mjs', root);
    assert.ok(subMapped.includes('packages/alpha/lib/utils.mjs'));

    const subFallback = resolvePolyglotCandidates('@acme/gamma/helper', 'packages/consumer/lib/run.mjs', root);
    assert.ok(subFallback.includes('packages/gamma/helper.mjs'));
    assert.ok(subFallback.includes('packages/gamma/helper.js'));
    assert.ok(subFallback.includes('packages/gamma/helper.ts'));

    const repoFiles = walkTree(root);
    const tConsumer = { id: 'T1', title: 'consumer', scope: ['packages/consumer/**'] };
    const tAlpha = { id: 'T2', title: 'alpha', scope: ['packages/alpha/**'] };
    assert.equal(signalImportRadius(tConsumer, tAlpha, repoFiles, root), 0.6);
  });
});

describe('polyglot-imports: Python and Rust', () => {
  test('detects Python relative and dotted root/src imports via signalImportRadius', (t) => {
    const root = makeTmpDir(t);
    const pySource = [
      'from .helpers import render # inline comment',
      'from . import local_mod',
      'from ..shared import common',
      'from core.db import query',
      'import billing.ledger',
    ].join('\n');
    writeRel(root, 'app/api/views.py', pySource);
    writeRel(root, 'app/api/helpers.py', 'def render(): pass\n');
    writeRel(root, 'app/shared.py', 'def common(): pass\n');
    writeRel(root, 'src/core/db/__init__.py', 'def query(): pass\n');
    writeRel(root, 'billing/ledger.py', 'def charge(): pass\n');

    assert.deepEqual(extractPolyglotSpecifiers(pySource, 'app/api/views.py'), [
      '.helpers',
      '.local_mod',
      '..shared',
      'core.db',
      'billing.ledger',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('.helpers', 'app/api/views.py', root), [
      'app/api/helpers.py',
      'app/api/helpers/__init__.py',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('..shared', 'app/api/views.py', root), [
      'app/shared.py',
      'app/shared/__init__.py',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('....escaped', 'app/api/views.py', root), []);
    assert.deepEqual(resolvePolyglotCandidates('core.db', 'app/api/views.py', root), [
      'core/db.py',
      'core/db/__init__.py',
      'src/core/db.py',
      'src/core/db/__init__.py',
    ]);

    const repoFiles = walkTree(root);
    const views = { id: 'A', scope: ['app/api/views.py'] };
    assert.equal(signalImportRadius(views, { id: 'B', scope: ['app/api/helpers.py'] }, repoFiles, root), 0.6);
    assert.equal(signalImportRadius(views, { id: 'C', scope: ['src/core/**'] }, repoFiles, root), 0.6);
  });

  test('detects Rust mod declarations and crate:: paths relative to nearest ancestor src or dirname', (t) => {
    const root = makeTmpDir(t);
    const rsSource = 'pub mod validator;\nuse crate::storage::repo;\nuse crate::api::{routes, auth};\n';
    writeRel(root, 'crates/engine/src/handlers/order.rs', rsSource);
    writeRel(root, 'crates/engine/src/handlers/validator/mod.rs', 'pub fn check() {}\n');
    writeRel(root, 'crates/engine/src/storage.rs', 'pub mod repo {}\n');

    assert.deepEqual(extractPolyglotSpecifiers(rsSource, 'crates/engine/src/handlers/order.rs'), [
      'validator', 'crate::storage::repo', 'crate::api', 'crate::api::routes', 'crate::api::auth',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('validator', 'crates/engine/src/handlers/order.rs', root), [
      'crates/engine/src/handlers/validator.rs', 'crates/engine/src/handlers/validator/mod.rs',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('crate::storage::repo', 'crates/engine/src/handlers/order.rs', root), [
      'crates/engine/src/storage/repo.rs', 'crates/engine/src/storage/repo/mod.rs', 'crates/engine/src/storage.rs',
    ]);
    assert.deepEqual(resolvePolyglotCandidates('crate::helper::setup', 'tests/smoke.rs', root), [
      'tests/helper/setup.rs', 'tests/helper/setup/mod.rs', 'tests/helper.rs',
    ]);

    const repoFiles = walkTree(root);
    const rsOrder = { id: 'RS1', scope: ['crates/engine/src/handlers/order.rs'] };
    assert.equal(signalImportRadius(rsOrder, { id: 'RS2', scope: ['crates/engine/src/handlers/validator/**'] }, repoFiles, root), 0.6);
    assert.equal(signalImportRadius(rsOrder, { id: 'RS3', scope: ['crates/engine/src/storage.rs'] }, repoFiles, root), 0.6);
  });
});

describe('polyglot migration collisions and unrailed edge contracts', () => {
  test('detects Prisma, Flyway, Alembic, and Supabase migration prefix collisions across distinct files', () => {
    const prismaFiles = [
      'prisma/migrations/20260501_add_users/migration.sql',
      'prisma/migrations/20260501_add_teams/migration.sql',
    ];
    assert.equal(
      signalMigrationCollision(
        { id: 'A', scope: ['prisma/migrations/20260501_add_users/**'] },
        { id: 'B', scope: ['prisma/migrations/20260501_add_teams/**'] },
        prismaFiles,
      ),
      true,
    );

    const flywayFiles = ['migrations/V042__init_auth.sql', 'supabase/migrations/042_init_rls.sql'];
    assert.equal(
      signalMigrationCollision(
        { id: 'A', scope: ['migrations/**'] },
        { id: 'B', scope: ['supabase/migrations/**'] },
        flywayFiles,
      ),
      true,
    );

    const sameFileOnly = ['alembic/versions/0010_base.py'];
    assert.equal(
      signalMigrationCollision(
        { id: 'A', scope: ['alembic/versions/**'] },
        { id: 'B', scope: ['alembic/versions/0010_base.py'] },
        sameFileOnly,
      ),
      false,
    );
  });

  test('runForecast warns when edge.contract is not covered by targetTicket.rails', async (t) => {
    const root = makeTmpDir(t);
    writeRel(root, 'src/producer.mjs', 'export const x = 1;\n');
    writeRel(root, 'src/consumer.mjs', 'export const y = 2;\n');
    writeRel(root, 'src/covered.mjs', 'export const z = 3;\n');

    const tickets = [
      {
        id: 'T-SRC',
        title: 'Producer',
        scope: ['src/producer.mjs'],
        edges: [
          { to: 'T-UNRAILED', contract: '  src/types/shared.d.ts  ' },
          { to: 'T-RAILED', contract: 'src/types/covered.d.ts' },
        ],
      },
      { id: 'T-UNRAILED', title: 'Unrailed', scope: ['src/consumer.mjs'], rails: ['test/consumer.test.mjs'] },
      { id: 'T-RAILED', title: 'Railed', scope: ['src/covered.mjs'], rails: ['src/types/**'] },
    ];

    const res = await runForecast({ tickets, root });
    assert.ok(
      res.warnings.includes(
        "Unrailed edge contract: T-SRC -> T-UNRAILED contract 'src/types/shared.d.ts' is not covered by T-UNRAILED rails",
      ),
    );
    assert.ok(!res.warnings.some((w) => w.includes('T-RAILED')));
  });
});

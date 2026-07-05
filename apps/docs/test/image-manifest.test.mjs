import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest, validateManifest } from '../lib/image-manifest.mjs';

test('checked-in manifest is valid', () => {
  const result = validateManifest(loadManifest());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('validator rejects duplicate slugs', () => {
  const bad = {
    styleGuide: 'x'.repeat(60),
    images: [
      { slug: 'a', size: '1024x1024', placement: 'p', prompt: 'y'.repeat(30) },
      { slug: 'a', size: '1024x1024', placement: 'p', prompt: 'y'.repeat(30) },
    ],
  };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate slug')));
});

test('validator rejects malformed sizes and empty prompts', () => {
  const bad = {
    styleGuide: 'x'.repeat(60),
    images: [{ slug: 'b', size: 'huge', placement: 'p', prompt: '' }],
  };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('size')));
  assert.ok(result.errors.some((e) => e.includes('prompt')));
});

test('hero-backdrop is present (landing page depends on the slug)', () => {
  const manifest = loadManifest();
  assert.ok(manifest.images.some((i) => i.slug === 'hero-backdrop'));
});

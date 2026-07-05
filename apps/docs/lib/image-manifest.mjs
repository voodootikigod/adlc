import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = path.join(__dirname, '..', 'assets', 'images.json');

// gpt-image-1 only accepts these three sizes; Gemini output is resized to match
// at use time, so the manifest — the shared contract for both providers — is
// restricted to this set rather than any arbitrary WxH pair.
export const VALID_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

export function validateManifest(manifest) {
  const errors = [];
  if (typeof manifest?.styleGuide !== 'string' || manifest.styleGuide.length < 40) {
    errors.push('styleGuide missing or too short to art-direct anything');
  }
  const images = Array.isArray(manifest?.images) ? manifest.images : [];
  if (images.length === 0) errors.push('images array empty');
  const seen = new Set();
  for (const img of images) {
    const tag = img?.slug ?? '<missing slug>';
    if (!img?.slug || !/^[a-z0-9-]+$/.test(img.slug)) errors.push(`${tag}: bad slug`);
    if (seen.has(img?.slug)) errors.push(`duplicate slug: ${tag}`);
    seen.add(img?.slug);
    if (!VALID_SIZES.includes(img?.size)) {
      errors.push(`${tag}: bad size (must be one of ${VALID_SIZES.join(', ')})`);
    }
    if (typeof img?.placement !== 'string' || img.placement.length === 0) errors.push(`${tag}: missing placement`);
    if (typeof img?.prompt !== 'string' || img.prompt.length < 20) errors.push(`${tag}: prompt missing or too short`);
  }
  return { ok: errors.length === 0, errors };
}

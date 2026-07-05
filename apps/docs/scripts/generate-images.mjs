// Usage: node apps/docs/scripts/generate-images.mjs [--force] [--only <slug>]
// Requires OPENAI_API_KEY (gpt-image-1) or GEMINI_API_KEY (Nano Banana / Gemini image).
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadManifest, validateManifest, MANIFEST_PATH } from '../lib/image-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'generated');

const force = process.argv.includes('--force');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];

const OPENAI_MODEL = 'gpt-image-1';
const GEMINI_MODEL = 'gemini-2.5-flash-image';

function pickProvider() {
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: OPENAI_MODEL };
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', model: GEMINI_MODEL };
  console.error('No OPENAI_API_KEY or GEMINI_API_KEY set — cannot generate. The site builds fine without images (gradient fallbacks).');
  process.exit(1);
}

async function generateOpenAI(prompt, size) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    // gpt-image-1 accepts only 1024x1024, 1536x1024, 1024x1536 — the manifest sticks to these.
    body: JSON.stringify({ model: OPENAI_MODEL, prompt, size, n: 1 }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Buffer.from(data.data[0].b64_json, 'base64');
}

async function generateGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error('gemini returned no image data');
  return Buffer.from(part.inlineData.data, 'base64');
}

const manifest = loadManifest();
const check = validateManifest(manifest);
if (!check.ok) {
  console.error('Manifest invalid:\n' + check.errors.join('\n'));
  process.exit(1);
}

const { provider, model } = pickProvider();
mkdirSync(outDir, { recursive: true });

const failures = [];

for (const img of manifest.images) {
  if (only && img.slug !== only) continue;
  const outFile = path.join(outDir, `${img.slug}.png`);
  if (existsSync(outFile) && !force) {
    console.log(`skip ${img.slug} (exists; --force to regenerate)`);
    continue;
  }
  const prompt = `${manifest.styleGuide}\n\n${img.prompt}`;
  console.log(`generating ${img.slug} via ${provider}/${model}...`);
  try {
    const buf = provider === 'openai' ? await generateOpenAI(prompt, img.size) : await generateGemini(prompt);
    writeFileSync(outFile, buf);
    img.provenance = { provider, model, generatedAt: new Date().toISOString().slice(0, 10) };
    console.log(`wrote ${outFile} (${buf.length} bytes)`);
  } catch (err) {
    failures.push(img.slug);
    console.error(`failed ${img.slug}: ${err.message}`);
  }
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest provenance updated');

if (failures.length > 0) {
  console.error(`${failures.length} image(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}

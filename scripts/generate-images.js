#!/usr/bin/env node

// ============================================================================
// Follow Builders — Scene Image Generator (personal extension, v1 demo)
// ============================================================================
// Generates one illustration per script segment via OpenRouter's Image API,
// for use as Ken Burns background scenes in the video demo.
//
// Usage:
//   node generate-images.js <segments.json> <output-dir>
//
// segments.json: [{ "id": "seg1", "prompt": "..." }, ...]
// Reads OPENROUTER_API_KEY from the project root .env.
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(scriptDir, '..', '.env');

const IMAGES_ENDPOINT = 'https://openrouter.ai/api/v1/images';
const MODEL = 'google/gemini-3.1-flash-image';

async function main() {
  loadEnv({ path: ENV_PATH });

  const [segmentsPath, outDir] = process.argv.slice(2);
  if (!segmentsPath || !outDir) {
    console.error('Usage: node generate-images.js <segments.json> <output-dir>');
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(`OPENROUTER_API_KEY not found in ${ENV_PATH}. Add it there and try again.`);
    process.exit(1);
  }

  const segments = JSON.parse(await readFile(segmentsPath, 'utf-8'));
  await mkdir(outDir, { recursive: true });

  const results = [];
  for (const seg of segments) {
    process.stderr.write(`Generating ${seg.id}...\n`);
    const res = await fetch(IMAGES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: seg.prompt,
        aspect_ratio: '16:9',
        resolution: '2K',
        n: 1
      })
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Image API error for ${seg.id} (${res.status}): ${errBody}`);
    }

    const json = await res.json();
    const img = json.data?.[0];
    if (!img?.b64_json) {
      throw new Error(`No image returned for ${seg.id}: ${JSON.stringify(json)}`);
    }

    const outPath = join(outDir, `${seg.id}.png`);
    await writeFile(outPath, Buffer.from(img.b64_json, 'base64'));
    if (json.usage?.cost !== undefined) {
      process.stderr.write(`  cost: $${json.usage.cost}\n`);
    }
    results.push({ id: seg.id, path: outPath });
  }

  console.log(JSON.stringify({ status: 'ok', images: results }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});

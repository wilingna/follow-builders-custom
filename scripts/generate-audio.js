#!/usr/bin/env node

// ============================================================================
// Follow Builders — Shadowing Audio Generator (personal extension)
// ============================================================================
// Turns a shadowing script text file into an mp3 via OpenRouter's TTS
// endpoint, so the user has a reference-accent audio to shadow against.
//
// Usage:
//   node generate-audio.js <script-text-file> [output-mp3-path]
//
// Reads OPENROUTER_API_KEY from the project root .env (same file used for
// the rest of this project's OpenRouter calls).
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(scriptDir, '..', '.env');
const OUTPUT_DIR = join(scriptDir, '..', 'output');

const TTS_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
// OpenRouter's TTS catalog has no OpenAI model as of this writing —
// Deepgram Aura-2 is the closest standard-English reference voice available.
const TTS_MODEL = 'deepgram/aura-2';
const TTS_VOICE = 'aura-2-asteria-en';
const TTS_SPEED = 0.9;

async function main() {
  loadEnv({ path: ENV_PATH });

  const [inputPath, outputPathArg] = process.argv.slice(2);
  if (!inputPath) {
    console.log(JSON.stringify({
      status: 'error',
      message: 'Usage: node generate-audio.js <script-text-file> [output-mp3-path]'
    }));
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({
      status: 'error',
      message: `OPENROUTER_API_KEY not found in ${ENV_PATH}. Add it there and try again.`
    }));
    process.exit(1);
  }

  const script = (await readFile(inputPath, 'utf-8')).trim();
  if (!script) {
    console.log(JSON.stringify({ status: 'error', message: 'Input script file is empty.' }));
    process.exit(1);
  }

  const outputPath = outputPathArg
    || join(OUTPUT_DIR, `${basename(inputPath, extname(inputPath))}.mp3`);
  await mkdir(dirname(outputPath), { recursive: true });

  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: script,
        response_format: 'mp3',
        speed: TTS_SPEED
      })
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`OpenRouter TTS API error (${res.status}): ${errBody}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(outputPath, buffer);

    console.log(JSON.stringify({
      status: 'ok',
      outputPath,
      bytes: buffer.length,
      model: TTS_MODEL,
      voice: TTS_VOICE
    }));
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', message: err.message }));
    process.exit(1);
  }
}

main();

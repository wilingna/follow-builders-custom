#!/usr/bin/env node

// ============================================================================
// Follow Builders — Text-to-Video Clip Generator (personal extension)
// ============================================================================
// Replaces the old "still image + Ken Burns" background with real
// text-to-video clips via OpenRouter's async Video API (kwaivgi/kling-v3.0-std
// by default). One clip per script segment.
//
// Usage:
//   node generate-video-clips.js <video-segments.json> <output-dir> [options]
//
// video-segments.json: [{ "id": "seg1", "duration": 11.839, "videoPrompt": "..." }, ...]
//   - "duration" is the TARGET duration this clip needs to fill in the final
//     cut (comes from the audio timing, e.g. ai-leverage-segments.json).
//   - "videoPrompt" is the real-person-in-scene prompt for this segment.
//
// Options:
//   --aspect 9:16|16:9|1:1   (default: 9:16)
//   --model <openrouter model id>   (default: kwaivgi/kling-v3.0-std)
//   --resolution <string>    (passed through if the model supports it)
//   --reference-image <path>  identity-lock a subject across all segments'
//     otherwise-independent generations (sent as input_references, NOT as
//     frame_images — each segment is a different scene/framing, so we want
//     "same person" not "same literal first frame").
//
// Output: <output-dir>/<id>.mp4 per segment, plus a manifest JSON on stdout:
//   { status, clips: [{ id, path, targetDuration, requestedDuration }], errors }
//
// The manifest's targetDuration/requestedDuration pair is what
// compose-video.js uses to stretch/trim/freeze each raw clip to line up
// exactly with the audio track.
//
// Reads OPENROUTER_API_KEY from the project root .env.
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(scriptDir, '..', '.env');

const API_BASE = 'https://openrouter.ai/api/v1/videos';
const DEFAULT_MODEL = 'kwaivgi/kling-v3.0-std';
const DEFAULT_ASPECT = '9:16';

// Model card documents a 3-15s range for kling-v3.0-std, not a fixed
// enum of allowed values. We clamp/round to the nearest whole second in
// that range and let compose-video.js absorb the leftover mismatch
// (trim if we asked for more than we needed, stretch/freeze if less).
const MIN_DURATION = 3;
const MAX_DURATION = 15;

const POLL_INTERVAL_MS = 10_000;
const JOB_TIMEOUT_MS = 8 * 60 * 1000;      // give up polling a single job after 8 min
const MAX_SUBMIT_ATTEMPTS = 3;              // resubmit the whole job this many times
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];

const TERMINAL_ERROR_STATES = new Set(['failed', 'cancelled', 'expired']);

function parseArgs(argv) {
  const positional = [];
  const opts = { aspect: DEFAULT_ASPECT, model: DEFAULT_MODEL, resolution: undefined, referenceImage: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--aspect') opts.aspect = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--resolution') opts.resolution = argv[++i];
    else if (a === '--reference-image') opts.referenceImage = argv[++i];
    else positional.push(a);
  }
  return { positional, opts };
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function loadReferenceImageDataUri(path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/png';
  const buffer = await readFile(path);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function pickRequestedDuration(targetDuration) {
  const rounded = Math.round(targetDuration);
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, rounded));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function submitJob(apiKey, { model, prompt, duration, aspect, resolution, referenceImageDataUri }) {
  const body = {
    model,
    prompt,
    duration,
    aspect_ratio: aspect,
    generate_audio: false // narration audio is added later in compose-video.js
  };
  if (resolution) body.resolution = resolution;
  // input_references locks the subject's identity/appearance across
  // otherwise-independent generations (different scenes/framing each time),
  // as opposed to frame_images which pins the literal first frame of THIS
  // clip — we want the former since each segment is a different setting.
  if (referenceImageDataUri) {
    body.input_references = [{ type: 'image_url', image_url: { url: referenceImageDataUri } }];
  }

  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    throw new Error(`Video job submission failed (HTTP ${res.status}): ${text}`);
  }
  if (!json?.id) {
    throw new Error(`Video job submission returned no job id: ${text}`);
  }
  return json; // { id, status, polling_url }
}

async function pollJob(apiKey, job) {
  const pollUrl = job.polling_url || `${API_BASE}/${job.id}`;
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let res;
    try {
      res = await fetch(pollUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (err) {
      // Transient network hiccup while polling — don't kill the whole job for this.
      process.stderr.write(`  poll network error, retrying: ${err.message}\n`);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      process.stderr.write(`  poll HTTP ${res.status}, retrying: ${text}\n`);
      continue;
    }

    const status = await res.json();
    process.stderr.write(`  status: ${status.status}\n`);

    if (status.status === 'completed') return status;
    if (TERMINAL_ERROR_STATES.has(status.status)) {
      throw new Error(`Job ${job.id} ended with status '${status.status}': ${status.error || 'no details'}`);
    }
    // else: pending / in_progress — keep polling
  }

  throw new Error(`Job ${job.id} timed out after ${JOB_TIMEOUT_MS / 1000}s of polling`);
}

async function downloadClip(apiKey, completedJob, outPath) {
  const url = completedJob.unsigned_urls?.[0] || `${API_BASE}/${completedJob.id}/content?index=0`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`Download failed for job ${completedJob.id} (HTTP ${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buffer);
  return buffer.length;
}

async function generateOneClip(apiKey, seg, outDir, opts) {
  const targetDuration = seg.duration;
  const requestedDuration = pickRequestedDuration(targetDuration);
  const outPath = join(outDir, `${seg.id}.mp4`);

  let lastErr;
  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    try {
      process.stderr.write(`[${seg.id}] submitting (attempt ${attempt}/${MAX_SUBMIT_ATTEMPTS}, ${requestedDuration}s, ${opts.aspect})...\n`);
      const job = await submitJob(apiKey, {
        model: opts.model,
        prompt: seg.videoPrompt,
        duration: requestedDuration,
        aspect: opts.aspect,
        resolution: opts.resolution,
        referenceImageDataUri: opts.referenceImageDataUri
      });
      process.stderr.write(`[${seg.id}] job ${job.id} submitted, polling...\n`);
      const completed = await pollJob(apiKey, job);
      const bytes = await downloadClip(apiKey, completed, outPath);
      process.stderr.write(`[${seg.id}] done: ${outPath} (${bytes} bytes)\n`);
      return { id: seg.id, path: outPath, targetDuration, requestedDuration, bytes };
    } catch (err) {
      lastErr = err;
      process.stderr.write(`[${seg.id}] attempt ${attempt} failed: ${err.message}\n`);
      if (attempt < MAX_SUBMIT_ATTEMPTS) {
        const backoff = RETRY_BACKOFF_MS[attempt - 1] || RETRY_BACKOFF_MS.at(-1);
        process.stderr.write(`[${seg.id}] retrying in ${backoff / 1000}s...\n`);
        await sleep(backoff);
      }
    }
  }
  throw new Error(`[${seg.id}] gave up after ${MAX_SUBMIT_ATTEMPTS} attempts: ${lastErr.message}`);
}

async function main() {
  loadEnv({ path: ENV_PATH });

  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [segmentsPath, outDir] = positional;
  if (!segmentsPath || !outDir) {
    console.error('Usage: node generate-video-clips.js <video-segments.json> <output-dir> [--aspect 9:16] [--model kwaivgi/kling-v3.0-std] [--resolution 720p] [--reference-image <path>]');
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(`OPENROUTER_API_KEY not found in ${ENV_PATH}. Add it there and try again.`);
    process.exit(1);
  }

  const segments = JSON.parse(await readFile(segmentsPath, 'utf-8'));
  await mkdir(outDir, { recursive: true });

  if (opts.referenceImage) {
    opts.referenceImageDataUri = await loadReferenceImageDataUri(opts.referenceImage);
    process.stderr.write(`Using reference image for identity consistency: ${opts.referenceImage}\n`);
  }

  const clips = [];
  const errors = [];

  // Sequential, not parallel: keeps cost/rate-limit behavior predictable and
  // makes stderr progress readable. Video jobs already take 30s-few min each,
  // so parallelizing saves wall-clock time but risks tripping rate limits —
  // fine to add later if this becomes the bottleneck.
  for (const seg of segments) {
    try {
      clips.push(await generateOneClip(apiKey, seg, outDir, opts));
    } catch (err) {
      errors.push({ id: seg.id, message: err.message });
    }
  }

  const output = {
    status: errors.length === 0 ? 'ok' : 'partial',
    model: opts.model,
    aspect: opts.aspect,
    clips,
    errors: errors.length > 0 ? errors : undefined
  };
  console.log(JSON.stringify(output, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});

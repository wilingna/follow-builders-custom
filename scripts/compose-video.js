#!/usr/bin/env node

// ============================================================================
// Follow Builders — Video Composer (personal extension)
// ============================================================================
// Takes the raw per-segment clips from generate-video-clips.js, the narration
// mp3, and the bilingual srt, and produces final deliverables:
//   - <outPrefix>-9x16.mp4          (vertical, with audio + burned subtitles)
//   - <outPrefix>-9x16-silent.mp4   (vertical, no audio, same burned subtitles)
//   - <outPrefix>-16x9.mp4          (horizontal, with audio + burned subtitles)
//   - <outPrefix>-16x9-silent.mp4   (horizontal, no audio, same burned subtitles)
//
// The 16:9 (or 9:16) "secondary" orientation is DERIVED from the primary
// clips by default: a blurred, scaled copy of the frame fills the new aspect
// ratio's background and the original clip is composited centered on top, so
// the subject is never hard-cropped out. Pass --secondary-clips-dir to use a
// second natively-generated set of clips instead (better framing, costs a
// second full round of video generation).
//
// Usage:
//   node compose-video.js \
//     --segments <video-segments.json> \
//     --clips <clips-dir> \
//     --audio <narration.mp3> \
//     --srt <captions.srt> \
//     --out-prefix <output/base-name> \
//     [--primary-aspect 9:16] \
//     [--secondary-clips-dir <dir>] \
//     [--skip-silent] \
//     [--only-aspect 9:16|16:9]
//
// video-segments.json: [{ "id": "seg1", "duration": 11.839 }, ...] — the
// TARGET duration each clip must exactly fill (from the audio timing).
// Each raw clip in <clips-dir>/<id>.mp4 is trimmed (if longer) or
// last-frame-padded (if shorter) to match, since Kling only accepts whole-
// second durations and won't line up with the audio exactly on its own.
// ============================================================================

import { readFile, mkdir, writeFile, rm } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { srtToAss } from './srt-to-ass.js';

const run = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));

const RESOLUTIONS = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 }
};
const FPS = 30;

function otherAspect(aspect) {
  if (aspect === '9:16') return '16:9';
  if (aspect === '16:9') return '9:16';
  throw new Error(`No default "other" aspect for ${aspect} — pass --secondary-clips-dir explicitly`);
}

function parseArgs(argv) {
  const opts = { primaryAspect: '9:16', skipSilent: false, onlyAspect: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segments') opts.segments = argv[++i];
    else if (a === '--clips') opts.clipsDir = argv[++i];
    else if (a === '--audio') opts.audio = argv[++i];
    else if (a === '--srt') opts.srt = argv[++i];
    else if (a === '--out-prefix') opts.outPrefix = argv[++i];
    else if (a === '--primary-aspect') opts.primaryAspect = argv[++i];
    else if (a === '--secondary-clips-dir') opts.secondaryClipsDir = argv[++i];
    else if (a === '--skip-silent') opts.skipSilent = true;
    else if (a === '--only-aspect') opts.onlyAspect = argv[++i]; // skip building the other aspect entirely
  }
  return opts;
}

// ffmpeg's `subtitles=` filter needs forward slashes and an escaped drive
// colon on Windows, or the path parses as a filter-option separator.
function ffmpegPathEscape(p) {
  return resolve(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

async function ffprobeDuration(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path
  ]);
  return parseFloat(stdout.trim());
}

// Normalize one raw clip to exactly `targetDuration` seconds at the given
// resolution/fps, trimming if it ran long or freeze-padding the last frame
// if it ran short (Kling only takes whole-second durations, so a mismatch
// against the audio-derived target is the common case, not the exception).
async function normalizeClip(rawPath, targetDuration, aspect, outPath) {
  const actual = await ffprobeDuration(rawPath);
  const { w, h } = RESOLUTIONS[aspect];
  const scaleFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${FPS}`;

  const args = ['-y', '-i', rawPath];
  if (actual > targetDuration) {
    args.push('-t', String(targetDuration));
    args.push('-vf', scaleFilter);
  } else if (actual < targetDuration) {
    const padSeconds = targetDuration - actual;
    args.push('-vf', `${scaleFilter},tpad=stop_mode=clone:stop_duration=${padSeconds}`);
    args.push('-t', String(targetDuration));
  } else {
    args.push('-vf', scaleFilter, '-t', String(targetDuration));
  }
  args.push('-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', outPath);

  await run('ffmpeg', args);
  return { actual, targetDuration, padded: actual < targetDuration, trimmed: actual > targetDuration };
}

// Derive the "other" aspect ratio from an already-normalized primary clip by
// blurring/scaling a copy to fill the new canvas as background and
// compositing the (aspect-preserved, contained) original on top — avoids
// hard-cropping the subject out of frame.
async function deriveAspect(primaryPath, targetAspect, outPath) {
  const { w, h } = RESOLUTIONS[targetAspect];
  const filter =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=25[bg];` +
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS}`;
  await run('ffmpeg', [
    '-y', '-i', primaryPath,
    '-filter_complex', filter,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium',
    outPath
  ]);
}

async function concatClips(paths, outPath, workDir) {
  const listPath = join(workDir, 'concat-list.txt');
  const listContent = paths.map(p => `file '${resolve(p).replace(/\\/g, '/')}'`).join('\n');
  await writeFile(listPath, listContent, 'utf-8');
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', outPath
  ]);
}

async function burnSubtitles(inPath, srtPath, aspect, outPath, workDir) {
  // Larger safe margin on vertical video to clear platform UI (caption bar,
  // like/share buttons that sit low on Douyin/视频号/小红书).
  // Font sizes tuned by eye against real footage at 1080x1920 / 1920x1080 —
  // big enough to read comfortably on a phone without wrapping the longest
  // lines in this project's scripts onto a 3rd line.
  const { w, h } = RESOLUTIONS[aspect];
  const marginV = aspect === '9:16' ? 190 : 70;
  const fontSize = aspect === '9:16' ? 46 : 44;

  // NOTE: ffmpeg's `subtitles=file.srt:force_style=...` filter does NOT
  // reliably honor Alignment/MarginV overrides for plain-SRT input on this
  // build (verified empirically — text rendered pinned to the top no matter
  // what Alignment/MarginV was passed). Converting to an explicit .ass with
  // the style baked into its own Style line and burning via `ass=` renders
  // correctly, so that's the path used here.
  const assPath = join(workDir, `captions-${aspect.replace(':', 'x')}.ass`);
  await srtToAss(srtPath, assPath, { width: w, height: h, fontSize, marginV, alignment: 2 });

  const escapedAss = ffmpegPathEscape(assPath);
  await run('ffmpeg', [
    '-y', '-i', inPath,
    '-vf', `ass='${escapedAss}'`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium',
    outPath
  ]);
}

async function muxAudio(videoPath, audioPath, outPath) {
  await run('ffmpeg', [
    '-y', '-i', videoPath, '-i', audioPath,
    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    outPath
  ]);
}

async function buildOneAspect({ aspect, normalizedDir, segments, srt, audio, outPrefix, sourceClipsDir, skipSilent }) {
  const workDir = normalizedDir;
  await mkdir(workDir, { recursive: true });

  const normalizedPaths = [];
  for (const seg of segments) {
    const rawPath = join(sourceClipsDir, `${seg.id}.mp4`);
    const outPath = join(workDir, `${seg.id}.norm.mp4`);
    process.stderr.write(`[${aspect}] normalizing ${seg.id} -> ${seg.duration}s...\n`);
    await normalizeClip(rawPath, seg.duration, aspect, outPath);
    normalizedPaths.push(outPath);
  }

  const silentPath = join(workDir, `concat-silent.mp4`);
  await concatClips(normalizedPaths, silentPath, workDir);

  const suffix = aspect.replace(':', 'x');
  // When skipping the silent deliverable, the subtitled-but-audioless
  // intermediate still has to exist (audio gets muxed onto it next) — it
  // just lives in the scratch workDir instead of being kept as output.
  const subtitledPath = skipSilent
    ? join(workDir, `subtitled.mp4`)
    : `${outPrefix}-${suffix}-silent.mp4`;
  await burnSubtitles(silentPath, srt, aspect, subtitledPath, workDir);

  const withAudioPath = `${outPrefix}-${suffix}.mp4`;
  await muxAudio(subtitledPath, audio, withAudioPath);

  return { aspect, silent: skipSilent ? undefined : subtitledPath, withAudio: withAudioPath };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  for (const req of ['segments', 'clipsDir', 'audio', 'srt', 'outPrefix']) {
    if (!opts[req]) {
      console.error(`Missing required --${req.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`);
      console.error('Usage: node compose-video.js --segments <file> --clips <dir> --audio <mp3> --srt <srt> --out-prefix <prefix> [--primary-aspect 9:16] [--secondary-clips-dir <dir>]');
      process.exit(1);
    }
  }

  const segments = JSON.parse(await readFile(opts.segments, 'utf-8'));
  const outDir = dirname(opts.outPrefix);
  await mkdir(outDir, { recursive: true });

  const tmpDir = join(outDir, '.compose-tmp');
  await mkdir(tmpDir, { recursive: true });

  const results = [];

  // Primary aspect: normalize the natively-generated clips directly.
  const primaryNormDir = join(tmpDir, opts.primaryAspect.replace(':', 'x'));
  results.push(await buildOneAspect({
    aspect: opts.primaryAspect,
    normalizedDir: primaryNormDir,
    segments,
    srt: opts.srt,
    audio: opts.audio,
    outPrefix: opts.outPrefix,
    sourceClipsDir: opts.clipsDir,
    skipSilent: opts.skipSilent
  }));

  if (opts.onlyAspect) {
    await rm(tmpDir, { recursive: true, force: true });
    console.log(JSON.stringify({ status: 'ok', outputs: results }, null, 2));
    return;
  }

  // Secondary aspect: either a second native clip set, or derived from the
  // primary's normalized (already trimmed-to-length) clips.
  const secondaryAspect = otherAspect(opts.primaryAspect);
  if (opts.secondaryClipsDir) {
    const secondaryNormDir = join(tmpDir, secondaryAspect.replace(':', 'x'));
    results.push(await buildOneAspect({
      aspect: secondaryAspect,
      normalizedDir: secondaryNormDir,
      segments,
      srt: opts.srt,
      audio: opts.audio,
      outPrefix: opts.outPrefix,
      sourceClipsDir: opts.secondaryClipsDir,
      skipSilent: opts.skipSilent
    }));
  } else {
    process.stderr.write(`[${secondaryAspect}] deriving from primary (blur-fill background, no hard crop)...\n`);
    const derivedDir = join(tmpDir, `${secondaryAspect.replace(':', 'x')}-derived`);
    await mkdir(derivedDir, { recursive: true });

    const primaryNormalizedPaths = segments.map(seg => join(primaryNormDir, `${seg.id}.norm.mp4`));
    const derivedPaths = [];
    for (let i = 0; i < segments.length; i++) {
      const derivedPath = join(derivedDir, `${segments[i].id}.derived.mp4`);
      await deriveAspect(primaryNormalizedPaths[i], secondaryAspect, derivedPath);
      derivedPaths.push(derivedPath);
    }
    const silentPath = join(derivedDir, 'concat-silent.mp4');
    await concatClips(derivedPaths, silentPath, derivedDir);

    const suffix = secondaryAspect.replace(':', 'x');
    const subtitledPath = opts.skipSilent
      ? join(derivedDir, 'subtitled.mp4')
      : `${opts.outPrefix}-${suffix}-silent.mp4`;
    await burnSubtitles(silentPath, opts.srt, secondaryAspect, subtitledPath, derivedDir);
    const withAudioPath = `${opts.outPrefix}-${suffix}.mp4`;
    await muxAudio(subtitledPath, opts.audio, withAudioPath);
    results.push({ aspect: secondaryAspect, silent: opts.skipSilent ? undefined : subtitledPath, withAudio: withAudioPath, derived: true });
  }

  await rm(tmpDir, { recursive: true, force: true });

  console.log(JSON.stringify({ status: 'ok', outputs: results }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});

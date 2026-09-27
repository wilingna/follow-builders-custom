// ============================================================================
// Minimal SRT -> ASS converter with an explicit [V4+ Styles] line.
// ============================================================================
// Burning subtitles via ffmpeg's `subtitles=file.srt:force_style=...` filter
// turned out to NOT reliably honor Alignment/MarginV overrides on this build
// (font size and color overrides worked, vertical position did not — text
// rendered pinned near the top regardless of Alignment/MarginV). Writing an
// explicit .ass with the desired style baked into its own Style line, then
// burning that via the `ass=` filter, renders exactly as specified. See the
// smoke-test frames captured while building this (debug-subpos*.png vs
// debug-ass*.png) for the before/after.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';

function srtTimeToAss(t) {
  // "00:00:02,960" -> "0:00:02.96" (ASS wants centiseconds, no leading zero on hours)
  const [h, m, rest] = t.split(':');
  const [s, ms] = rest.split(',');
  const cs = Math.round(parseInt(ms, 10) / 10);
  return `${parseInt(h, 10)}:${m}:${s}.${String(cs).padStart(2, '0')}`;
}

function parseSrt(content) {
  const blocks = content.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 2) continue;
    // First line is normally a numeric index, but don't require it.
    const idx = lines[0].includes('-->') ? 0 : 1;
    const timeLine = lines[idx];
    const m = timeLine.match(/(\d\d:\d\d:\d\d,\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d,\d\d\d)/);
    if (!m) continue;
    const text = lines.slice(idx + 1).join('\\N'); // \N = hard line break in ASS
    cues.push({ start: srtTimeToAss(m[1]), end: srtTimeToAss(m[2]), text });
  }
  return cues;
}

/**
 * Convert an .srt file to a minimal .ass file with one explicit Style.
 * @param {string} srtPath
 * @param {string} assPath
 * @param {{width:number, height:number, fontSize:number, marginV:number, alignment?:number}} opts
 *   alignment uses ASS numpad notation: 2 = bottom-center (default).
 */
export async function srtToAss(srtPath, assPath, { width, height, fontSize, marginV, alignment = 2, outline = 3, bold = true }) {
  const srt = await readFile(srtPath, 'utf-8');
  const cues = parseSrt(srt);
  if (cues.length === 0) {
    throw new Error(`No cues parsed from ${srtPath} — check it's a valid .srt file`);
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,${bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},0,${alignment},20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues.map(c => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${c.text}`).join('\n');
  await writeFile(assPath, header + events + '\n', 'utf-8');
  return assPath;
}

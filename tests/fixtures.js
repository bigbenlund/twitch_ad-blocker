// Loads captured playlists. Layout: tests/fixtures/<date>/<channel>/<playerType>/media-NNN.m3u8
// (capture-fixtures.mjs) and tests/fixtures/har/<capture>/playlists/NNN-media.m3u8 (scrub-har.mjs).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.join(import.meta.dirname, 'fixtures');

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === 'raw') continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Groups of consecutive media playlists from one playback session, in capture order.
export function sessions() {
  const groups = new Map();
  for (const p of walk(ROOT).filter((p) => /media\.m3u8$|media-\d+\.m3u8$/.test(p)).sort()) {
    const dir = path.dirname(p);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ path: p, text: readFileSync(p, 'utf8') });
  }
  return [...groups].map(([dir, playlists]) => ({ name: path.relative(ROOT, dir), playlists }));
}

export const masters = () => walk(ROOT).filter((p) => /master\.m3u8$/.test(p)).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

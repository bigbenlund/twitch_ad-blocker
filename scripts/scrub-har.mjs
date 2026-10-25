// Extracts scrubbed fixtures from a HAR recorded by capture-browser.mjs.
// Usage: node scripts/scrub-har.mjs <capture-dir> [out-dir]
// Writes: playlists in request order, the PlaybackAccessToken GQL request, usher request params,
// and the player worker bootstrap. Cookies, auth headers, IPs and tokens are removed.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scrub } from './scrub.mjs';

const [capDir, outArg] = process.argv.slice(2);
if (!capDir) throw new Error('usage: scrub-har.mjs <capture-dir> [out-dir]');
const name = path.basename(capDir);
const outDir = outArg ?? path.join('tests', 'fixtures', 'har', name);
await mkdir(path.join(outDir, 'playlists'), { recursive: true });

const SECRET_HEADERS = /^(cookie|set-cookie|authorization|client-integrity|client-session-id|x-device-id|device-id|client-version)$/i;
const body = (c) => (c.encoding === 'base64' ? Buffer.from(c.text ?? '', 'base64').toString() : c.text ?? '');
const headers = (hs) => Object.fromEntries(hs.filter((h) => !SECRET_HEADERS.test(h.name) && !h.name.startsWith(':')).map((h) => [h.name, h.value]));

const entries = JSON.parse(await readFile(path.join(capDir, 'session.har'), 'utf8')).log.entries;

// Playlists, in request order
const index = [];
let n = 0;
for (const e of entries) {
  const u = e.request.url;
  const kind = u.includes('usher.ttvnw.net') ? 'master' : /playlist\.ttvnw\.net\/v1\/playlist/.test(u) ? 'media' : null;
  if (!kind) continue;
  const text = body(e.response.content);
  // Chromium sometimes drops worker response bodies from the HAR; those entries are useless.
  if (!text) continue;
  const file = `${String(n++).padStart(3, '0')}-${kind}.m3u8`;
  await writeFile(path.join(outDir, 'playlists', file), scrub(text));
  index.push({ file, kind, at: e.startedDateTime, status: e.response.status, bytes: text.length, stitchedAd: text.includes('CLASS="twitch-stitched-ad"') });
}

// PlaybackAccessToken request as the real player sends it
const tokenEntry = entries.find((e) => e.request.url.includes('gql.twitch.tv') && (e.request.postData?.text ?? '').includes('PlaybackAccessToken'));
if (tokenEntry) {
  await writeFile(path.join(outDir, 'gql-playback-access-token.json'), scrub(JSON.stringify({
    url: tokenEntry.request.url,
    headers: headers(tokenEntry.request.headers),
    body: JSON.parse(tokenEntry.request.postData.text),
    response: JSON.parse(body(tokenEntry.response.content)),
  }, null, 2)));
}

// Usher request parameters (values scrubbed)
const usher = entries.find((e) => e.request.url.includes('usher.ttvnw.net'));
if (usher) {
  const u = new URL(usher.request.url);
  await writeFile(path.join(outDir, 'usher-request.json'), scrub(JSON.stringify({
    path: u.pathname,
    params: Object.fromEntries(u.searchParams),
    headers: headers(usher.request.headers),
  }, null, 2)));
}

// Player worker bootstrap(s): blob sources saved by capture-browser.mjs
for (const f of (await readdir(capDir)).filter((f) => /^worker-\d+\.js$/.test(f))) {
  const src = await readFile(path.join(capDir, f), 'utf8');
  if (src.includes('importScripts')) await writeFile(path.join(outDir, f), scrub(src));
}

await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
console.log(`${index.length} playlists (${index.filter((i) => i.stitchedAd).length} with stitched ads) → ${outDir}`);

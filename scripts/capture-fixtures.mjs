// Captures Twitch access tokens and HLS playlists as test fixtures (logged out, public Client-ID).
// Usage: node scripts/capture-fixtures.mjs [channel ...] [--seconds 60] [--interval 2]
// With no channels, captures the top live channels by viewer count.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scrub } from './scrub.mjs';

const CHANNEL = /^[a-z0-9_]{1,25}$/; // Twitch login names; also keeps them safe in file paths
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const PLAYER_TYPES = ['site', 'embed', 'popout', 'autoplay', 'picture-by-picture'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
// Confirmed in live captures 2026-10-25; the unit tests own the full detection rules.
const AD_HINT = /CLASS="twitch-stitched-ad"/;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args.splice(i, 2)[1]);
};
const seconds = opt('seconds', 60);
const interval = opt('interval', 2);
let channels = args.filter((a) => !a.startsWith('--'));

// The web player sends a per-browser Device-ID; without one the token's device_id is null, which
// may change ad serving. A fresh random ID per run mimics a new logged-out browser.
const DEVICE_ID = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

const gql = async (body) => {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8', 'Device-ID': DEVICE_ID, 'User-Agent': UA, Origin: 'https://www.twitch.tv', Referer: 'https://www.twitch.tv/' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  return res.json();
};

const topChannels = async (n) => {
  const r = await gql({ query: `query{streams(first:${n},options:{sort:VIEWER_COUNT}){edges{node{broadcaster{login}}}}}` });
  return r.data.streams.edges.map((e) => e.node.broadcaster.login);
};

const accessToken = async (login, playerType) => {
  const r = await gql({
    operationName: 'PlaybackAccessToken_Template',
    query: 'query PlaybackAccessToken_Template($login: String!, $playerType: String!, $platform: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) { value signature } }',
    variables: { login, playerType, platform: 'web' },
  });
  return r.data.streamPlaybackAccessToken;
};

// Mirrors the web player's v2 usher request. The v1 endpoint with fewer params never
// returns stitched ads, so fixtures captured that way would miss them.
const usherUrl = (login, { value, signature }) => {
  const q = new URLSearchParams({
    acmb: Buffer.from(JSON.stringify({ AppVersion: '15da6dc5-fbbd-4a5e-8eed-48d74d87c212', ClientApp: 'twilight', URL: `https://www.twitch.tv/${login}` })).toString('base64'),
    allow_source: 'true', browser_family: 'chrome', browser_version: '156.0', cdm: 'wv',
    device_manufacturer: 'Apple', device_model: 'Macintosh', enable_score: 'true', fast_bread: 'true',
    include_unavailable: 'true', lang: 'en', os_name: 'macOS', os_version: '10.15.7',
    p: String(Math.floor(Math.random() * 1e7)), platform: 'web',
    play_session_id: crypto.randomUUID().replace(/-/g, ''), player_backend: 'mediaplayer',
    player_version: '1.58.0-rc.1', playlist_include_framerate: 'true', reassignments_supported: 'true',
    sig: signature, token: value, supported_codecs: 'av1,h265,h264', transcode_mode: 'cbr_v1',
  });
  return `https://usher.ttvnw.net/api/v2/channel/hls/${login}.m3u8?${q}`;
};

const text = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`);
  return res.text();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureSession(dir, login, playerType) {
  await mkdir(dir, { recursive: true });
  const files = [];
  const tok = await accessToken(login, playerType);
  if (!tok) return { playerType, error: 'no token (offline?)', files };
  await writeFile(path.join(dir, 'token.json'), scrub(JSON.stringify(JSON.parse(tok.value), null, 2)));
  const master = await text(usherUrl(login, tok));
  await writeFile(path.join(dir, 'master.m3u8'), scrub(master));
  const variant = master.split('\n').find((l) => l.startsWith('https://'));

  let last = '';
  const start = Date.now();
  for (let i = 0; Date.now() - start < seconds * 1000; i++) {
    let media;
    try {
      media = await text(variant);
    } catch (e) {
      files.push({ t: Math.round((Date.now() - start) / 1000), error: e.message });
      await sleep(interval * 1000);
      continue;
    }
    if (media !== last) {
      const name = `media-${String(i).padStart(3, '0')}.m3u8`;
      const t = Math.round((Date.now() - start) / 1000);
      await writeFile(path.join(dir, name), scrub(media));
      files.push({ name, t, adHint: AD_HINT.test(media) });
      last = media;
    }
    await sleep(interval * 1000);
  }
  return { playerType, files };
}

if (!channels.length) channels = await topChannels(5);
channels = channels.map((c) => c.toLowerCase());
const bad = channels.filter((c) => !CHANNEL.test(c));
if (bad.length) throw new Error(`invalid channel name: ${bad.join(', ')}`);
const outRoot = path.join('tests', 'fixtures', new Date().toISOString().slice(0, 16).replace(':', ''));
const summary = {}; // per channel; each channel dir gets its own manifest.json
for (const login of channels) {
  console.log(`capturing ${login} (${seconds}s, ${PLAYER_TYPES.length} player types)`);
  summary[login] = await Promise.all(
    PLAYER_TYPES.map((pt) =>
      captureSession(path.join(outRoot, login, pt), login, pt).catch((e) => ({ playerType: pt, error: e.message, files: [] })),
    ),
  );
  await writeFile(path.join(outRoot, login, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), seconds, interval, sessions: summary[login] }, null, 2));
  for (const s of summary[login]) {
    const ads = s.files.filter((f) => f.adHint).length;
    const errors = s.files.filter((f) => f.error).length;
    console.log(`  ${s.playerType.padEnd(20)} ${s.error ?? `${s.files.length - errors} playlists, ${ads} with ad hints${errors ? `, ${errors} fetch errors` : ''}`}`);
  }
}
console.log(`saved to ${outRoot}`);

// Loads the extension in a throwaway, logged-out headless Chromium and plays live Twitch channels.
// Usage: node scripts/e2e.mjs [channel ...] [--runs 1] [--seconds 60] [--allowlist] [--no-verbose] [--shots] [--no-extension] [--strip]
//   No channels: uses the top live channels. --runs N: N fresh-profile loads (cycling channels).
//   --allowlist: allowlists each channel (ads should pass through).
//   --no-extension: baseline run without the extension (no log; compare errors and ad UI).
//   --strip: disable alternate streams so the strip fallback is exercised.
// Writes one JSON result per load to e2e-results/ and prints a summary.
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT_ID } from '../src/lib/token.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args.splice(i, 2)[1]);
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && !!args.splice(i, 1);
};
const runs = opt('runs', 1);
const seconds = opt('seconds', 60);
const allowlist = flag('allowlist');
const verbose = !flag('no-verbose');
const shots = flag('shots');
const noExtension = flag('no-extension');
const strip = flag('strip');
let channels = args.filter((a) => !a.startsWith('--'));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const EXT = path.resolve('extension');
const OUT = 'e2e-results';

if (!channels.length) {
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query{streams(first:8,options:{sort:VIEWER_COUNT}){edges{node{broadcaster{login}}}}}' }),
  }).then((r) => r.json());
  channels = r.data.streams.edges.map((e) => e.node.broadcaster.login);
}
// Twitch login names; also keeps them safe in the profile paths deleted after each load.
channels = channels.map((c) => c.toLowerCase());
const bad = channels.filter((c) => !/^[a-z0-9_]{1,25}$/.test(c));
if (bad.length) throw new Error(`invalid channel name: ${bad.join(', ')}`);

async function load(channel, i) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${i}-${channel}`;
  const profile = path.join('.profiles', `e2e-${stamp}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 720 },
    userAgent: UA,
    args: noExtension ? [] : [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const result = { channel, stamp, allowlist, errors: [], timeline: [], log: [], blocked: {} };
  try {
    const sw = noExtension ? null : ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
    sw?.on('console', (m) => m.type() === 'error' && result.errors.push(`[sw] ${m.text()}`));
    await sw?.evaluate((s) => chrome.storage.local.set(s), { verbose, allowlist: allowlist ? [channel] : [], ...(strip ? { playerTypesOverride: [] } : {}) });

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on('pageerror', (e) => result.errors.push(`[page] ${e.message}`));
    ctx.on('requestfailed', (req) => {
      if (req.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') return;
      const host = new URL(req.url()).hostname;
      result.blocked[host] = (result.blocked[host] ?? 0) + 1;
    });
    page.on('worker', (w) => result.timeline.push({ t: -1, worker: w.url().slice(0, 60) }));
    await page.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded' });

    const start = Date.now();
    for (let t = 0; t <= seconds; t += 5) {
      await page.waitForTimeout(Math.max(0, start + t * 1000 - Date.now()));
      const s = await page.evaluate(() => {
        const v = document.querySelector('video');
        const ad = document.querySelector('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]');
        return { currentTime: v ? Math.round(v.currentTime * 10) / 10 : null, paused: v?.paused ?? null, height: v?.videoHeight ?? null, adUi: !!ad };
      }).catch((e) => ({ error: e.message }));
      result.timeline.push({ t, ...s });
      if (shots && t % 15 === 0) await page.screenshot({ path: path.join(OUT, `${stamp}-${String(t).padStart(3, '0')}.png`) });
    }
    const { log = [] } = (await sw?.evaluate(() => chrome.storage.session.get('log'))) ?? {};
    result.log = log.map(({ tabId, ...e }) => e);
  } catch (e) {
    result.errors.push(`[harness] ${e.message}`);
  } finally {
    await ctx.close();
    await rm(profile, { recursive: true, force: true });
  }
  await writeFile(path.join(OUT, `${stamp}.json`), JSON.stringify(result, null, 2));
  return result;
}

function summarize(r) {
  const types = r.log.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
  const order = r.log.map((e) => e.type);
  const tl = r.timeline.filter((x) => x.t >= 0);
  const last = tl.at(-1) ?? {};
  return {
    channel: r.channel,
    hookFirst: order.indexOf('hook-installed') !== -1 && order.indexOf('hook-installed') < order.indexOf('worker-created'),
    events: types,
    adUiSeconds: tl.filter((x) => x.adUi).length * 5,
    // Skips the first interval: the player is still starting up.
    stallSeconds: tl.slice(2).filter((x, i) => x.currentTime !== null && tl[i + 1].currentTime !== null && x.currentTime - tl[i + 1].currentTime < 2.5).length * 5,
    swappedTo: [...new Set(r.log.filter((e) => e.type === 'swapped').map((e) => e.playerType))],
    played: last.currentTime ?? null,
    height: last.height ?? null,
    errors: r.errors.length,
    blocked: Object.values(r.blocked).reduce((a, b) => a + b, 0),
  };
}

await mkdir(OUT, { recursive: true });
const results = [];
for (let i = 0; i < runs; i++) {
  const r = await load(channels[i % channels.length], i);
  const s = summarize(r);
  results.push(s);
  console.log(JSON.stringify(s));
}
console.log(`\n${results.length} loads · hook first in ${results.filter((s) => s.hookFirst).length} · ad UI shown in ${results.filter((s) => s.adUiSeconds).length}`);

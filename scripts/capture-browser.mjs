// Records what the real Twitch player does in a throwaway, logged-out headless Chromium:
// a HAR (video segments excluded), the player worker sources, and periodic screenshots.
// Usage: node scripts/capture-browser.mjs <channel> [--seconds 90] [--extension]
// Output: tests/fixtures/raw/<timestamp>-<channel>/ (gitignored; scrub before using as fixtures)
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args.splice(i, 2)[1]);
};
const seconds = opt('seconds', 90);
const withExtension = args.includes('--extension');
const channel = args.find((a) => !a.startsWith('--'));
if (!channel) throw new Error('usage: capture-browser.mjs <channel> [--seconds 90] [--extension]');
if (!/^[a-z0-9_]{1,25}$/i.test(channel)) throw new Error(`invalid channel name: ${channel}`); // also keeps paths safe

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join('tests', 'fixtures', 'raw', `${stamp}-${channel}`);
const profile = path.join('.profiles', `capture-${stamp}-${channel}`);
await mkdir(outDir, { recursive: true });

const ext = path.resolve('extension');
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1280, height: 720 },
  // Headless UA advertises "HeadlessChrome"; present as regular Chrome.
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  recordHar: { path: path.join(outDir, 'session.har'), content: 'embed', urlFilter: /^(?!.*\/v1\/segment\/)/ },
  args: withExtension ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : [],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
const workers = [];
page.on('worker', (w) => workers.push(w.url()));
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

await page.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded' });

// Save worker sources while the page is alive (blob: URLs die with it).
const saveWorkers = async () => {
  for (const [i, url] of workers.entries()) {
    const src = await page.evaluate((u) => fetch(u).then((r) => r.text()), url).catch((e) => `// fetch failed: ${e.message}`);
    await writeFile(path.join(outDir, `worker-${i}.js`), `// ${url}\n${src}`);
  }
};

const timeline = [];
const start = Date.now();
for (let t = 0; t <= seconds; t += 5) {
  await page.waitForTimeout(Math.max(0, start + t * 1000 - Date.now()));
  const state = await page.evaluate(() => {
    const v = document.querySelector('video');
    const adLabel = document.querySelector('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]');
    return {
      currentTime: v ? Math.round(v.currentTime) : null,
      paused: v?.paused ?? null,
      adUi: !!adLabel,
      adText: adLabel?.textContent?.trim() ?? null,
    };
  }).catch((e) => ({ error: e.message }));
  timeline.push({ t, ...state });
  console.log(`t=${String(t).padStart(3)}s`, JSON.stringify(state));
  if (t % 15 === 0) await page.screenshot({ path: path.join(outDir, `shot-${String(t).padStart(3, '0')}.png`) });
  if (t === 10) await saveWorkers();
}
await saveWorkers();

await writeFile(path.join(outDir, 'timeline.json'), JSON.stringify({ channel, workers, timeline }, null, 2));
await writeFile(path.join(outDir, 'console.log'), consoleLines.join('\n'));
await ctx.close();
await rm(profile, { recursive: true, force: true });
console.log(`saved to ${outDir}`);

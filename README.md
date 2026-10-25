# StreamShield

Chrome extension that blocks Twitch video ads (pre-rolls and mid-rolls). Loaded unpacked, no account needed.

> Unofficial and not affiliated with Twitch. Blocking ads may break Twitch's Terms of Service, and ads are how many streamers get paid. Consider allowlisting channels you want to support (see *Using it*).

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` folder in this project.
3. Pin StreamShield from the puzzle-piece menu if you want the popup handy.

After changing code: run `npm run build` (only needed if you edited `src/`), then click the reload icon on the StreamShield card in `chrome://extensions` and refresh any open Twitch tabs.

Chrome may show a "Disable developer mode extensions" prompt at startup. Choose **Keep** (or dismiss it).

## Using it

Open a Twitch channel. When Twitch tries to play an ad, StreamShield switches the video to an ad-free copy of the same stream. The badge counts ad breaks blocked in that tab.

The popup has:

- **Enabled**: turns blocking on or off everywhere.
- **Allow ads here**: lets ads play on the current channel (e.g. to support a streamer); the button then reads **Block ads here** to undo it. Allowed channels are listed below with a **Remove** button.
- **Ad breaks blocked**: breaks blocked in this tab (same as the badge).
- **Swapped / Stripped**: how each break was handled. *Swapped* means an ad-free stream was used, so playback is seamless. *Stripped* means no ad-free stream was available, so the ad was cut out and the video **pauses for the ad's length**. That pause is expected.
- **Debug log**: the latest events, newest first (hover a row for full details). **Copy log** copies it (event types, channel names, ad durations; no tokens or IPs). Include it when reporting a problem.

Turning blocking off or allowing a channel takes full effect when you reload the stream (switching streams mid-playback would freeze the video).

## How it works

Twitch stitches ads into the video stream on its servers, so ordinary ad blockers can't remove them. StreamShield runs inside Twitch's video player:

1. `src/page-hook.js` (built into `extension/content/twitch-main.js`) wraps `window.Worker` before Twitch loads, so the player's worker runs `src/worker-hook.js` first.
2. The worker hook inspects every playlist. Ads are marked with `CLASS="twitch-stitched-ad"` and segment titles other than `live` (see `src/lib/m3u8.js`).
3. On an ad, it requests a new access token with a different player type (`extension/data/player-types.json`). If that stream is ad-free, the player gets it instead, and stays on it until the stream reloads.
4. If every alternate has ads, the ad segments are removed (`createAdStripper`) and the video pauses for the ad's length.
5. `extension/rules/trackers.json` blocks third-party ad and measurement hosts (see `extension/rules/README.md`).

## When ads come back

Twitch changes things periodically. Check what broke:

```sh
npm install                                   # first time only
npx playwright install chromium               # first time only
npm run capture -- fortnite --seconds 40      # fresh playlists from a live channel serving ads
npm test                                      # do the detection rules still match? (includes the new capture)
npm run e2e -- fortnite --seconds 90          # full live check in a headless browser
```

Pick a channel currently serving ads to logged-out viewers (big channels usually do). With no channel, both scripts use the top live channels. `--seconds` defaults to 60.

**Capture output** goes to `tests/fixtures/<date>T<time>/<channel>/<playerType>/`, already scrubbed of IPs and tokens. `npm test` runs against every fixture folder (except `raw/`), so run the capture first. The `manifest.json` in each channel folder lists which playlists had ads. Commit the new folder if it shows something the old fixtures don't (e.g. new ad markers) and the tests should be updated to cover it; otherwise delete it.

`e2e` prints one summary line per load, then a total (`N loads · hook first in N · ad UI shown in M`; healthy is hook first in all, ad UI in 0). Read each line like this:

| Field | Healthy | If not |
|---|---|---|
| `hookFirst` | `true` | The worker hook isn't loading before the player → `src/page-hook.js` (how Twitch creates the player worker changed; check `PLAYER_WORKER`) |
| `events.ad-detected` | present when ads are served | Ads not recognised → `src/lib/m3u8.js` (markers changed; compare new fixtures with `tests/fixtures/`) |
| `swappedTo` | e.g. `["embed"]` | Alternate player types now get ads too → edit `extension/data/player-types.json` (run `npm run capture` and look for a player type with 0 ad hints) |
| `events.alt-error` | absent | Token or usher request failing → `src/lib/token.js` (Client-ID or query changed) |
| `adUiSeconds` | `0` | An ad got through: look at the debug log in `e2e-results/*.json` |
| `stallSeconds` | `0` (swap) or about the ad length (strip) | Long stalls after an ad → sequence numbering (`createAdStripper`) or the sticky-alternate logic in `src/worker-hook.js` |
| `played`, `height` | close to the run length; 720 at the test window size | Video not advancing → see `stallSeconds` and the log |
| `errors` | 0–2 | Page errors. `getLayoutMap()…` and `Failed to fetch` are Twitch's own (they appear with `--no-extension` too); anything else, compare against a `--no-extension` run |
| `blocked` | > 0 | Tracker requests blocked by `extension/rules/trackers.json` |

No `ad-detected` at all doesn't always mean something broke: that channel may not have served an ad. Try another channel, or check with `--no-extension` (`adUiSeconds` > 0 means ads are being served).

Full details for each load are in `e2e-results/<timestamp>-<n>-<channel>.json` (newest = latest run): `log` (the extension's debug events), `timeline` (video samples every 5 s), `errors`, `blocked`.

Other `e2e` options: `--runs N` (N fresh loads, cycling channels), `--strip` (force the strip fallback), `--allowlist` (ads should play), `--no-extension` (baseline), `--shots` (screenshots in `e2e-results/`).

To record what the real player does (HAR, worker source, ad UI timeline): `node scripts/capture-browser.mjs <channel>`. Output goes to `tests/fixtures/raw/` (gitignored, contains unscrubbed data). Extract scrubbed fixtures with `node scripts/scrub-har.mjs tests/fixtures/raw/<dir>`.

## Privacy

- Captures and tests run logged out, in throwaway browser profiles (`.profiles/`, deleted after each run).
- Everything saved under `tests/fixtures/` (except `raw/`) is scrubbed of IPs, tokens, signatures and session/device IDs (`scripts/scrub.mjs`). `npm test` fails if a committed fixture isn't fully scrubbed.
- The extension sends nothing anywhere except the Twitch requests the player would make anyway, plus alternate token/playlist requests to Twitch.

## Limits

- The hook runs inside Twitch's own page. It captures everything it relies on before Twitch's scripts load, and its messages carry a per-page secret, so Twitch's code can't read its settings or switch it off by patching browser functions. Twitch could still *detect* that something is hooking the player (stack traces name the extension) and change how ads are served; expect occasional updates.
- If every alternate player type starts getting ads, breaks are stripped instead: no ads, but the video pauses for each break.

## Layout

```
extension/          load-unpacked target (manifest, built page hook, bridge, background, popup, rules, data)
src/                page hook, worker hook, and the pure libs (m3u8.js, token.js) they're built from
scripts/            build, capture, scrub, e2e
tests/              node:test unit tests + captured fixtures
```

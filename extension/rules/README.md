# Network rules

Each rule blocks a third-party host seen in a logged-out Twitch session recorded 2026-10-25
(`scripts/capture-browser.mjs`), limited to requests initiated by twitch.tv pages. Video ads are not
affected by these rules; they are stitched into the stream and handled by the worker hook.

| Rule | Hosts | Evidence (HAR requests) |
|---|---|---|
| 1 | amazon-adsystem.com | `s.amazon-adsystem.com/iui3`, `/iu3` (ad identity sync), `sq-tungsten-ts.amazon-adsystem.com/noop` |
| 2 | scorecardresearch.com, imrworldwide.com | comScore `beacon.js`, `/p`, `/p2`; Nielsen `secure-sts-prod…/cgi-bin/gn`, `*.redinuid…/s2s` (audience measurement) |

Removed: `tq-tungsten.com` (Amazon ad telemetry). It only fires while an ad plays, which with blocking on happens only on allowlisted channels, where it should not be blocked.

Allowlisted channels: `background.js` adds a per-tab session `allow` rule (priority 2) for these domains, and turns the ruleset off when blocking is disabled, so ad measurement works when the user chooses to watch ads. Keep `BLOCKED_DOMAINS` in `background.js` in sync with this file.

Not blocked on purpose: `spade.twitch.tv` and other first-party Twitch hosts (blocking them risks
breaking the player or chat), `api.sprig.com` (surveys, not ads).

// Runs inside the Twitch player worker, before the player code. Wraps fetch to replace ad-stitched
// media playlists: first with an ad-free playlist from an alternate access token (playerType),
// else with the ads stripped out (playback stalls for the ad's length).
// Concatenated after src/lib/*.js by scripts/build.mjs, so their functions are in scope.
const SS = '__streamshield';
// Captured before the player code runs, which could patch them to read our messages.
const ssPost = self.postMessage.bind(self);
const ssData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
const ssStop = Event.prototype.stopImmediatePropagation;
// Sent by the page hook as this worker's first message; never part of the worker's source.
let ssKey = null;
const ss = {
  settings: null,
  waiters: [],
  channel: null,
  usherUrl: null,
  variants: new Map(), // main media playlist URL → variant from the main master
  strippers: new Map(), // media playlist URL → stateful ad stripper
  inAd: false,
  alt: null, // { playerType, master, mediaUrls: Map(main URL → alt URL) } once swapped (sticky)
  blocking: false, // currently swapping/stripping a break (for once-per-break counting)
  goodType: null, // playerType that last returned a clean stream (tried first next break)
  altSearch: null, // pending findAltStream, awaited by concurrent refreshes
};

// Registered before the player's listeners; our messages never reach the player.
self.addEventListener('message', (e) => {
  const data = Reflect.apply(ssData, e, []);
  if (!data?.[SS]) return;
  Reflect.apply(ssStop, e, []);
  if (!e.isTrusted) return;
  if (data[SS] === 'init' && ssKey === null) ssKey = data.key;
  if (data[SS] !== 'settings' || ssKey === null || data.key !== ssKey) return;
  ss.settings = data.settings;
  ss.waiters.splice(0).forEach((r) => r());
});

const ssEmit = (type, data = {}) => ssKey && ssPost({ [SS]: 'event', key: ssKey, event: { type, channel: ss.channel, ...data } });

// Settings arrive asynchronously from storage; wait briefly so the allowlist applies from the start.
const ssSettings = () =>
  ss.settings ??
  new Promise((resolve) => {
    ss.waiters.push(resolve);
    setTimeout(resolve, 1000);
  }).then(() => ss.settings ?? { enabled: true, allowlist: [], verbose: false, playerTypes: ['embed'] });

const USHER = /^https:\/\/usher\.ttvnw\.net\/api\/(v2\/)?channel\/hls\//;
const MEDIA = /^https:\/\/[^/]+\.ttvnw\.net\/v1\/playlist\//;
const nativeFetch = self.fetch;
const urlOf = (input) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '');

const textResponse = (text, like) => {
  const headers = new Headers(like.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(text, { status: like.status, statusText: like.statusText, headers });
};

const fetchText = async (url, init) => {
  const r = await nativeFetch(url, init);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
};

// Returns { playerType, master, mediaUrl, media } for the first alternate token whose stream is
// ad-free, or null.
async function findAltStream(variant, playerTypes) {
  const order = ss.goodType ? [ss.goodType, ...playerTypes.filter((t) => t !== ss.goodType)] : playerTypes;
  for (const playerType of order) {
    try {
      const { url, init } = buildAccessTokenRequest(ss.channel, playerType);
      const token = readAccessToken(await nativeFetch(url, init).then((r) => r.json()));
      if (!token) continue;
      const master = await fetchText(swapUsherToken(ss.usherUrl, token));
      const mediaUrl = pickVariant(master, variant);
      if (!mediaUrl) continue;
      const media = await fetchText(mediaUrl);
      if (!isStitchedAdPlaylist(media)) return { playerType, master, mediaUrl, media };
      ssEmit('alt-has-ads', { playerType });
    } catch (e) {
      ssEmit('alt-error', { playerType, error: String(e?.message ?? e) });
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fully stripped (all-ad) playlist has no segments, and the player re-requests it immediately,
// about 13 times a second. Hold the response for one target duration to pace it like a live refresh.
async function paced(text) {
  if (parsePlaylist(text).segments.length) return text;
  const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1] ?? 2);
  await sleep(Math.min(Math.max(target, 1), 6) * 1000);
  return text;
}

const stripperFor = (key) => {
  if (!ss.strippers.has(key)) ss.strippers.set(key, createAdStripper());
  return ss.strippers.get(key);
};

// The alternate session's playlist at the quality the player requested from `url`. Ads inside it
// are stripped with a stripper keyed on the alternate URL, so numbering stays within that session.
async function altPlaylist(url) {
  if (!ss.alt.mediaUrls.has(url)) ss.alt.mediaUrls.set(url, pickVariant(ss.alt.master, ss.variants.get(url)));
  const altUrl = ss.alt.mediaUrls.get(url);
  const media = await fetchText(altUrl);
  return isStitchedAdPlaylist(media) ? { text: await paced(stripperFor(altUrl)(media)), altAd: true, info: getAdInfo(media) } : { text: media, altAd: false };
}

// Counts one event per break; later refreshes of the same break are logged only when verbose.
function report(type, blocking, settings, data = {}) {
  const firstInBreak = blocking && !ss.blocking;
  ss.blocking = blocking;
  if (blocking && (firstInBreak || settings.verbose)) ssEmit(type, { firstInBreak, ...data });
}

self.fetch = async function (input, init) {
  const url = urlOf(input);
  if (USHER.test(url)) {
    // A new usher request means the player reloaded the stream: start over on the main session.
    ss.channel = channelFromUsherUrl(url);
    ss.usherUrl = url;
    ss.alt = null;
    ss.strippers.clear();
    ss.inAd = false;
    ss.blocking = false;
    ssEmit('usher', {});
    const res = await nativeFetch.call(this, input, init);
    res.clone().text().then((t) => parseMaster(t).forEach((v) => v.uri && ss.variants.set(v.uri, v))).catch(() => {});
    return res;
  }
  if (!MEDIA.test(url)) return nativeFetch.call(this, input, init);

  const res = await nativeFetch.call(this, input, init);
  const settings = await ssSettings();
  if (!res.ok) return res;
  if (!settings.enabled || settings.allowlist.includes(ss.channel)) {
    // Turned off mid-stream: stay on the alternate session or keep the stripper's numbering
    // (switching back freezes playback); the change takes full effect when the stream next loads.
    if (!ss.alt) return ss.strippers.has(url) ? textResponse(await paced(stripperFor(url)(await res.clone().text())), res) : res;
    try {
      if (!ss.alt.mediaUrls.has(url)) ss.alt.mediaUrls.set(url, pickVariant(ss.alt.master, ss.variants.get(url)));
      return textResponse(await fetchText(ss.alt.mediaUrls.get(url)), res);
    } catch {
      return res;
    }
  }
  // Another refresh may still be searching for an alternate stream; wait so it isn't stripped meanwhile.
  if (ss.altSearch) await ss.altSearch;
  const text = await res.clone().text();
  const ad = isStitchedAdPlaylist(text);
  if (settings.verbose) ssEmit('playlist', { ad });
  const breakStart = ad && !ss.inAd;
  if (breakStart) ssEmit('ad-detected', getAdInfo(text));
  if (!ad && ss.inAd) ssEmit('ad-ended', { via: ss.alt ? `swapped:${ss.alt.playerType}` : 'stripped' });
  ss.inAd = ad;

  try {
    // Once swapped, stay on the alternate session until the player reloads the stream. Switching
    // back mid-session jumps sequence numbers backwards and freezes playback.
    if (!ss.alt && breakStart && ss.usherUrl && settings.playerTypes.length) {
      ss.altSearch = findAltStream(ss.variants.get(url), settings.playerTypes);
      const found = await ss.altSearch.finally(() => (ss.altSearch = null));
      if (found) {
        ss.alt = { playerType: found.playerType, master: found.master, mediaUrls: new Map([[url, found.mediaUrl]]) };
        ss.goodType = found.playerType;
      }
    }
    if (ss.alt) {
      try {
        const { text: served, altAd, info } = await altPlaylist(url);
        if (altAd) report('stripped', true, settings, { source: ss.alt.playerType, ...info });
        else report('swapped', ad, settings, { playerType: ss.alt.playerType, variant: ss.variants.get(url)?.name ?? null });
        return textResponse(served, res);
      } catch (e) {
        ssEmit('alt-lost', { playerType: ss.alt.playerType, error: String(e?.message ?? e) });
        ss.alt = null;
      }
    }
    report('stripped', ad, settings, ad ? getAdInfo(text) : {});
    // Keep the stripper's numbering continuous once ads have been removed from this playlist.
    return ad || ss.strippers.has(url) ? textResponse(await paced(stripperFor(url)(text)), res) : res;
  } catch (e) {
    ssEmit('error', { where: 'fetch', error: String(e?.message ?? e) });
    return res;
  }
};

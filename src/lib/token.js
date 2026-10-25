// Access token and usher URL helpers for fetching an alternate (ad-free) stream.

export const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const TOKEN_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}';

// headers: extra headers copied from the player's own GQL request (e.g. Device-ID), optional.
export function buildAccessTokenRequest(channel, playerType, headers = {}) {
  return {
    url: 'https://gql.twitch.tv/gql',
    init: {
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken_Template',
        query: TOKEN_QUERY,
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType, platform: 'web' },
      }),
    },
  };
}

// GQL response → { value, signature } or null.
export function readAccessToken(response) {
  const t = response?.data?.streamPlaybackAccessToken;
  return t?.value && t?.signature ? { value: t.value, signature: t.signature } : null;
}

// Reuses the player's own usher URL so every other parameter stays current; only the token changes.
export function swapUsherToken(usherUrl, { value, signature }) {
  const u = new URL(usherUrl);
  u.searchParams.set('sig', signature);
  u.searchParams.set('token', value);
  u.searchParams.set('p', String(Math.floor(Math.random() * 1e7)));
  if (u.searchParams.has('play_session_id')) {
    u.searchParams.set('play_session_id', Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''));
  }
  return u.toString();
}

export function channelFromUsherUrl(url) {
  return /\/hls\/([^/.]+)\.m3u8/.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? null;
}

// Master playlist → [{ uri, name, resolution, bandwidth, frameRate }]
export function parseMaster(text) {
  const out = [];
  const ls = text.replace(/\r\n?/g, '\n').split('\n');
  const names = {};
  for (const l of ls) {
    if (!l.startsWith('#EXT-X-MEDIA:')) continue;
    const g = /GROUP-ID="([^"]*)"/.exec(l)?.[1];
    const n = /NAME="([^"]*)"/.exec(l)?.[1];
    if (g) names[g] = n;
  }
  ls.forEach((l, i) => {
    if (!l.startsWith('#EXT-X-STREAM-INF:')) return;
    // The URI is the next non-tag line, unless another variant starts first.
    const next = ls.slice(i + 1).find((x) => x && (!x.startsWith('#') || x.startsWith('#EXT-X-STREAM-INF:')));
    const uri = next && !next.startsWith('#') ? next : null;
    const group = /VIDEO="([^"]*)"/.exec(l)?.[1];
    out.push({
      uri,
      // v2 usher masters name variants inline (IVS-NAME); v1 uses #EXT-X-MEDIA groups.
      name: /IVS-NAME="([^"]*)"/.exec(l)?.[1] ?? names[group] ?? /STABLE-VARIANT-ID="([^"]*)"/.exec(l)?.[1] ?? group ?? null,
      resolution: /RESOLUTION=(\d+x\d+)/.exec(l)?.[1] ?? null,
      bandwidth: Number(/[:,]BANDWIDTH=(\d+)/.exec(l)?.[1] ?? 0),
      frameRate: Number(/FRAME-RATE=([\d.]+)/.exec(l)?.[1] ?? 0),
    });
  });
  return out;
}

// Picks the variant in `masterText` that best matches `current` ({ resolution, frameRate, bandwidth }):
// exact resolution + frame rate, else exact resolution, else the highest bandwidth not above current.
export function pickVariant(masterText, current) {
  const vs = parseMaster(masterText).filter((v) => v.uri);
  if (!vs.length) return null;
  // Unknown current variant: the best video variant (embed masters don't list source first).
  if (!current) return [...vs].sort((a, b) => !!b.resolution - !!a.resolution || b.bandwidth - a.bandwidth)[0].uri;
  const sameRes = vs.filter((v) => v.resolution && v.resolution === current.resolution);
  const exact = sameRes.find((v) => Math.round(v.frameRate) === Math.round(current.frameRate ?? 0));
  if (exact || sameRes[0]) return (exact ?? sameRes[0]).uri;
  // Never fall back from video to an audio-only variant.
  const pool = current.resolution && vs.some((v) => v.resolution) ? vs.filter((v) => v.resolution) : vs;
  const below = pool.filter((v) => v.bandwidth <= (current.bandwidth ?? Infinity)).sort((a, b) => b.bandwidth - a.bandwidth);
  return (below[0] ?? [...pool].sort((a, b) => a.bandwidth - b.bandwidth)[0]).uri;
}

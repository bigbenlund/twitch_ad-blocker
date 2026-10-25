// Twitch HLS media playlist parsing and ad removal. No browser APIs: runs in Node tests and,
// after build, inside the player worker.
//
// Observed format (2026-10-25): content segments are titled "live"; stitched ad segments carry
// the creative as title (e.g. "DCM|263341067", "InnovidAds|1iikgo"), start after
// #EXT-X-DISCONTINUITY, and are described by DATERANGE tags of the classes below.

const AD_DATERANGE_CLASSES = ['twitch-stitched-ad', 'twitch-ad-quartile'];
const LIVE_TITLE = 'live';
const SEGMENT_TAG = /^#(EXTINF|EXT-X-DATERANGE|EXT-X-DISCONTINUITY|EXT-X-PROGRAM-DATE-TIME)\b/;
const PREFETCH_TAG = '#EXT-X-TWITCH-PREFETCH:';

const lines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const daterangeClass = (line) => /[:,]CLASS="([^"]*)"/i.exec(line)?.[1] ?? null;
const isAdDaterange = (line) => line.startsWith('#EXT-X-DATERANGE') && AD_DATERANGE_CLASSES.includes(daterangeClass(line));

// { header: string[], segments: { tags: string[], uri, duration, title, isAd }[], prefetch: string[], trailer: string[] }
export function parsePlaylist(text) {
  const header = [];
  const segments = [];
  const prefetch = [];
  let pending = [];
  let inSegments = false;
  for (const line of lines(text)) {
    if (!line) continue;
    if (line.startsWith(PREFETCH_TAG)) { prefetch.push(line); continue; }
    if (!inSegments && line.startsWith('#') && !SEGMENT_TAG.test(line)) { header.push(line); continue; }
    inSegments = true;
    if (line.startsWith('#')) { pending.push(line); continue; }
    const inf = pending.find((l) => l.startsWith('#EXTINF:'));
    // #EXTINF:<duration>[ attrs],<title>; the title is everything after the first comma.
    const m = inf && /^#EXTINF:\s*([\d.]+)[^,]*(?:,(.*))?$/.exec(inf);
    const title = m?.[2]?.trim() ?? '';
    segments.push({ tags: pending, uri: line, duration: m ? Number(m[1]) : 0, title, isAd: title !== '' && title.toLowerCase() !== LIVE_TITLE });
    pending = [];
  }
  return { header, segments, prefetch, trailer: pending };
}

export function isStitchedAdPlaylist(text) {
  if (lines(text).some(isAdDaterange)) return true;
  return parsePlaylist(text).segments.some((s) => s.isAd);
}

export function getAdInfo(text) {
  const { segments } = parsePlaylist(text);
  const ads = segments.filter((s) => s.isAd);
  const firstAd = segments.findIndex((s) => s.isAd);
  // Twitch labels each ad (X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"/"MIDROLL"). Without the label, a live
  // segment before the first ad means the break started mid-stream.
  const rollType = /X-TV-TWITCH-AD-ROLL-TYPE="([^"]*)"/i.exec(String(text ?? ''))?.[1]?.toUpperCase() ?? null;
  // Length of the current ad pod (the playlist only shows its first segments when a break starts).
  // Twitch may chain several pods, so a break can run longer than this.
  const pod = /X-TV-TWITCH-AD-POD-FILLED-DURATION="([\d.]+)"/i.exec(String(text ?? ''))?.[1];
  return {
    adSegments: ads.length,
    adDuration: Math.round(ads.reduce((t, s) => t + s.duration, 0) * 1000) / 1000,
    podDuration: pod ? Number(pod) : null,
    isMidroll: rollType ? rollType === 'MIDROLL' : firstAd > 0 && segments.slice(0, firstAd).some((s) => !s.isAd),
  };
}

const headerValue = (header, tag) => {
  const line = header.find((l) => l.startsWith(`${tag}:`));
  return line ? Number(line.slice(tag.length + 1)) : null;
};

// Returns strip(text) → playlist text without ad segments. Keeps state across refreshes of the
// same playlist so live segments keep stable sequence numbers: each live segment is renumbered
// to its original number minus the count of ad segments removed before it.
export function createAdStripper() {
  const removed = new Set(); // original sequence numbers of ad segments
  let lastFirstSeq = -1;
  return function strip(text) {
    const { header, segments, prefetch, trailer } = parsePlaylist(text);
    const firstSeq = headerValue(header, '#EXT-X-MEDIA-SEQUENCE') ?? 0;
    // Sequence went backwards: a new playlist session (reconnect). Old removals no longer apply.
    if (firstSeq < lastFirstSeq) removed.clear();
    lastFirstSeq = firstSeq;
    segments.forEach((s, i) => { if (s.isAd) removed.add(firstSeq + i); });

    const kept = [];
    let carry = []; // non-ad DATERANGE tags from removed blocks (session/timestamp metadata)
    segments.forEach((s, i) => {
      if (s.isAd) {
        carry.push(...s.tags.filter((t) => t.startsWith('#EXT-X-DATERANGE') && !isAdDaterange(t) && !['twitch-stream-source', 'twitch-trigger'].includes(daterangeClass(t))));
        return;
      }
      kept.push({ seq: firstSeq + i, tags: [...carry, ...s.tags.filter((t) => !isAdDaterange(t))], uri: s.uri });
      carry = [];
    });

    const renumber = (seq) => { let n = 0; for (const r of removed) if (r < seq) n++; return seq - n; };
    const newFirst = kept.length ? renumber(kept[0].seq) : renumber(firstSeq + segments.length);
    const out = header.map((l) => (l.startsWith('#EXT-X-MEDIA-SEQUENCE:') ? `#EXT-X-MEDIA-SEQUENCE:${newFirst}` : l));
    for (const k of kept) out.push(...k.tags, k.uri);
    out.push(...carry);
    // Prefetch hints point at upcoming segments; drop them while the tail is still an ad.
    if (!segments.length || !segments[segments.length - 1].isAd) out.push(...prefetch);
    out.push(...trailer);
    return `${out.join('\n')}\n`;
  };
}

// Twitch's player switches to a "picture-by-picture" ad layout (the stream shrunk beside an ad) when
// it sees this DATERANGE, which arrives shortly before a break, while the playlist is still ad-free.
// Condition taken from the player's metadata handler (2026-10-25).
const isPbypPreflight = (line) =>
  line.startsWith('#EXT-X-DATERANGE') && daterangeClass(line) === 'live-video-net-metadata' && /X-NET-LIVE-VIDEO-METADATA-TYPE="pbyp-preflight"/i.test(line);

export function removePbypPreflight(text) {
  if (!String(text ?? '').includes('pbyp-preflight')) return text;
  return lines(text).filter((l) => !isPbypPreflight(l)).join('\n');
}

// Stateless convenience for a single playlist.
export const stripAdSegments = (text) => createAdStripper()(text);

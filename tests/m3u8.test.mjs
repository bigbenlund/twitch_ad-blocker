import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, isStitchedAdPlaylist, getAdInfo, stripAdSegments, createAdStripper, removePbypPreflight } from '../src/lib/m3u8.js';
import { sessions } from './fixtures.js';

const all = sessions();
const playlists = all.flatMap((s) => s.playlists);
const uris = (text) => parsePlaylist(text).segments.map((s) => s.uri);
const liveUris = (text) => parsePlaylist(text).segments.filter((s) => !s.isAd).map((s) => s.uri);

test('fixtures are present and include both ad and clean playlists', () => {
  assert.ok(playlists.length > 50, `only ${playlists.length} playlists`);
  assert.ok(playlists.some((p) => isStitchedAdPlaylist(p.text)), 'no ad fixtures');
  assert.ok(playlists.some((p) => !isStitchedAdPlaylist(p.text)), 'no clean fixtures');
});

test('known captures classify as expected', () => {
  for (const s of all) {
    if (/\/(embed)$/.test(s.name) || s.name.includes('/caedrel/')) {
      for (const p of s.playlists) assert.equal(isStitchedAdPlaylist(p.text), false, p.path);
    }
    if (/fortnite\/site$|trymacs\/site$/.test(s.name)) {
      assert.equal(isStitchedAdPlaylist(s.playlists[0].text), true, s.playlists[0].path);
    }
  }
});

test('ad DATERANGE marker and ad segment titles agree in every fixture', () => {
  for (const p of playlists) {
    const hasClass = p.text.includes('CLASS="twitch-stitched-ad"');
    const hasAdSeg = parsePlaylist(p.text).segments.some((s) => s.isAd);
    assert.equal(hasClass, hasAdSeg, p.path);
  }
});

test('stripAdSegments removes every ad and keeps every live segment in order', () => {
  for (const p of playlists) {
    const out = stripAdSegments(p.text);
    assert.equal(isStitchedAdPlaylist(out), false, p.path);
    assert.ok(!/twitch-ad-quartile|twitch-stitched-ad/.test(out), p.path);
    assert.deepEqual(uris(out), liveUris(p.text), p.path);
  }
});

test('stripped output is structurally valid HLS', () => {
  for (const p of playlists) {
    const out = stripAdSegments(p.text);
    const ls = out.trim().split('\n');
    assert.equal(ls[0], '#EXTM3U', p.path);
    assert.equal(ls.filter((l) => l.startsWith('#EXTINF:')).length, ls.filter((l) => l && !l.startsWith('#')).length, p.path);
    assert.equal(ls.filter((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:')).length, 1, p.path);
    assert.ok(ls.includes('#EXT-X-TARGETDURATION:' + /#EXT-X-TARGETDURATION:(\d+)/.exec(p.text)[1]), p.path);
  }
});

test('clean playlists pass through unchanged', () => {
  for (const p of playlists.filter((p) => !isStitchedAdPlaylist(p.text))) {
    assert.equal(stripAdSegments(p.text).trim(), p.text.replace(/\r\n?/g, '\n').split('\n').filter(Boolean).join('\n'), p.path);
  }
});

test('live segments keep the same sequence number across refreshes (real sessions)', () => {
  for (const s of all) {
    const strip = createAdStripper();
    const seen = new Map();
    for (const p of s.playlists) {
      const out = parsePlaylist(strip(p.text));
      const first = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(out.header.join('\n'))[1]);
      out.segments.forEach((seg, i) => {
        if (seen.has(seg.uri)) assert.equal(first + i, seen.get(seg.uri), `${s.name}: ${seg.uri} renumbered`);
        seen.set(seg.uri, first + i);
      });
    }
  }
});

// Synthetic mid-roll: a sliding window over live → ads → live, built from the real tag format.
function syntheticWindow(firstSeq, kinds) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`];
  kinds.forEach((k, i) => {
    const seq = firstSeq + i;
    if (k === 'ad' && kinds[i - 1] !== 'ad') {
      out.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-25T16:46:00.081Z",DURATION=6.0');
      out.push('#EXT-X-DISCONTINUITY');
    }
    if (k === 'live' && kinds[i - 1] === 'ad') out.push('#EXT-X-DISCONTINUITY');
    out.push(`#EXTINF:2.000,${k === 'ad' ? 'DCM|1' : 'live'}`, `https://seg.example/${seq}.ts`);
  });
  return out.join('\n');
}

test('mid-roll: live numbering stays continuous and stable as the window slides', () => {
  const timeline = ['live', 'live', 'live', 'ad', 'ad', 'ad', 'live', 'live', 'live', 'live'];
  const strip = createAdStripper();
  const seen = new Map();
  for (let start = 0; start + 4 <= timeline.length; start++) {
    const text = syntheticWindow(100 + start, timeline.slice(start, start + 4));
    const out = parsePlaylist(strip(text));
    const first = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(out.header.join('\n'))[1]);
    out.segments.forEach((seg, i) => {
      if (seen.has(seg.uri)) assert.equal(first + i, seen.get(seg.uri), `window ${start}: ${seg.uri}`);
      seen.set(seg.uri, first + i);
    });
  }
  // Live segments 100,101,102,106.. → 100,101,102,103..: no gap where the ads were.
  assert.deepEqual([...seen].sort((a, b) => a[1] - b[1]).map(([, n]) => n), [100, 101, 102, 103, 104, 105, 106]);
});

test('getAdInfo reports duration and mid-roll position', () => {
  const pre = getAdInfo(syntheticWindow(0, ['ad', 'ad', 'ad', 'live']));
  assert.deepEqual(pre, { adSegments: 3, adDuration: 6, podDuration: null, isMidroll: false });
  const mid = getAdInfo(syntheticWindow(0, ['live', 'ad', 'ad']));
  assert.deepEqual(mid, { adSegments: 2, adDuration: 4, podDuration: null, isMidroll: true });
  const pod = syntheticWindow(0, ['ad']).replace('DURATION=6.0', 'DURATION=6.0,X-TV-TWITCH-AD-POD-FILLED-DURATION="60"');
  assert.equal(getAdInfo(pod).podDuration, 60);
});

test('edge cases', () => {
  assert.equal(isStitchedAdPlaylist(''), false);
  assert.equal(stripAdSegments('#EXTM3U\n'), '#EXTM3U\n');
  // CRLF input
  const crlf = syntheticWindow(5, ['ad', 'live']).replace(/\n/g, '\r\n');
  assert.equal(isStitchedAdPlaylist(crlf), true);
  assert.deepEqual(uris(stripAdSegments(crlf)), ['https://seg.example/6.ts']);
  // All-ad playlist: no segments; sequence advances past the removed ads
  const allAd = stripAdSegments(syntheticWindow(10, ['ad', 'ad']));
  assert.equal(uris(allAd).length, 0);
  assert.match(allAd, /#EXT-X-MEDIA-SEQUENCE:10\n/);
  // Unknown tags are preserved
  const unk = syntheticWindow(0, ['live']).replace('#EXTINF', '#EXT-X-FUTURE-TAG:1\n#EXTINF');
  assert.match(stripAdSegments(unk), /#EXT-X-FUTURE-TAG:1/);
});

test('regressions from step 3 review', () => {
  // Mid-roll label wins even when the whole window is ads
  const midAll = syntheticWindow(0, ['ad', 'ad', 'ad']).replace('DURATION=6.0', 'DURATION=6.0,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"');
  assert.equal(getAdInfo(midAll).isMidroll, true);
  const pre = syntheticWindow(0, ['live', 'ad']).replace('DURATION=6.0', 'DURATION=6.0,X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"');
  assert.equal(getAdInfo(pre).isMidroll, false);
  // CLASS must be its own attribute
  assert.equal(isStitchedAdPlaylist('#EXT-X-DATERANGE:ID="x",X-FOO-CLASS="twitch-stitched-ad",CLASS="other"'), false);
  assert.equal(isStitchedAdPlaylist('#EXT-X-DATERANGE:ID="x",X-CLASS="foo",CLASS="twitch-stitched-ad"'), true);
  // Null input
  assert.equal(isStitchedAdPlaylist(null), false);
  assert.doesNotThrow(() => stripAdSegments(undefined));
  // EXTINF variants still recognise ads
  assert.equal(isStitchedAdPlaylist('#EXTM3U\n#EXTINF: 2.0,DCM|1\nhttps://a/1.ts'), true);
  assert.equal(isStitchedAdPlaylist('#EXTM3U\n#EXTINF:2.0 foo="1",DCM|1\nhttps://a/1.ts'), true);
  assert.equal(isStitchedAdPlaylist('#EXTM3U\n#EXTINF:2.0,Live\nhttps://a/1.ts'), false);
  // Sequence reset clears old removals
  const strip = createAdStripper();
  strip(syntheticWindow(100, ['live', 'ad', 'ad', 'live']));
  const after = strip(syntheticWindow(5, ['live', 'live']));
  assert.match(after, /#EXT-X-MEDIA-SEQUENCE:5\n/);
});

test('removePbypPreflight drops only the picture-by-picture trigger', () => {
  const preflight = '#EXT-X-DATERANGE:ID="pbyp-1",CLASS="live-video-net-metadata",START-DATE="2026-10-25T16:46:00.081Z",X-NET-LIVE-VIDEO-METADATA-TYPE="pbyp-preflight",X-NET-LIVE-VIDEO-METADATA-PBYP-COMMERCIAL-ID="abc",X-NET-LIVE-VIDEO-METADATA-PBYP-WARMUP-TIME="10"';
  const otherMeta = '#EXT-X-DATERANGE:ID="m-1",CLASS="live-video-net-metadata",START-DATE="2026-10-25T16:46:00.081Z",X-NET-LIVE-VIDEO-METADATA-TYPE="something-else"';
  const base = syntheticWindow(0, ['live', 'live']);
  const withTags = base.replace('#EXTINF', `${preflight}\n${otherMeta}\n#EXTINF`);
  const out = removePbypPreflight(withTags);
  assert.ok(!out.includes('pbyp-preflight'));
  assert.ok(out.includes(otherMeta));
  assert.deepEqual(uris(out), uris(base));
  // Attribute order doesn't matter
  const reordered = '#EXT-X-DATERANGE:X-NET-LIVE-VIDEO-METADATA-TYPE="pbyp-preflight",ID="p",CLASS="live-video-net-metadata"';
  assert.ok(!removePbypPreflight(`${base}\n${reordered}`).includes('pbyp-preflight'));
  // Playlists without the tag are returned as-is (same string)
  assert.equal(removePbypPreflight(base), base);
  for (const p of playlists) assert.equal(removePbypPreflight(p.text), p.text, p.path);
});

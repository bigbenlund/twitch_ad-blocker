import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessTokenRequest, readAccessToken, swapUsherToken, channelFromUsherUrl, parseMaster, pickVariant } from '../src/lib/token.js';
import { masters } from './fixtures.js';

const USHER = 'https://usher.ttvnw.net/api/v2/channel/hls/Fortnite.m3u8?acmb=abc&allow_source=true&sig=OLD&token=OLDTOK&p=1&play_session_id=aaaa&supported_codecs=av1%2Ch265%2Ch264';

test('buildAccessTokenRequest targets GQL with the requested player type', () => {
  const { url, init } = buildAccessTokenRequest('fortnite', 'embed', { 'Device-ID': 'x' });
  assert.equal(url, 'https://gql.twitch.tv/gql');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Device-ID'], 'x');
  const body = JSON.parse(init.body);
  assert.equal(body.variables.login, 'fortnite');
  assert.equal(body.variables.playerType, 'embed');
  assert.match(body.query, /streamPlaybackAccessToken/);
});

test('readAccessToken', () => {
  assert.deepEqual(readAccessToken({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }), { value: 'v', signature: 's' });
  assert.equal(readAccessToken({ data: { streamPlaybackAccessToken: null } }), null);
  assert.equal(readAccessToken(undefined), null);
});

test('swapUsherToken replaces credentials and keeps other params', () => {
  const u = new URL(swapUsherToken(USHER, { value: '{"a":1}', signature: 'NEW' }));
  assert.equal(u.searchParams.get('sig'), 'NEW');
  assert.equal(u.searchParams.get('token'), '{"a":1}');
  assert.equal(u.searchParams.get('acmb'), 'abc');
  assert.equal(u.searchParams.get('supported_codecs'), 'av1,h265,h264');
  assert.notEqual(u.searchParams.get('play_session_id'), 'aaaa');
  assert.equal(u.pathname, '/api/v2/channel/hls/Fortnite.m3u8');
});

test('channelFromUsherUrl', () => {
  assert.equal(channelFromUsherUrl(USHER), 'fortnite');
  assert.equal(channelFromUsherUrl('https://usher.ttvnw.net/api/channel/hls/trymacs.m3u8?x=1'), 'trymacs');
  assert.equal(channelFromUsherUrl('https://example.com/other'), null);
});

test('parseMaster reads every variant in captured masters', () => {
  const ms = masters();
  assert.ok(ms.length > 0);
  for (const m of ms) {
    const vs = parseMaster(m.text);
    assert.ok(vs.length >= 2, m.path);
    for (const v of vs) {
      assert.ok(v.uri?.startsWith('https://'), m.path);
      assert.ok(v.bandwidth > 0, m.path);
      assert.ok(v.name, m.path);
    }
  }
});

test('pickVariant matches resolution and frame rate, else falls back by bandwidth', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)"',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"',
    'https://a/1080.m3u8',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO="720p60"',
    'https://a/720p60.m3u8',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p30",NAME="720p"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2300000,RESOLUTION=1280x720,FRAME-RATE=30.000,VIDEO="720p30"',
    'https://a/720p30.m3u8',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=852x480,FRAME-RATE=30.000,VIDEO="480p30"',
    'https://a/480.m3u8',
  ].join('\n');
  assert.equal(pickVariant(master, { resolution: '1280x720', frameRate: 30 }), 'https://a/720p30.m3u8');
  assert.equal(pickVariant(master, { resolution: '1280x720', frameRate: 60 }), 'https://a/720p60.m3u8');
  assert.equal(pickVariant(master, { resolution: '2560x1440', bandwidth: 2500000 }), 'https://a/720p30.m3u8');
  assert.equal(pickVariant(master, { resolution: '1x1', bandwidth: 10 }), 'https://a/480.m3u8');
  assert.equal(pickVariant(master, null), 'https://a/1080.m3u8');
  assert.equal(pickVariant('#EXTM3U\n', null), null);
});

test('parseMaster/pickVariant regressions from step 3 review', () => {
  const noUri = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=2x2\nhttps://v/2.m3u8';
  assert.deepEqual(parseMaster(noUri).map((v) => v.uri), [null, 'https://v/2.m3u8']);
  const withAudio = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2"', 'https://a/audio_only.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360', 'https://a/360.m3u8',
  ].join('\n');
  assert.equal(pickVariant(withAudio, { resolution: '1x1', bandwidth: 200000 }), 'https://a/360.m3u8');
});

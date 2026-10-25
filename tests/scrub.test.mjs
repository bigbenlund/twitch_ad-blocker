import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { scrub } from '../scripts/scrub.mjs';

const redacts = (input, secret) => {
  const out = scrub(input);
  assert.ok(!out.includes(secret), `leaked ${secret} in: ${out}`);
  return out;
};

test('IP addresses in every observed and plausible form', () => {
  redacts('USER-IP="203.0.113.81"', '203.0.113.81');
  redacts('USER-IP="2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff"', '2001:db8');
  redacts('x 2001:db8:1::1 y', '2001:db8:1::1');
  redacts('2001:db8:85a3::8a2e:370:7334', '8a2e:370:7334');
  redacts('#EXT-X-SESSION-DATA:DATA-ID="USER-IP",VALUE="2001:db8:1::1"', '2001:db8:1::1');
  redacts('{"user_ip" : "10.1.2.3"}', '10.1.2.3');
  redacts('{\\"user_ip\\":\\"2001:db8:1::1\\"}', '2001:db8:1::1');
  redacts('token=%7B%22user_ip%22%3A%222001%3Adb8%3A%3A1%22%7D', '2001%3Adb8');
  assert.equal(scrub('::ffff:203.0.113.7').includes('203.0.113.7'), false);
});

test('tokens, signatures, session and device IDs', () => {
  redacts('"sig": "13b1aa00ff13b1aa00ff13b1aa00ff13b1aa00ff"', '13b1aa00ff13b1aa00ff');
  redacts('{"signature":"b381deadbeef"}', 'b381deadbeef');
  redacts('?a=1&sig=abc123&token=xyz', 'abc123');
  redacts('url%26sig%3Dabc123%26token%3Dxyz', 'abc123');
  redacts('#EXT-X-SESSION-DATA:DATA-ID="SERVING-ID",VALUE="48f86cd7aa"', '48f86cd7aa');
  redacts('#EXT-X-SESSION-DATA:DATA-ID="VIDEO-SESSION-ID",VALUE="538223065171942675"', '538223065171942675');
  redacts('X-TV-TWITCH-SESSIONID="1804946411663523660"', '1804946411663523660');
  redacts('X-TV-TWITCH-AD-AD-SESSION-ID="6f9245f228ac4b85b75e8b8d416ea3e3"', '6f9245f228ac');
  redacts('X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://s.amazon-adsystem.com/iui3?cb=11215"', 'cb=11215');
  redacts('X-Device-Id: abcdef0123456789abcdef0123456789', 'abcdef0123456789');
  redacts('Authorization: OAuth secret123', 'secret123');
  redacts('play_session_id=6cf2bbe070c54b1fac08c5f2dfe5f2c4&x=1', '6cf2bbe070c5');
  redacts('a'.repeat(60) + '0123456789abcdef'.repeat(4), '0123456789abcdef0123');
  redacts(`seg/${'Ab+/'.repeat(30)}`, 'Ab+/Ab+/Ab+/Ab+/Ab+/');
});

test('keeps non-identifying data intact', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
  assert.equal(scrub(ua), ua);
  const seg = '#EXT-X-PROGRAM-DATE-TIME:2026-10-25T16:42:15.237Z\n#EXTINF:2.002,DCM|263341067\n#EXT-X-MEDIA-SEQUENCE:4871';
  assert.equal(scrub(seg), seg);
  const daterange = '#EXT-X-DATERANGE:ID="stitched-ad-1792946760-15223999992",CLASS="twitch-stitched-ad",START-DATE="2026-10-25T16:46:00.081Z",DURATION=15.224';
  assert.equal(scrub(daterange), daterange);
  assert.equal(scrub('X-SERVER-TIME="1792946565.07"'), 'X-SERVER-TIME="1792946565.07"');
});

test('idempotent', () => {
  const s = scrub('USER-IP="1.2.3.4" sig=abc "signature":"x" 2001:db8:1::1');
  assert.equal(scrub(s), s);
});

test('no committed fixture contains an IP or long hex ID', () => {
  const files = execFileSync('git', ['ls-files', 'tests/fixtures'], { encoding: 'utf8' }).split('\n').filter((f) => f && existsSync(f));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(scrub(text), text, `${f} is not fully scrubbed`);
  }
});

// Redacts identifying data from captured Twitch responses before they are saved.
// Idempotent: re-scrubbing scrubbed text changes nothing.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const hashed = (s) => `OPAQUE_${short(s)}`;

// Session/device identifiers in playlist attributes (both KEY="v" and DATA-ID="KEY",VALUE="v" forms).
const ID_KEYS = 'USER-IP|SERVING-ID|VIDEO-SESSION-ID|SESSIONID|AD-SESSION-ID|CLICK-BEACON-ID|RADS-TOKEN';
// Ad tracking attributes carry per-impression URLs and IDs; tests never need their values.
const AD_TRACKING = /(X-TV-TWITCH-AD-[A-Z-]*(?:URL|TRACKING[A-Z-]*|ADVERIFICATIONS)=")[^"]*"/g;
// JSON fields (plain, escaped inside a token string, or URL-encoded).
const JSON_KEYS = 'user_ip|device_id|sig|signature|token|play_session_id|session_id';
const SECRET_HEADER_LINE = /^(cookie|set-cookie|authorization|client-integrity|x-device-id|device-id)\s*:.*$/gim;

export function scrub(text) {
  return text
    .replace(SECRET_HEADER_LINE, '$1: REDACTED')
    .replace(new RegExp(`(DATA-ID="(?:${ID_KEYS})",VALUE=")[^"]*"`, 'g'), '$1REDACTED"')
    .replace(new RegExp(`((?:^|[,:])(?:X-TV-TWITCH-)?(?:${ID_KEYS})=")[^"]*"`, 'gm'), '$1REDACTED"')
    .replace(AD_TRACKING, '$1REDACTED"')
    .replace(new RegExp(`(\\\\?"(?:${JSON_KEYS})\\\\?"\\s*:\\s*\\\\?")[^"\\\\]*`, 'g'), '$1REDACTED')
    .replace(new RegExp(`(%22(?:${JSON_KEYS})%22%3A%22)[^%]*`, 'gi'), '$1REDACTED')
    // Signed query params, plain or URL-encoded
    .replace(/([?&](?:sig|token|play_session_id)=)[^&"\s]*/g, '$1REDACTED')
    .replace(/(%26(?:sig|token)%3D)[^%&"\s]*/gi, '$1REDACTED')
    // Any IP address, IPv4 or IPv6 (including compressed and v4-mapped forms). Version strings
    // like "Chrome/156.0.0.0" are kept: an address right after "/" is not redacted.
    .replace(/(^|[^\w/.:])([0-9A-Fa-f:.]*[:.][0-9A-Fa-f:.]*)(?=$|[^\w.:])/g, (m, pre, cand) => {
      const trimmed = cand.replace(/^[:.]+(?!:)|\.+$/g, (x) => (x.startsWith('::') ? x : ''));
      return isIP(cand) || isIP(trimmed) ? `${pre}REDACTED-IP` : m;
    })
    // Long opaque tokens and hex IDs. Same input → same hash, so playlists stay comparable.
    .replace(/[A-Za-z0-9_+/-]{80,}={0,2}/g, hashed)
    .replace(/\b[0-9a-f]{32,}\b/g, hashed);
}

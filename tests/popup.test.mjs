import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// popup.js runs top-level chrome.* calls; evaluate only channelFromUrl.
const src = readFileSync(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
const lib = src.slice(src.indexOf('// First path segments'), src.indexOf('const [tab]')).replace('export function', 'function');
const channelFromUrl = new Function(`${lib}; return channelFromUrl;`)();

test('channelFromUrl', () => {
  const cases = {
    'https://www.twitch.tv/Shroud': 'shroud',
    'https://www.twitch.tv/shroud/videos': 'shroud',
    'https://m.twitch.tv/shroud': 'shroud',
    'https://twitch.tv/shroud': 'shroud',
    'https://player.twitch.tv/?channel=Shroud': 'shroud',
    'https://www.twitch.tv/popout/shroud/chat': 'shroud',
    'https://www.twitch.tv/popout/shroud/video': 'shroud',
    'https://www.twitch.tv/embed/shroud/chat': 'shroud',
    'https://www.twitch.tv/moderator/shroud': 'shroud',
    'https://www.twitch.tv/directory': null,
    'https://www.twitch.tv/directory/category/x': null,
    'https://www.twitch.tv/': null,
    'https://www.twitch.tv/messages': null,
    'https://www.twitch.tv/team/x': null,
    'https://www.twitch.tv/subs/x': null,
    'https://m.twitch.tv/clip/x': null,
    'https://clips.twitch.tv/Slug': null,
    'https://dashboard.twitch.tv/u/x': null,
    'https://player.twitch.tv/?video=1': null,
    'https://youtube.com/shroud': null,
    'https://eviltwitch.tv/shroud': null,
    'https://twitch.tv.evil.com/shroud': null,
    'chrome://extensions': null,
    '': null,
  };
  for (const [url, want] of Object.entries(cases)) assert.equal(channelFromUrl(url), want, url);
});

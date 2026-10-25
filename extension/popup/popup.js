const $ = (id) => document.getElementById(id);

// First path segments that are Twitch pages, not channels.
const NOT_CHANNELS = new Set(['directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'search', 'downloads', 'turbo', 'p', 'jobs', 'messages', 'friends', 'prime', 'store', 'login', 'signup', 'following', 'team', 'subs', 'clip', 'clips', 'u', 'privacy', 'legal']);
// Paths whose channel is the second segment: /popout/<ch>/..., /embed/<ch>/..., /moderator/<ch>.
const NESTED = new Set(['popout', 'embed', 'moderator']);
const CHANNEL_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'player.twitch.tv']);

export function channelFromUrl(url) {
  try {
    const u = new URL(url);
    if (!CHANNEL_HOSTS.has(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean).map((p) => p.toLowerCase());
    const name = u.hostname === 'player.twitch.tv' ? u.searchParams.get('channel')?.toLowerCase() : NESTED.has(parts[0]) ? parts[1] : parts[0];
    return name && /^[a-z0-9_]{1,25}$/.test(name) && !NOT_CHANNELS.has(name) ? name : null;
  } catch {
    return null;
  }
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
// tab.url is only visible on twitch.tv pages (host permission), so other sites give null.
const channel = channelFromUrl(tab?.url ?? '');

async function render() {
  const { enabled = true, allowlist = [] } = await chrome.storage.local.get(['enabled', 'allowlist']);
  const { stats = {}, log = [] } = await chrome.storage.session.get(['stats', 'log']);

  $('enabled').checked = enabled;

  $('channel-name').textContent = channel ?? 'Not on a Twitch channel';
  const allowed = channel && allowlist.includes(channel);
  $('allow-toggle').hidden = !channel;
  $('allow-toggle').textContent = allowed ? 'Block ads here' : 'Allow ads here';
  $('allow-toggle').className = allowed ? '' : 'secondary';

  const s = stats[tab?.id] ?? { adsBlocked: 0, swapped: 0, stripped: 0 };
  $('stat-ads').textContent = s.adsBlocked;
  $('stat-swapped').textContent = s.swapped;
  $('stat-stripped').textContent = s.stripped;

  $('allowlist').replaceChildren(...allowlist.map((name) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = 'Remove';
    b.className = 'secondary';
    b.onclick = () => setAllowlist(allowlist.filter((n) => n !== name));
    const span = document.createElement('span');
    span.textContent = name;
    span.title = name;
    li.append(span, b);
    return li;
  }));
  $('allowlist-empty').hidden = allowlist.length > 0;

  $('log').replaceChildren(...log.slice(-50).reverse().map((e) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = e.type;
    li.append(`${e.at.slice(11, 19)} `, b, ` ${detail(e)}`);
    li.title = JSON.stringify(e);
    return li;
  }));
}

const FIRST = ['playerType', 'variant', 'podDuration', 'adDuration', 'via', 'error'];
const detail = ({ type, at, tabId, channel, ...rest }) =>
  [...FIRST.filter((k) => rest[k] != null).map((k) => [k, rest[k]]), ...Object.entries(rest).filter(([k]) => !FIRST.includes(k)), ['channel', channel]]
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
const setAllowlist = (allowlist) => chrome.storage.local.set({ allowlist });

$('enabled').onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$('allow-toggle').onclick = async () => {
  const { allowlist = [] } = await chrome.storage.local.get('allowlist');
  await setAllowlist(allowlist.includes(channel) ? allowlist.filter((n) => n !== channel) : [...allowlist, channel]);
};
$('copy-log').onclick = async () => {
  const { log = [] } = await chrome.storage.session.get('log');
  const { version } = chrome.runtime.getManifest();
  // Events hold only channel names, event types and ad metadata; strip tab IDs anyway.
  const text = JSON.stringify({ version, userAgent: navigator.userAgent, log: log.map(({ tabId, ...e }) => e) }, null, 1);
  await navigator.clipboard.writeText(text);
  $('copy-log').textContent = 'Copied';
  setTimeout(() => ($('copy-log').textContent = 'Copy log'), 1500);
};

chrome.storage.onChanged.addListener(render);
render();

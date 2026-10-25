// Debug log (ring buffer in session storage, so it survives service worker restarts), per-tab
// stats and badge, each tab's current channel, and network-rule exceptions for allowlisted channels.
const LOG_LIMIT = 1000;
const RULESET = 'trackers';
// Session "allow" rules override the static block rules for tabs on allowlisted channels, so a
// streamer still gets ad measurement when the user chooses to watch their ads.
const ALLOW_PRIORITY = 2;
const BLOCKED_DOMAINS = ['amazon-adsystem.com', 'scorecardresearch.com', 'imrworldwide.com'];
const CHANNEL = /^[a-z0-9_]{1,25}$/;

let queue = Promise.resolve();
const serialize = (fn) => (queue = queue.then(fn, fn));

let playerTypes = null;
async function getSettings() {
  playerTypes ??= (await fetch(chrome.runtime.getURL('data/player-types.json')).then((r) => r.json())).playerTypes;
  // playerTypesOverride (testing): [] forces the strip fallback.
  const { enabled = true, allowlist = [], verbose = false, playerTypesOverride } = await chrome.storage.local.get(['enabled', 'allowlist', 'verbose', 'playerTypesOverride']);
  return { enabled, allowlist, verbose, playerTypes: playerTypesOverride ?? playerTypes };
}

// Brings network rules in line with settings: ruleset off when disabled, allow rules per tab
// whose channel is allowlisted.
async function syncRules() {
  const { enabled, allowlist } = await getSettings();
  const { tabChannels = {} } = await chrome.storage.session.get('tabChannels');
  await chrome.declarativeNetRequest.updateEnabledRulesets(enabled ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] });
  const existing = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
  // Session rule IDs must be positive integers; tab IDs are, but check rather than assume.
  const allowTabs = Object.entries(tabChannels).filter(([, ch]) => allowlist.includes(ch)).map(([tabId]) => Number(tabId)).filter((id) => Number.isInteger(id) && id > 0);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing,
    addRules: allowTabs.map((tabId) => ({
      id: tabId,
      priority: ALLOW_PRIORITY,
      action: { type: 'allow' },
      condition: { tabIds: [tabId], requestDomains: BLOCKED_DOMAINS },
    })),
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'get-settings') {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg?.type !== 'event' || !sender.tab) return;
  const tabId = sender.tab.id;
  const event = { ...msg.event, tabId, at: new Date().toISOString() };
  serialize(async () => {
    const { log = [], stats = {}, tabChannels = {} } = await chrome.storage.session.get(['log', 'stats', 'tabChannels']);
    log.push(event);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    const s = (stats[tabId] ??= { adsBlocked: 0, swapped: 0, stripped: 0 });
    // One ad break counts once, however many playlist refreshes it spans (verbose logs them all).
    if ((event.type === 'swapped' || event.type === 'stripped') && event.firstInBreak) {
      s[event.type]++;
      s.adsBlocked++;
    }
    // The channel becomes a network-rule exception, so accept only valid Twitch login names.
    const channelChanged = event.type === 'usher' && CHANNEL.test(event.channel ?? '') && tabChannels[tabId] !== event.channel;
    if (channelChanged) tabChannels[tabId] = event.channel;
    await chrome.storage.session.set({ log, stats, tabChannels });
    if (s.adsBlocked) await chrome.action.setBadgeText({ tabId, text: String(s.adsBlocked) });
    if (channelChanged) await syncRules();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('enabled' in changes || 'allowlist' in changes)) serialize(syncRules);
});

chrome.tabs.onRemoved.addListener((tabId) => serialize(async () => {
  const { stats = {}, tabChannels = {} } = await chrome.storage.session.get(['stats', 'tabChannels']);
  delete stats[tabId];
  delete tabChannels[tabId];
  await chrome.storage.session.set({ stats, tabChannels });
  await syncRules();
}));

// A tab that leaves Twitch: tab.url is only visible for twitch.tv pages (host permission), so an
// undefined url means the tab navigated elsewhere.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || tab.url) return;
  serialize(async () => {
    const { tabChannels = {} } = await chrome.storage.session.get('tabChannels');
    if (!(tabId in tabChannels)) return;
    delete tabChannels[tabId];
    await chrome.storage.session.set({ tabChannels });
    await syncRules();
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.action.setBadgeBackgroundColor({ color: '#6441a5' });
  await serialize(syncRules);
});
chrome.runtime.onStartup.addListener(() => serialize(syncRules));

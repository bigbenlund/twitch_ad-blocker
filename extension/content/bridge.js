// Isolated world. Connects the MAIN-world hook (via a private MessagePort) to the background
// service worker, and pushes settings into the page.
(() => {
  let port = null;

  const pushSettings = async () => {
    if (!port) return;
    const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
    if (settings) port.postMessage({ type: 'settings', settings });
  };

  // The MAIN-world script posts its port before any page script has run; accept only the first.
  const onInit = (e) => {
    if (e.source !== window || e.data?.type !== 'streamshield-init' || !e.ports?.[0]) return;
    window.removeEventListener('message', onInit, true);
    e.stopImmediatePropagation();
    port = e.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'event') chrome.runtime.sendMessage({ type: 'event', event: data.event }).catch(() => {});
    };
    pushSettings();
  };
  window.addEventListener('message', onInit, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('enabled' in changes || 'allowlist' in changes || 'verbose' in changes || 'playerTypesOverride' in changes)) pushSettings();
  });
})();

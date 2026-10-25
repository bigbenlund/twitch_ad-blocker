// Isolated world. Connects the MAIN-world hook (via a private MessagePort) to the background
// service worker, and pushes settings into the page.
(() => {
  let port = null;

  // After the extension is reloaded or updated, this script keeps running in already-open tabs but
  // its chrome.* APIs are gone ("Extension context invalidated"), and sendMessage throws
  // synchronously. Detach quietly; the page and worker hooks keep blocking with their last settings
  // until the tab is refreshed.
  const contextValid = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const detach = () => {
    if (port) port.onmessage = null;
    port = null;
  };
  const send = async (msg) => {
    if (!contextValid()) return detach();
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      if (!contextValid()) detach();
    }
  };

  const pushSettings = async () => {
    if (!port) return;
    const settings = await send({ type: 'get-settings' });
    if (settings) port?.postMessage({ type: 'settings', settings });
  };

  // The MAIN-world script posts its port before any page script has run; accept only the first.
  const onInit = (e) => {
    if (e.source !== window || e.data?.type !== 'streamshield-init' || !e.ports?.[0]) return;
    window.removeEventListener('message', onInit, true);
    e.stopImmediatePropagation();
    port = e.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'event') send({ type: 'event', event: data.event });
    };
    pushSettings();
  };
  window.addEventListener('message', onInit, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('enabled' in changes || 'allowlist' in changes || 'verbose' in changes || 'playerTypesOverride' in changes)) pushSettings();
  });
})();

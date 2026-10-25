// MAIN world, document_start. Wraps window.Worker so Twitch's player worker runs the worker hook
// before the player code, and relays events/settings between the worker and bridge.js.
// The worker hook source placeholder below is substituted by scripts/build.mjs.
//
// This runs in the page's own JavaScript realm, so everything it relies on is captured here, before
// any page script runs: page code may later patch globals and prototypes to observe or forge our
// messages. (A determined page can still detect this script; it can't read the key or the port.)
(() => {
  /* PAGE_LIBS */

  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const stringify = JSON.stringify;
  const NativeBlob = Blob;
  const createObjectURL = URL.createObjectURL;
  const NativeXHR = XMLHttpRequest;
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrStatus = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'status').get;
  const xhrText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;
  const workerPost = Worker.prototype.postMessage;
  const portPost = MessagePort.prototype.postMessage;
  const portStart = MessagePort.prototype.start;
  const addListener = EventTarget.prototype.addEventListener;
  const stopImmediate = Event.prototype.stopImmediatePropagation;
  const eventData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
  const regexTest = RegExp.prototype.test;
  const startsWith = String.prototype.startsWith;
  const randomUUID = crypto.randomUUID.bind(crypto);
  const NativeURL = URL;
  const NativeWeakRef = WeakRef;
  const NativeResponse = Response;
  const responseText = Response.prototype.text;
  const parseJSON = JSON.parse;
  const nativeFetch = window.fetch;

  // Private channel to bridge.js. Posted before any page script runs, so only the bridge sees it.
  const channel = new MessageChannel();
  const port = channel.port1;
  window.postMessage({ type: 'streamshield-init' }, '*', [channel.port2]);

  // Shared secret with the worker hook, sent to each hooked worker by message (never in its source),
  // so page scripts holding a Worker can't inject settings or forge events.
  const KEY = randomUUID();
  const NS = '__streamshield';
  const HOOK_SRC = `${WORKER_HOOK_SRC}\n;\n`;

  let settings = null;
  let currentChannel = null; // from the player's usher request (worker 'usher' events)
  const workers = new Set(); // WeakRefs; Twitch creates new workers on SPA navigation
  const emit = (type, data = {}) => apply(portPost, port, [{ type: 'event', event: { type, ...data } }]);
  const sendSettings = (w) => settings && apply(workerPost, w, [{ [NS]: 'settings', key: KEY, settings }]);

  apply(addListener, port, ['message', (e) => {
    const data = apply(eventData, e, []);
    if (data?.type !== 'settings') return;
    settings = data.settings;
    for (const ref of workers) {
      const w = ref.deref();
      if (w) sendSettings(w);
      else workers.delete(ref);
    }
  }]);
  apply(portStart, port, []);

  const PLAYER_WORKER = /amazon-ivs-wasmworker/;
  const matches = (re, s) => apply(regexTest, re, [s]);
  const readBlobSync = (href) => {
    try {
      const xhr = new NativeXHR();
      apply(xhrOpen, xhr, ['GET', href, false]);
      apply(xhrSend, xhr, []);
      const status = apply(xhrStatus, xhr, []);
      return status === 200 || status === 0 ? apply(xhrText, xhr, []) : null;
    } catch {
      return null;
    }
  };

  // Returns the hooked worker URL, or null to construct the original worker untouched.
  const hookedUrl = (url, options) => {
    if (options?.type === 'module') return null;
    const href = url instanceof NativeURL ? url.href : String(url);
    let src = null;
    if (apply(startsWith, href, ['blob:'])) src = readBlobSync(href);
    else if (matches(PLAYER_WORKER, href)) src = `importScripts(${apply(stringify, JSON, [new NativeURL(href, location.href).href])});`;
    if (!src || !matches(PLAYER_WORKER, src)) return null;
    return apply(createObjectURL, NativeURL, [construct(NativeBlob, [[HOOK_SRC, src], { type: 'text/javascript' }])]);
  };

  // A Proxy keeps Worker.prototype and instanceof native; constructor and toString are patched below.
  const NativeWorker = window.Worker;
  const WorkerProxy = new Proxy(NativeWorker, {
    construct(target, [url, options], newTarget) {
      const hooked = hookedUrl(url, options);
      const worker = construct(target, [hooked ?? url, options], newTarget);
      if (!hooked) return worker;
      // Queued before anything Twitch posts, so the hook has the key before the player starts.
      apply(workerPost, worker, [{ [NS]: 'init', key: KEY }]);
      // Registered before Twitch's own listeners, so our messages never reach the player.
      apply(addListener, worker, ['message', (e) => {
        const data = apply(eventData, e, []);
        if (data?.[NS] !== 'event') return;
        apply(stopImmediate, e, []);
        // Synthetic events (dispatchEvent from page scripts) are untrusted; isTrusted is an unforgeable
        // own property. Real worker messages also carry the key.
        if (!e.isTrusted || data.key !== KEY) return;
        if (data.event.type === 'usher') currentChannel = data.event.channel;
        emit(data.event.type, data.event);
      }]);
      workers.add(new NativeWeakRef(worker));
      sendSettings(worker);
      emit('worker-created', { hooked: true });
      return worker;
    },
  });
  Object.defineProperty(NativeWorker.prototype, 'constructor', { value: WorkerProxy, writable: true, configurable: true, enumerable: false });
  window.Worker = WorkerProxy;

  // Wrapped natives print as the originals (Function.prototype.toString).
  const masked = new Map([[WorkerProxy, NativeWorker]]);
  const nativeToString = Function.prototype.toString;
  const toStringProxy = new Proxy(nativeToString, {
    apply(target, self, args) {
      if (self === toStringProxy) return apply(target, nativeToString, args);
      return apply(target, masked.get(self) ?? self, args);
    },
  });
  Function.prototype.toString = toStringProxy;

  // Client-side ads (e.g. the picture-by-picture ad beside the stream) come from a GraphQL request the
  // page makes itself. Let it through, then answer "no ad available" (see src/lib/gql.js).
  const blockingHere = () => (settings?.enabled ?? true) && !(settings?.allowlist ?? []).includes(currentChannel);
  const fetchProxy = new Proxy(nativeFetch, {
    apply(target, self, args) {
      const [input, init] = args;
      const href = typeof input === 'string' ? input : input instanceof NativeURL ? input.href : '';
      if (!apply(startsWith, href, ['https://gql.twitch.tv/']) || !isClientAdRequest(init?.body) || !blockingHere()) {
        return apply(target, self, args);
      }
      return apply(target, self, args).then(async (res) => {
        try {
          const json = apply(parseJSON, JSON, [await apply(responseText, res.clone(), [])]);
          const removed = removeClientAds(init.body, json);
          if (!removed.length) return res;
          emit('client-ad-blocked', { formats: removed.join(','), channel: currentChannel });
          return construct(NativeResponse, [apply(stringify, JSON, [json]), { status: res.status, statusText: res.statusText, headers: res.headers }]);
        } catch {
          return res;
        }
      });
    },
  });

  masked.set(fetchProxy, nativeFetch);
  window.fetch = fetchProxy;

  emit('hook-installed', { frame: location.hostname + location.pathname });
})();

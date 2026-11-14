'use strict';
importScripts('rules.js', 'tree.js', 'logs.js', 'perf.js');
const HOST = 'io.github.darkov19.windows_chrome_bridge',
  VERSION = chrome.runtime.getManifest().version,
  MAX_RESULT_BYTES = 15 * 1024 * 1024,
  MAX_IMAGE_CHARS = 14 * 1024 * 1024,
  // A screenshot that goes to the agent as an image is at most this many pixels wide and high, unless
  // maxSize says otherwise. Models refuse or shrink bigger images (Claude: 8000 px, and 2000 px
  // when a request has many images). A screenshot saved to a file keeps its full size.
  INLINE_IMAGE_MAX = 2000,
  // A full-page image in the result is never scaled below this. A taller page shows its top part.
  MIN_PAGE_SCALE = 0.5,
  // Pages with more fields than this keep what each field's element said (see frameItems).
  MANY_FIELDS = 200,
  // Network and console lists keep this many pages (navigations) of each tab.
  PAGES_KEPT = 3,
  MAX_REQUESTS = 1000,
  MAX_MESSAGES = 1000;
const claims = new Map(),
  sessions = new Map(),
  logs = new Map(),
  children = new Map(),
  dialogs = new Map(),
  downloadClaims = new Map(),
  inflight = new Set(),
  inputAcks = new Map(),
  // Tabs that cleanup and disconnect leave open (qa_tabs keep).
  kept = new Set();
let port,
  attempts = 0,
  retryTimer,
  // The instance of this release: "" for a normal install, or a name such as "test" for a second,
  // separate install (see CONTRIBUTING.md). manage.py writes instance.json. The instance names the
  // native host and the downloads folder, so nothing connects before it is read.
  INSTANCE = null;
const instanceRead = fetch(chrome.runtime.getURL('instance.json'))
  .then(r => r.json())
  .then(j => {
    if (typeof j.instance !== 'string' || !/^([a-z][a-z0-9]{0,15})?$/.test(j.instance))
      throw Error('instance.json: instance must be "" or a-z and 0-9, up to 16 letters');
    INSTANCE = j.instance;
  });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Output that the MCP server turns into a file, plain text or an image. Only extension code makes
// these objects. Page values (qa_eval, qa_cdp, storage) are plain JSON and can never be one, so a
// page cannot make the bridge write a file.
class Out {
  constructor(kind, data) {
    this.kind = kind;
    this.data = data;
  }
}
const fileOut = data => new Out('file', data),
  textOut = text => new Out('text', text),
  imageOut = data => new Out('image', data);
// The reply to the native host: {id, result, files, text, image}. Each file has "at", the place
// in result where the MCP server puts the saved file's path.
function envelope(id, result) {
  const reply = { id };
  const files = [];
  function walk(v, path) {
    if (v instanceof Out) {
      if (v.kind === 'file') {
        files.push({ at: path, ...v.data });
        return null;
      }
      if (path.length === 1 && v.kind === 'text') reply.text = v.data;
      else if (path.length === 1 && v.kind === 'image') reply.image = v.data;
      else return v.data;
      return undefined;
    }
    // Out objects sit at most three levels deep (qa_batch: steps, a step, saved).
    if (path.length >= 4 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, path.concat(i)));
    if (Object.getPrototypeOf(v) !== Object.prototype) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const w = walk(x, path.concat(k));
      if (w !== undefined) o[k] = w;
    }
    return o;
  }
  reply.result = walk(result, []);
  if (files.length) reply.files = files;
  return reply;
}
const errorText = e => String((e && e.message) || e);
function url(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw Error('Valid HTTP(S) URL required');
  return u.href;
}
function session(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid session');
  if (!sessions.has(id)) sessions.set(id, { visible: false, windowId: null, name: '' });
  return sessions.get(id);
}
// How other sessions see a session: its name, or the start of its id.
function ownerName(s) {
  const st = sessions.get(s);
  return st && st.name ? st.name : 'session ' + s.slice(0, 8);
}
async function owned(id, s) {
  if (!Number.isInteger(id) || claims.get(id) !== s)
    throw Error('Tab is not claimed by this session');
  return chrome.tabs.get(id);
}
function limited(value, max = 1048576) {
  const encoded = JSON.stringify(value ?? null);
  if (new TextEncoder().encode(encoded).length > max)
    return { truncated: true, preview: encoded.slice(0, Math.floor(max / 4)), limitBytes: max };
  return value ?? null;
}
// Work on a tab that went on after its call timed out. The tab stays busy until that work ends
// (at most LINGER_MS), so no other call runs on the tab at the same time.
const lingering = new Map(),
  LINGER_MS = 60000;
function holdTab(id, p) {
  lingering.set(id, (lingering.get(id) || 0) + 1);
  Promise.race([Promise.resolve(p).catch(() => {}), sleep(LINGER_MS)]).then(() => {
    const n = lingering.get(id) - 1;
    if (n > 0) lingering.set(id, n);
    else lingering.delete(id);
  });
}
const tabBusy = id => inflight.has(id) || lingering.has(id);
// tabId: the tab p works on. If the time runs out first, the tab stays busy until p ends.
async function bounded(p, ms = 30000, tabId) {
  let timer,
    late = false;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          late = true;
          reject(Error('Browser operation timed out; outcome may be incomplete'));
        }, ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (late && tabId !== undefined) holdTab(tabId, p);
  }
}
// A batch or a qa_perf leak or trace checks its deadline before each step: no step starts after
// the call returned.
const STEPS_MS = 30000;
function stepTime(deadline, what) {
  const left = (deadline ?? Date.now() + STEPS_MS) - Date.now();
  if (left <= 0) throw Error(`Not run: ${what} used its time (${Math.round(STEPS_MS / 1000)} s). Run the rest in a new call`);
  return left;
}
function route(id, frame) {
  if (!frame) return { tabId: id };
  const found = [...(children.get(id) || new Map())].find(([, v]) => v.frameId === frame);
  return found ? { tabId: id, sessionId: found[0] } : { tabId: id };
}
const cdp = (id, method, params = {}, frame) =>
  chrome.debugger.sendCommand(route(id, frame), method, params);
// Chrome answers an input command only after the page handled it. A page that opens alert(),
// confirm() or prompt() in its handler is blocked until the dialog closes. So input commands stop
// waiting when a dialog opens, and the action returns the dialog.
class DialogOpen extends Error {}
function input(id, method, params) {
  const p = cdp(id, method, params);
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!dialogs.has(id)) return;
      clearInterval(timer);
      p.catch(() => {});
      reject(new DialogOpen('A dialog opened'));
    }, 30);
    p.then(
      v => (clearInterval(timer), resolve(v)),
      e => (clearInterval(timer), reject(e))
    );
  });
}
// Clean-up that must not wait while a dialog blocks the page.
const quietly = (id, p) => (dialogs.has(id) ? (p.catch(() => {}), undefined) : p.catch(() => {}));
async function frameTree(id) {
  const trees = [(await cdp(id, 'Page.getFrameTree')).frameTree];
  for (const child of (children.get(id) || new Map()).values()) {
    try {
      const t = await chrome.debugger.sendCommand(
        { tabId: id, sessionId: child.sessionId },
        'Page.getFrameTree'
      );
      child.frameId = t.frameTree.frame.id;
      trees.push(t.frameTree);
    } catch {}
  }
  return trees;
}
function flatten(trees) {
  const result = new Map();
  function walk(t, parent) {
    const f = { ...t.frame };
    if (!f.parentId && parent) f.parentId = parent;
    if (!result.has(f.id) || !result.get(f.id).parentId) result.set(f.id, f);
    for (const c of t.childFrames || []) walk(c, f.id);
  }
  trees.forEach(t => walk(t));
  return [...result.values()];
}
// A frameId argument: a frame id, or a short frame name (f1) from qa_snapshot.
function frameArg(id, raw) {
  if (raw === undefined || !/^f\d+$/.test(raw)) return raw;
  const l = logs.get(id);
  for (const [frame, alias] of l.refFrames) if (alias === raw) return frame;
  throw Error(`Unknown frame ${raw}. Take a new qa_snapshot and use its frame names`);
}
async function context(id, frame, main = false) {
  const list = flatten(await frameTree(id));
  const f = frame ? list.find(f => f.id === frame) : list[0];
  if (!f) throw Error('Frame is not in this claimed tab');
  if (main) return { frame: f.id, contextId: undefined };
  const r = await cdp(
    id,
    'Page.createIsolatedWorld',
    { frameId: f.id, worldName: 'native-qa-operations', grantUniveralAccess: false },
    f.id
  );
  return { frame: f.id, contextId: r.executionContextId };
}
async function evaluate(
  id,
  expr,
  frame,
  { main = false, timeout = 10000, max = 1048576, byValue = true } = {}
) {
  const ctx = await context(id, frame, main);
  // Main-frame arbitrary evaluation runs in the page's main world.
  // For an explicit child frame, resolve its default execution context.
  let contextId = ctx.contextId;
  if (main && frame) {
    const child = route(id, frame);
    if (child.sessionId) contextId = undefined;
    else {
      const entry = (logs.get(id)?.contexts || []).find(
        c => c.auxData?.frameId === frame && c.auxData?.isDefault
      );
      if (!entry) throw Error('Frame main execution context not ready');
      contextId = entry.id;
    }
  }
  const params = {
    expression: expr,
    returnByValue: byValue,
    awaitPromise: true,
    userGesture: true,
    timeout
  };
  if (contextId !== undefined) params.contextId = contextId;
  const r = await bounded(cdp(id, 'Runtime.evaluate', params, ctx.frame), timeout + 500);
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        'Page evaluation failed'
    );
  return byValue ? limited(r.result.value, max) : r.result;
}
function newLog() {
  return {
    contexts: [],
    lifecycle: [],
    lifeSeq: 0,
    refs: new Map(),
    refFrames: new Map(),
    // On a page with very many fields: what the element of each field said (see frameItems).
    fieldInfo: new Map(),
    paused: new Map(),
    mainFrame: null,
    loading: false,
    tree: null,
    // Pages: one per main-frame navigation. Requests and messages carry the page number.
    page: 1,
    pages: [{ n: 1, url: '' }],
    requests: [],
    byKey: new Map(),
    extra: new Map(),
    requestSeq: 0,
    open: new Map(),
    messages: [],
    messageSeq: 0,
    // qa_cdp event reader: domains the agent enabled through qa_cdp, and their events.
    cdpDomains: new Set(),
    cdpEvents: [],
    cdpDropped: 0
  };
}
async function attach(id) {
  await chrome.debugger.attach({ tabId: id }, '1.3');
  const l = newLog();
  logs.set(id, l);
  children.set(id, new Map());
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'])
    await cdp(id, m);
  await cdp(id, 'Page.setLifecycleEventsEnabled', { enabled: true });
  const tree = (await cdp(id, 'Page.getFrameTree')).frameTree;
  l.mainFrame = tree.frame.id;
  l.pages[0].url = tree.frame.url;
  // A new cross-site frame waits until its domains are on (see Target.attachedToTarget), so the
  // requests and console messages of its first moments are not lost.
  await cdp(id, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }, { exclude: true }]
  });
}
function forget(id) {
  claims.delete(id);
  logs.delete(id);
  children.delete(id);
  dialogs.delete(id);
  kept.delete(id);
}
async function adopt(id, s, limits) {
  session(s);
  const existing = claims.get(id);
  if (existing && existing !== s) throw Error('Tab claim conflict: ' + ownerName(existing) + ' has it');
  if (existing === s) return { tabId: id, claimed: true };
  await chrome.tabs.get(id);
  if (claims.has(id)) {
    if (claims.get(id) !== s) throw Error('Tab claim conflict');
    return { tabId: id, claimed: true };
  }
  if ([...claims.values()].filter(x => x === s).length >= limits.tabs)
    throw Error(`Session tab limit reached (${limits.tabs}, maxTabsPerSession in bridge-config.json)`);
  claims.set(id, s);
  try {
    await attach(id);
    return { tabId: id, claimed: true };
  } catch (e) {
    claims.delete(id);
    await chrome.debugger.detach({ tabId: id }).catch(() => {});
    logs.delete(id);
    children.delete(id);
    throw e;
  }
}
async function release(id, s) {
  await owned(id, s);
  if (tabBusy(id)) throw Error('Tab operation still in progress');
  if (recordings.has(id)) throw Error('This tab is being recorded. Stop the recording first (qa_record action stop)');
  forget(id);
  await chrome.debugger.detach({ tabId: id }).catch(() => {});
  return { released: id };
}
// Close this session's claimed tabs. Kept tabs stay open: at cleanup they stay claimed; when the
// session ends (disconnect) they are released, so another session can adopt them.
async function cleanup(s, disconnect) {
  const ids = [...claims].filter(([, owner]) => owner === s).map(([id]) => id),
    failed = [],
    closed = [],
    keptOpen = [];
  for (const id of ids) {
    if (kept.has(id)) {
      keptOpen.push(id);
      if (disconnect) {
        forget(id);
        await chrome.debugger.detach({ tabId: id }).catch(() => {});
      }
      continue;
    }
    try {
      await chrome.tabs.remove(id);
    } catch {
      try {
        await chrome.tabs.get(id);
        failed.push(id);
        continue;
      } catch {}
    }
    forget(id);
    closed.push(id);
  }
  const state = sessions.get(s);
  if (state) state.windowId = null;
  const windows = await chrome.windows.getAll();
  return {
    closed,
    kept: keptOpen,
    remaining: failed.length,
    // No window, no claimed tab and no other session: the caller may stop a QA Chrome it may stop.
    safeToStopProfile: windows.length === 0 && claims.size === 0 && [...sessions.keys()].every(x => x === s),
    preservedWindow: windows.length > 0
  };
}
// Requests from the extension to the native host (only a garbage collection, see memory()).
const hostCalls = new Map();
let hostCallSeq = 0;
function hostCall(msg, ms = 15000) {
  if (!port) return Promise.reject(Error('Not connected to the native host'));
  const callId = 'c' + ++hostCallSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostCalls.delete(callId);
      reject(Error('No answer from the native host'));
    }, ms);
    hostCalls.set(callId, { resolve, reject, timer });
    port.postMessage({ ...msg, callId });
  });
}
function hostAnswer(r) {
  const call = hostCalls.get(r.callId);
  if (!call) return;
  hostCalls.delete(r.callId);
  clearTimeout(call.timer);
  if (r.error) call.reject(Error(r.error));
  else call.resolve(r.result);
}
function connect() {
  instanceRead.then(connectNow, () => chrome.action.setBadgeText({ text: 'ERR' }));
}
function connectNow() {
  if (port) return;
  clearTimeout(retryTimer);
  attempts++;
  port = chrome.runtime.connectNative(HOST + (INSTANCE ? '_' + INSTANCE : ''));
  port.onDisconnect.addListener(() => {
    port = null;
    chrome.action.setBadgeText({ text: 'OFF' });
    for (const s of sessions.keys()) cleanup(s, true);
    sessions.clear();
    // Keep trying, with one timer at a time and never faster than QaRules.reconnectDelay allows.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, QaRules.reconnectDelay(attempts));
  });
  port.onMessage.addListener(async req => {
    attempts = 0;
    if (req.callId !== undefined) return hostAnswer(req);
    let response;
    try {
      response = envelope(req.id, await dispatch(req));
    } catch (e) {
      response = { id: req.id, error: errorText(e).slice(0, 4000) };
    }
    // The native host refuses frames over 16 MB and would exit. Send a clear error instead.
    const bytes = new TextEncoder().encode(JSON.stringify(response)).length;
    if (bytes > MAX_RESULT_BYTES)
      response = {
        id: req.id,
        error: `Result is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_RESULT_BYTES / 1048576} MB. Ask for less output, or save it with file`
      };
    if (port) port.postMessage(response);
  });
  chrome.action.setBadgeText({ text: 'QA' });
}
chrome.action.onClicked.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
// Chrome brings a window to the front by itself, for example when a page opens a tab or a popup.
// While a tool call of a non-visible session runs (and shortly after), and shortly after a page
// opened a tab or a window, give the focus back: focused:false makes Chrome activate the next
// window below it, normally the one the user had. A visible session keeps the focus.
// A person who works in QA Chrome keeps it: a click on a QA window outside these times, and a tab
// or window opened while a QA window has had the focus for a while.
let quietCalls = 0,
  quietUntil = 0,
  // The QA window that has the focus (WINDOW_ID_NONE: another program has it), and since when.
  focus = { id: chrome.windows.WINDOW_ID_NONE, since: 0 };
const visibleSession = () => [...sessions.values()].some(x => x.visible);
chrome.windows.onFocusChanged.addListener(windowId => {
  focus = { id: windowId, since: Date.now() };
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (quietCalls === 0 && Date.now() > quietUntil) return;
  if (visibleSession()) return;
  chrome.windows.update(windowId, { focused: false }).catch(() => {});
});
// A new tab or window, at any time. Chrome may raise its window just before or just after this event.
function opened() {
  const now = Date.now();
  if (focus.id !== chrome.windows.WINDOW_ID_NONE && now - focus.since > 500) return;
  quietUntil = Math.max(quietUntil, now + 1500);
  if (focus.id !== chrome.windows.WINDOW_ID_NONE && !visibleSession())
    chrome.windows.update(focus.id, { focused: false }).catch(() => {});
}
chrome.tabs.onCreated.addListener(opened);
chrome.windows.onCreated.addListener(opened);
chrome.tabs.onRemoved.addListener(forget);
chrome.debugger.onDetach.addListener(src => {
  const rec = recordings.get(src.tabId);
  if (rec) finishRecording(rec, 'debugger detached');
  if (claims.has(src.tabId)) forget(src.tabId);
});
chrome.debugger.onEvent.addListener((src, method, p) => {
  event(src, method, p).catch(() => {});
});

// ---------------------------------------------------------------------------
// CDP events: page loads, frames, dialogs, network requests and console messages.

function newPage(l, loaderId, pageUrl) {
  // A new tab starts on about:blank. Its first real page takes that empty page's number.
  const last = l.pages[l.pages.length - 1];
  if (/^(about:blank)?$/.test(last.url) && !l.requests.some(r => r.page === l.page && r.type !== 'Document') && !l.messages.length) {
    last.url = pageUrl;
    return;
  }
  l.page++;
  l.pages.push({ n: l.page, url: pageUrl });
  if (l.pages.length > PAGES_KEPT) l.pages.shift();
  const first = l.pages[0].n;
  // The request that loaded the new page started before it showed: move it to the new page.
  for (const r of l.requests) if (r.loaderId === loaderId && r.type === 'Document') r.page = l.page;
  l.requests = l.requests.filter(r => r.page >= first);
  l.messages = l.messages.filter(m => m.page >= first);
  for (const [key, r] of l.byKey) if (r.page < first) l.byKey.delete(key);
}
function cut(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function remoteText(a) {
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.preview && a.preview.properties) {
    const inner = a.preview.properties.map(p => (a.subtype === 'array' ? '' : p.name + ': ') + p.value).join(', ');
    return a.subtype === 'array' ? '[' + inner + ']' : '{' + inner + (a.preview.overflow ? ', …' : '') + '}';
  }
  return a.description || a.unserializableValue || a.type;
}
function addMessage(l, m) {
  m.n = ++l.messageSeq;
  m.page = l.page;
  m.text = cut(m.text, 4000);
  l.messages.push(m);
  if (l.messages.length > MAX_MESSAGES) l.messages.shift();
}
function networkEvent(l, src, method, p) {
  const key = (src.sessionId || '') + ':' + p.requestId;
  if (method === 'Network.requestWillBeSent') {
    const prev = l.byKey.get(key);
    if (p.redirectResponse && prev) {
      prev.status = p.redirectResponse.status;
      prev.statusText = p.redirectResponse.statusText;
      prev.responseHeaders = p.redirectResponse.headers;
      prev.ms = (p.timestamp - prev.start) * 1000;
      prev.redirected = true;
    }
    const r = {
      id: 'r' + ++l.requestSeq,
      key,
      cdpId: p.requestId,
      session: src.sessionId,
      page: l.page,
      loaderId: p.loaderId,
      method: p.request.method,
      url: p.request.url,
      type: p.type,
      start: p.timestamp,
      at: Date.now(),
      requestHeaders: p.request.headers,
      postData: p.request.postData !== undefined ? cut(p.request.postData, 65536) : undefined,
      hasPostData: p.request.hasPostData
    };
    const extra = l.extra.get(key);
    if (extra && extra.request) r.requestHeaders = extra.request;
    l.byKey.set(key, r);
    l.requests.push(r);
    if (l.requests.length > MAX_REQUESTS) l.requests.shift();
    l.open.set(key, Date.now());
    return;
  }
  if (method === 'Network.requestWillBeSentExtraInfo' || method === 'Network.responseReceivedExtraInfo') {
    // The full headers, with cookies. They can come before or after the main event.
    const field = method === 'Network.requestWillBeSentExtraInfo' ? 'request' : 'response';
    const r = l.byKey.get(key);
    if (r && field === 'request') r.requestHeaders = p.headers;
    else if (r && r.responseHeaders) r.responseHeaders = p.headers;
    else {
      const e = l.extra.get(key) || {};
      e[field] = p.headers;
      l.extra.set(key, e);
      if (l.extra.size > 300) l.extra.delete(l.extra.keys().next().value);
    }
    return;
  }
  // A cross-site frame's own page load starts in the parent; its later events come from the frame.
  const r = l.byKey.get(key) || (src.sessionId && l.byKey.get(':' + p.requestId));
  if (!r) return;
  if (method === 'Network.responseReceived') {
    r.status = p.response.status;
    r.statusText = p.response.statusText;
    r.mimeType = p.response.mimeType;
    r.type = p.type;
    const extra = l.extra.get(key);
    r.responseHeaders = (extra && extra.response) || p.response.headers;
    l.extra.delete(key);
  } else if (method === 'Network.loadingFinished') {
    r.size = p.encodedDataLength;
    r.ms = (p.timestamp - r.start) * 1000;
    l.open.delete(r.key);
  } else if (method === 'Network.loadingFailed') {
    r.failed = p.canceled ? 'canceled' : p.blockedReason || p.errorText;
    r.ms = (p.timestamp - r.start) * 1000;
    l.open.delete(r.key);
  }
}
async function event(src, method, p) {
  const id = src.tabId;
  if (!claims.has(id)) return;
  const l = logs.get(id);
  if (!l) return;
  const domain = method.slice(0, method.indexOf('.'));
  if (l.cdpDomains.has(domain)) {
    if (l.cdpEvents.length >= 200) {
      l.cdpEvents.shift();
      l.cdpDropped++;
    }
    l.cdpEvents.push({ method, params: limited(p, 4096) });
  }
  if (method === 'Runtime.bindingCalled') {
    const ack = inputAcks.get(p.name);
    if (!ack) return;
    try {
      const value = JSON.parse(p.payload);
      if (value && value.trusted === true && value.targeted === true) {
        ack.events.push(value.type);
        if (value.type === ack.terminal) ack.resolve({ type: value.type, events: [...ack.events] });
      }
    } catch {}
    return;
  }
  if (method === 'Page.screencastFrame' && !src.sessionId) {
    cdp(id, 'Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    const rec = recordings.get(id);
    if (rec) onFrame(rec, p.data);
    return;
  }
  if (method === 'Page.screencastVisibilityChanged' && !src.sessionId) {
    const rec = recordings.get(id);
    if (rec) rec.visible = p.visible;
    return;
  }
  if (method === 'Tracing.tracingComplete') {
    if (l.traceDone) l.traceDone(p);
    return;
  }
  if (domain === 'Network') return networkEvent(l, src, method, p);
  if (method === 'Page.lifecycleEvent') {
    // qa_navigate waits for these.
    if (!src.sessionId && (p.name === 'load' || p.name === 'DOMContentLoaded')) {
      l.lifecycle.push({ seq: ++l.lifeSeq, frameId: p.frameId, loaderId: p.loaderId, name: p.name });
      l.lifecycle = l.lifecycle.slice(-50);
    }
    return;
  }
  if (method === 'Page.navigatedWithinDocument') {
    if (!src.sessionId && p.frameId === l.mainFrame) {
      l.lifecycle.push({ seq: ++l.lifeSeq, frameId: p.frameId, name: 'sameDocument' });
      l.lifecycle = l.lifecycle.slice(-50);
    }
    return;
  }
  if (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') {
    if (!src.sessionId && p.frameId === l.mainFrame) {
      l.loading = method === 'Page.frameStartedLoading';
      if (l.loading) l.loadingSince = Date.now();
    }
    return;
  }
  if (method === 'Page.frameNavigated') {
    if (!src.sessionId && !p.frame.parentId) {
      // A new document: old refs are gone, and the next read is a full read.
      l.mainFrame = p.frame.id;
      l.refs.clear();
      l.refFrames.clear();
      l.fieldInfo.clear();
      l.tree = null;
      newPage(l, p.frame.loaderId, p.frame.url);
      // A page from the back/forward cache shows at once and has no load event.
      if (p.type === 'BackForwardCacheRestore') {
        l.lifecycle.push({ seq: ++l.lifeSeq, frameId: p.frame.id, name: 'restored' });
        l.lifecycle = l.lifecycle.slice(-50);
      }
    }
    return;
  }
  if (method === 'Fetch.requestPaused') {
    // The policy check for Fetch.* in qa_cdp needs the URL and type of each paused request.
    l.paused.set(p.requestId, { url: p.request.url, type: p.resourceType });
    if (l.paused.size > 500) l.paused.delete(l.paused.keys().next().value);
    return;
  }
  if (method === 'Target.attachedToTarget') {
    const target = { tabId: id, sessionId: p.sessionId };
    try {
      if (p.targetInfo.type === 'iframe') {
        children.get(id).set(p.sessionId, { sessionId: p.sessionId, frameId: p.targetInfo.targetId });
        for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'])
          await chrome.debugger.sendCommand(target, m, {});
        if (l.throttle) await throttleTarget(target, l.throttle).catch(() => {});
      }
    } finally {
      // The frame waits for this (waitForDebuggerOnStart).
      if (p.waitingForDebugger) chrome.debugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger').catch(() => {});
    }
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    children.get(id)?.delete(p.sessionId);
    return;
  }
  if (method === 'Runtime.executionContextCreated') {
    l.contexts.push(p.context);
    l.contexts = l.contexts.slice(-100);
    return;
  }
  if (method === 'Runtime.executionContextsCleared') {
    l.contexts = [];
    return;
  }
  if (method === 'Page.javascriptDialogOpening') {
    dialogs.set(id, { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt });
    return;
  }
  if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(id);
    return;
  }
  const origin = QaRules.originOf(l.pages[l.pages.length - 1].url);
  if (method === 'Runtime.consoleAPICalled') {
    const top = p.stackTrace?.callFrames?.[0];
    const level = QaLogs.levelOf(p.type);
    addMessage(l, {
      level,
      text: (p.type === 'assert' ? 'Assertion failed: ' : '') + p.args.map(remoteText).join(' '),
      url: top?.url,
      line: top?.lineNumber,
      col: top?.columnNumber,
      stack: level === 'error' || p.type === 'trace' ? QaLogs.stack(p.stackTrace, origin).slice(1) : undefined
    });
    return;
  }
  if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails;
    const description = d.exception?.description || '';
    addMessage(l, {
      level: 'error',
      text: (d.text || 'Uncaught') + ' ' + (description.split('\n')[0] || ''),
      url: d.url || d.stackTrace?.callFrames?.[0]?.url,
      line: d.lineNumber,
      col: d.columnNumber,
      stack: QaLogs.stack(d.stackTrace, origin)
    });
    return;
  }
  if (method === 'Log.entryAdded') {
    const e = p.entry;
    addMessage(l, {
      level: QaLogs.levelOf(e.level),
      text: e.text,
      url: e.url,
      line: e.lineNumber ?? 0,
      col: 0,
      stack: e.level === 'error' ? QaLogs.stack(e.stackTrace, origin) : undefined
    });
  }
}

// ---------------------------------------------------------------------------
// Elements: refs and selectors.

const helpers = `
  const norm = s => (s || '').replace(/\\s+/gu, ' ').trim();
  const label = e =>
    e.getAttribute('aria-label') ||
    (e.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .map(id => document.getElementById(id)?.textContent || '')
      .join(' ') ||
    e.innerText ||
    e.value ||
    e.getAttribute('title') ||
    '';
  const visible = e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' &&
      !e.closest('[hidden],[inert]');
  };
`;
async function element(id, selector, frame) {
  const r = await evaluate(
    id,
    `(() => {
      const matches = document.querySelectorAll(${JSON.stringify(selector)});
      if (matches.length !== 1)
        throw Error('Expected exactly one matching element, found ' + matches.length);
      return matches[0];
    })()`,
    frame,
    { byValue: false }
  );
  if (!r.objectId) throw Error('Element not found');
  return r.objectId;
}
// Refs: qa_snapshot gives each element a ref built from its CDP backendNodeId.
// The id stays the same while the element is in the page, so refs stay stable across reads.
function frameAlias(l, frame) {
  if (!l.refFrames.has(frame)) l.refFrames.set(frame, 'f' + (l.refFrames.size + 1));
  return l.refFrames.get(frame);
}
function refFor(l, frame, backendNodeId) {
  const ref = (frame ? frameAlias(l, frame) : '') + 'e' + backendNodeId;
  l.refs.delete(ref);
  l.refs.set(ref, { frame, backendNodeId });
  if (l.refs.size > 50000) l.refs.delete(l.refs.keys().next().value);
  return ref;
}
function refEntry(id, ref, frame) {
  const entry = logs.get(id)?.refs.get(ref);
  if (!entry) throw Error(`Unknown ref ${ref}. Take a new qa_snapshot and use its refs`);
  if (frame !== undefined && frame !== entry.frame)
    throw Error(`Ref ${ref} is from another frame. Leave frameId out when you use a ref`);
  return entry;
}
// The frame an action works in: the ref's frame, or frameId.
function targetFrame(id, a) {
  return a.ref !== undefined ? refEntry(id, a.ref, a.frameId).frame : a.frameId;
}
async function refObject(id, ref, frame, contextId) {
  const entry = refEntry(id, ref, frame);
  const stale = `Ref ${ref} is stale: the element is no longer in the page. Take a new qa_snapshot`;
  let objectId;
  try {
    const r = await cdp(
      id,
      'DOM.resolveNode',
      { backendNodeId: entry.backendNodeId, executionContextId: contextId },
      entry.frame
    );
    objectId = r.object.objectId;
  } catch {
    throw Error(stale);
  }
  const c = await cdp(
    id,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: 'function () { return this.isConnected; }',
      returnByValue: true
    },
    entry.frame
  );
  if (c.result?.value !== true) throw Error(stale);
  return objectId;
}
// a.selector (must match exactly one element) or a.ref. Returns the element in a fresh
// isolated world, like element() does for selectors.
async function target(id, a) {
  if (a.selector !== undefined && a.ref !== undefined)
    throw Error('Give selector or ref, not both');
  if (a.ref !== undefined) {
    const frame = targetFrame(id, a);
    const ctx = await context(id, frame);
    return { objectId: await refObject(id, a.ref, a.frameId, ctx.contextId), frame };
  }
  if (a.selector === undefined) throw Error('ref or selector is required');
  return { objectId: await element(id, a.selector, a.frameId), frame: a.frameId };
}
async function callOn(id, t, functionDeclaration, args = []) {
  const r = await cdp(
    id,
    'Runtime.callFunctionOn',
    {
      objectId: t.objectId,
      functionDeclaration,
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: true
    },
    t.frame
  );
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Page call failed'
    );
  return r.result.value;
}
// A cross-site frame has its own CDP session, and its coordinates start at the frame's top left.
// Input goes to the tab, so add where the frame's content box is in the page (for each level).
async function frameOffset(id, frame) {
  const r = route(id, frame);
  if (!r.sessionId) return { x: 0, y: 0 };
  // The session's root frame has the target id as its frame id.
  const root = children.get(id).get(r.sessionId).frameId;
  const info = flatten(await frameTree(id)).find(x => x.id === root);
  if (!info || !info.parentId) return { x: 0, y: 0 };
  const owner = await cdp(id, 'DOM.getFrameOwner', { frameId: root }, info.parentId);
  const box = await cdp(id, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, info.parentId);
  const up = await frameOffset(id, info.parentId);
  return { x: box.model.content[0] + up.x, y: box.model.content[1] + up.y };
}
async function mouseElement(id, a) {
  const { objectId, frame } = await target(id, a);
  await cdp(id, 'DOM.scrollIntoViewIfNeeded', { objectId }, frame);
  const b = await cdp(id, 'DOM.getContentQuads', { objectId }, frame);
  if (!b.quads?.length) throw Error('Element has no clickable layout box');
  const q = b.quads[0];
  const off = await frameOffset(id, frame);
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4 + off.x, y: (q[1] + q[3] + q[5] + q[7]) / 4 + off.y };
}
async function armClickAck(id, a, frame, button) {
  const ctx = await context(id, frame),
    name = '__nativeQaInputAck_' + Math.random().toString(36).slice(2),
    key = '__nativeQaInputCleanup_' + Math.random().toString(36).slice(2);
  const terminal = button === 'right' ? 'contextmenu' : button === 'middle' ? 'auxclick' : 'click';
  let resolve;
  const delivered = new Promise(r => (resolve = r));
  const ack = { terminal, events: [], resolve };
  inputAcks.set(name, ack);
  try {
    await cdp(id, 'Runtime.addBinding', { name, executionContextId: ctx.contextId }, ctx.frame);
    const arm = `target => {
      const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu'];
      const handler = e =>
        globalThis[${JSON.stringify(name)}](JSON.stringify({
          type: e.type,
          trusted: e.isTrusted,
          targeted: e.composedPath().includes(target)
        }));
      for (const type of types) document.addEventListener(type, handler, true);
      globalThis[${JSON.stringify(key)}] = () => {
        for (const type of types) document.removeEventListener(type, handler, true);
      };
      return { readyState: document.readyState, visibilityState: document.visibilityState };
    }`;
    let prepared;
    if (a.ref !== undefined) {
      const objectId = await refObject(id, a.ref, a.frameId, ctx.contextId);
      prepared = await cdp(
        id,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function () { return (${arm})(this); }`,
          returnByValue: true,
          awaitPromise: true
        },
        ctx.frame
      );
    } else {
      const expression = `(${arm})((() => {
        const matches = document.querySelectorAll(${JSON.stringify(a.selector)});
        if (matches.length !== 1)
          throw Error('Expected exactly one matching element, found ' + matches.length);
        return matches[0];
      })())`;
      prepared = await cdp(
        id,
        'Runtime.evaluate',
        { expression, contextId: ctx.contextId, returnByValue: true, awaitPromise: true },
        ctx.frame
      );
    }
    if (prepared.exceptionDetails)
      throw Error(
        prepared.exceptionDetails.exception?.description ||
          prepared.exceptionDetails.text ||
          'Could not arm click delivery confirmation'
      );
    return {
      async wait() {
        return Promise.race([delivered, sleep(1000).then(() => null)]);
      },
      events: ack.events,
      async cleanup() {
        inputAcks.delete(name);
        await cdp(
          id,
          'Runtime.evaluate',
          {
            expression: `globalThis[${JSON.stringify(key)}]?.();delete globalThis[${JSON.stringify(key)}]`,
            contextId: ctx.contextId,
            returnByValue: true
          },
          ctx.frame
        ).catch(() => {});
        await cdp(id, 'Runtime.removeBinding', { name }, ctx.frame).catch(() => {});
      }
    };
  } catch (e) {
    inputAcks.delete(name);
    await cdp(id, 'Runtime.removeBinding', { name }, ctx.frame).catch(() => {});
    throw e;
  }
}
async function readyForInput(id, frame, visible) {
  const tab = await chrome.tabs.get(id);
  await chrome.tabs.update(id, { active: true });
  // Only a visible session (qa_session visible=true) may change the Windows focus.
  if (visible) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    // Page.bringToFront raises the OS window, so only a visible session uses it.
    await cdp(id, 'Page.bringToFront');
  }
  // The page thinks it has focus, so focus-dependent handlers run without OS focus.
  await cdp(id, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  const end = Date.now() + 5000;
  do {
    try {
      const state = await evaluate(
        id,
        "({ready:document.readyState!=='loading',visible:document.visibilityState==='visible',focused:document.hasFocus()})",
        frame
      );
      if (state.ready && state.visible && state.focused) return state;
    } catch {}
    if (Date.now() >= end) return null;
    await sleep(100);
  } while (true);
}
async function click(id, a, visible) {
  try {
    const frame = targetFrame(id, a),
      button = a.button || 'left',
      count = a.clickCount || 1,
      // Input goes to the tab, so the top page must be ready (a frame never has the focus itself).
      ready = await readyForInput(id, undefined, visible);
    if (!ready)
      return {
        clicked: false,
        status: 'failed',
        reason:
          'The claimed target did not become active, visible and ready for trusted input within 5000ms. ' +
          'A minimized window cannot take input; restoring it needs qa_session visible=true'
      };
    const ack = await armClickAck(id, a, frame, button);
    try {
      const point = await mouseElement(id, a);
      await input(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (let n = 1; n <= count; n++) {
        await input(id, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...point,
          button,
          clickCount: n
        });
        await input(id, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...point,
          button,
          clickCount: n
        });
      }
      const delivered = await ack.wait();
      if (delivered) return { clicked: true };
      return {
        clicked: false,
        status: 'indeterminate',
        reason:
          'Chrome took the input, but no trusted click event reached the element. Check the page before you retry',
        events: [...ack.events]
      };
    } finally {
      // An open dialog blocks page scripts, so the clean-up would wait for it.
      if (dialogs.has(id)) ack.cleanup();
      else await ack.cleanup();
    }
  } finally {
    await quietly(id, cdp(id, 'Emulation.setFocusEmulationEnabled', { enabled: false }));
  }
}
async function clickText(id, a, visible) {
  const selector = await evaluate(
    id,
    `(() => {
      ${helpers}
      const es = [
        ...document.querySelectorAll('button,a,input,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option]')
      ].filter(e => visible(e) && norm(label(e)) === norm(${JSON.stringify(a.text)}));
      if (es.length !== 1) throw Error('Expected one visible button, link or menu item with this text, found ' + es.length);
      const token = 'qa-' + Math.random().toString(36).slice(2);
      es[0].setAttribute('data-native-qa-target', token);
      return '[data-native-qa-target="' + token + '"]';
    })()`,
    a.frameId
  );
  return click(id, { ...a, text: undefined, selector }, visible);
}

// ---------------------------------------------------------------------------
// Page reads (qa_snapshot) and the page state after an action.

// The accessibility tree of one frame, with the documents of its child frames inside.
async function frameItems(id, l, f, frames, level, origin) {
  const r = route(id, f.id);
  const send = (method, params) => chrome.debugger.sendCommand(r, method, params);
  const { nodes } = await send('Accessibility.getFullAXTree', { frameId: f.id });
  // Fields: the accessibility tree does not say which text field is a password field, and a field
  // without a name cannot be told apart. So look at the element of each text field, and of each other
  // field without a name: mark password fields (and never show their value), and give a nameless
  // field its id, name or placeholder attribute. A text field with a value is always checked.
  // That is one call per field. On a page with very many fields, every read after an action would make
  // all of them again, so there the answers for empty fields are kept until the page changes.
  const secret = new Set(),
    fields = new Map();
  const asked = nodes.filter(n => {
    const role = n.role?.value;
    if (n.ignored || !n.backendDOMNodeId || !QaTree.FIELD_ROLES.has(role)) return false;
    return role === 'textbox' || role === 'searchbox' || !n.name?.value;
  });
  const keep = asked.length > MANY_FIELDS;
  if (l.fieldInfo.size > 20000) l.fieldInfo.clear();
  await Promise.all(
    asked
      .filter((n, i) => i < 1000 || n.value?.value)
      .map(n => {
        const key = f.id + ' ' + n.backendDOMNodeId;
        const known = keep && !n.value?.value ? l.fieldInfo.get(key) : undefined;
        const info = known
          ? Promise.resolve(known)
          : send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId }).then(d => {
              const at = {};
              const list = d.node.attributes || [];
              for (let i = 0; i < list.length; i += 2) at[list[i].toLowerCase()] = list[i + 1];
              const password = /^password$/i.test(at.type || '');
              const field = { password, id: at.id, name: at.name, placeholder: at.placeholder };
              if (keep) l.fieldInfo.set(key, field);
              return field;
            });
        return info.then(
          field => {
            if (field.password) secret.add(n.backendDOMNodeId);
            fields.set(n.backendDOMNodeId, field);
          },
          () => n.value?.value && secret.add(n.backendDOMNodeId)
        );
      })
  );
  const inside = new Map();
  if (level < 3)
    for (const c of frames.filter(x => x.parentId === f.id)) {
      try {
        const owner = await send('DOM.getFrameOwner', { frameId: c.id });
        const hidden = QaRules.hiddenFrame(l.policy, c.securityOrigin || c.url);
        inside.set(owner.backendNodeId, {
          alias: frameAlias(l, c.id),
          items: hidden ? [{ text: `(not shown: ${hidden})` }] : await frameItems(id, l, c, frames, level + 1, origin)
        });
      } catch {}
    }
  const key = f.id === l.mainFrame ? undefined : f.id;
  return QaTree.build(nodes, { refOf: b => refFor(l, key, b), secret, fields, frames: inside, origin, hideUrl: QaLogs.hideUrl });
}
async function readPage(id, frame) {
  const l = logs.get(id);
  const frames = flatten(await frameTree(id));
  const main = frames.find(f => !f.parentId) || frames[0];
  l.mainFrame = main.id;
  const f = frame ? frames.find(x => x.id === frame) : main;
  if (!f) throw Error('Frame is not in this claimed tab');
  const items = await frameItems(id, l, f, frames, 0, QaRules.originOf(main.url));
  return QaTree.lines(items);
}
// a: {full, interactive, ref, depth, frameId, search, maxChars, file}. Returns the text.
async function pageRead(id, a = {}) {
  const l = logs.get(id);
  // An action can move the tab to another site, so check the policy again before each read.
  const t = await chrome.tabs.get(id);
  QaRules.checkPolicy(l.policy, {
    tool: 'qa_snapshot',
    places: [
      { what: 'tab', url: t.url },
      { what: 'tab (loading)', url: t.pendingUrl }
    ]
  });
  const lines = await readPage(id, a.frameId);
  const head = `Page "${cut(t.title, 200)}" ${QaLogs.hideUrl(t.url)}`;
  const maxChars = a.file !== undefined ? 0 : a.maxChars ?? 30000;
  const views = a.interactive || a.ref !== undefined || a.depth !== undefined || a.search !== undefined;
  const before = l.tree;
  // The baseline for "changes since the last read" is the whole main page.
  if (a.frameId === undefined) l.tree = lines;
  let body;
  if (views) {
    const v = QaTree.view(lines, {
      interactive: a.interactive,
      root: a.ref,
      depth: a.depth,
      search: a.search,
      maxChars
    });
    if (v.missing) throw Error(`Ref ${a.ref} is not in the page. Take a new qa_snapshot`);
    body = v.text;
  } else if (!a.full && before && a.frameId === undefined && a.file === undefined) {
    const d = QaTree.diff(before, lines, maxChars);
    body = d ? d.text : QaTree.view(lines, { maxChars }).text;
  } else body = QaTree.view(lines, { maxChars }).text;
  return head + '\n' + (body || '(The page has no readable content.)');
}
// Wait until the page settles after an action: no page load that started after the action in
// progress and no request that started after the action still open, for 100 ms. At most 2.5 s, or
// 8 s while a page load that the action started runs. A page that never stops loading does not make
// an action wait longer. Polling does not count: a request for a method and URL that the page
// already sent twice in the 3 s before the action.
async function settle(id, since) {
  const l = logs.get(id);
  const start = Date.now();
  const sig = r => r.method + ' ' + r.url;
  const seen = new Map();
  for (const r of l.requests) if (r.at >= since - 3000 && r.at < since - 20) seen.set(sig(r), (seen.get(sig(r)) || 0) + 1);
  const action = (key, t) => {
    if (t < since - 20) return false;
    const r = l.byKey.get(key);
    return !r || (seen.get(sig(r)) || 0) < 2;
  };
  let idle = null;
  await sleep(50);
  while (l === logs.get(id)) {
    const now = Date.now();
    if (dialogs.has(id)) return;
    const loading = l.loading && l.loadingSince >= since - 20;
    const busy = loading || [...l.open].some(([key, t]) => now - t < 2500 && action(key, t));
    if (busy) idle = null;
    else if (idle === null) idle = now;
    else if (now - idle >= 100) return;
    if (now - start > (loading ? 8000 : 2500)) return;
    await sleep(50);
  }
}
// The part of an action result that shows the page: the changes since the last read.
async function afterAction(id, a, since) {
  if (a.snapshot === false || !logs.has(id)) return {};
  await settle(id, since);
  const d = dialogs.get(id);
  if (d) return { dialog: d, note: 'A dialog is open. Answer it with qa_dialog' };
  try {
    return { $text: textOut(await pageRead(id)) };
  } catch (e) {
    return { note: 'Could not read the page after the action: ' + errorText(e) };
  }
}

// ---------------------------------------------------------------------------

// A tab that is not the active tab of its window may not paint, and then a capture waits. If it
// waits 5 s, show the tab in its window for the capture, then show the tab that was there before.
// This does not change the Windows foreground window: the QA window stays in the background.
async function captureTab(id, params) {
  const tab = await chrome.tabs.get(id);
  if (tab.active) return cdp(id, 'Page.captureScreenshot', params);
  try {
    return await bounded(cdp(id, 'Page.captureScreenshot', params), 5000);
  } catch (e) {
    if (!/timed out/.test(errorText(e))) throw e;
  }
  const [shown] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  await chrome.tabs.update(id, { active: true });
  try {
    return await bounded(cdp(id, 'Page.captureScreenshot', params), 10000);
  } catch (e) {
    if (!/timed out/.test(errorText(e))) throw e;
    throw Error('The tab does not paint, so it cannot be captured. Is its window minimized? Restoring it needs qa_session visible=true');
  } finally {
    if (shown) await chrome.tabs.update(shown.id, { active: true }).catch(() => {});
  }
}
async function screenshot(id, a) {
  const format = a.format || 'jpeg',
    oneElement = a.selector !== undefined || a.ref !== undefined;
  if (a.quality !== undefined && format !== 'jpeg')
    throw Error('quality works only with format=jpeg');
  if (oneElement && a.fullPage) throw Error('Use fullPage or an element (selector or ref), not both');
  if (a.frameId !== undefined && !oneElement) throw Error('frameId needs selector or ref');
  const params = { format, captureBeyondViewport: true };
  if (format === 'jpeg') params.quality = a.quality ?? 80;
  const m = await cdp(id, 'Page.getLayoutMetrics');
  const view = m.cssVisualViewport || m.visualViewport;
  let clip;
  if (a.fullPage) {
    const size = m.cssContentSize || m.contentSize;
    clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height) };
  } else if (oneElement) {
    const t = await target(id, a);
    if (route(id, t.frame).sessionId)
      throw Error(
        'Element capture inside a cross-site frame is not supported. Capture the page instead'
      );
    await cdp(id, 'DOM.scrollIntoViewIfNeeded', { objectId: t.objectId }, t.frame);
    const b = await cdp(id, 'DOM.getContentQuads', { objectId: t.objectId }, t.frame);
    if (!b.quads?.length) throw Error('Element has no layout box');
    const q = b.quads[0],
      xs = [q[0], q[2], q[4], q[6]],
      ys = [q[1], q[3], q[5], q[7]];
    const after = await cdp(id, 'Page.getLayoutMetrics');
    const v = after.cssVisualViewport || after.visualViewport;
    const x = Math.min(...xs),
      y = Math.min(...ys),
      width = Math.max(...xs) - x,
      height = Math.max(...ys) - y;
    if (width < 1 || height < 1) throw Error('Element has no visible size');
    clip = { x: x + v.pageX, y: y + v.pageY, width, height };
  } else {
    clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
  }
  const ratio = (await evaluate(id, 'devicePixelRatio').catch(() => 1)) || 1;
  // A whole tall page fitted into the image limit is a thin strip that nobody can read. Without maxSize
  // and file, show the top of the page at half size or more.
  let pageHeight;
  if (a.fullPage && a.maxSize === undefined && a.file === undefined) {
    const tallest = Math.floor(INLINE_IMAGE_MAX / (MIN_PAGE_SCALE * ratio));
    if (clip.height > tallest && clip.width <= tallest) {
      pageHeight = Math.round(clip.height * ratio);
      clip = { ...clip, height: tallest };
    }
  }
  const cap = a.maxSize ?? (a.file === undefined ? INLINE_IMAGE_MAX : undefined);
  const scale = cap ? Math.min(1, cap / (Math.max(clip.width, clip.height) * ratio)) : 1;
  params.clip = { ...clip, scale };
  let r;
  try {
    r = await captureTab(id, params);
  } catch (e) {
    throw Error(
      `Screenshot failed: ${errorText(e)}.` +
        (a.fullPage ? ' The page may be too large; use maxSize, capture an element, or capture the viewport' : '')
    );
  }
  const width = Math.round(clip.width * scale * ratio),
    height = Math.round(clip.height * scale * ratio);
  const size = { width, height };
  if (scale < 1) {
    size.scaledFrom = Math.round(clip.width * ratio) + 'x' + Math.round(clip.height * ratio);
    if (a.maxSize === undefined)
      size.note = `Scaled down to ${INLINE_IMAGE_MAX} px, the limit for an image in the result. maxSize (up to 10000) or file gives more pixels`;
  }
  if (pageHeight) {
    size.pageHeight = pageHeight;
    size.note =
      `The top ${Math.round(clip.height * ratio)} of ${pageHeight} px of the page: the whole page would be too thin to read. ` +
      'file saves the whole page; maxSize gives the whole page in the result, scaled to fit';
  }
  if (r.data.length > MAX_IMAGE_CHARS)
    throw Error(
      `Screenshot is ${((r.data.length * 3) / 4 / 1048576).toFixed(1)} MB (${width}x${height} px); the limit is about 10 MB. ` +
        'Use maxSize, a lower quality, one element, or no fullPage'
    );
  if (a.file !== undefined)
    return { saved: fileOut({ name: a.file, base64: r.data, ext: format === 'jpeg' ? 'jpg' : 'png' }), ...size };
  return { $image: imageOut({ data: r.data, mimeType: 'image/' + format }), ...size };
}
// Wait for the main frame's load (or DOMContentLoaded) event after mark, or a same-document move.
async function waitLoad(id, l, mark, loaderId, waitUntil, timeout) {
  const name = waitUntil === 'load' ? 'load' : 'DOMContentLoaded',
    end = Date.now() + timeout;
  while (Date.now() < end) {
    if (
      l.lifecycle.some(
        e =>
          e.seq > mark &&
          (e.name === 'sameDocument' ||
            e.name === 'restored' ||
            (e.name === name && e.frameId === l.mainFrame && (!loaderId || e.loaderId === loaderId)))
      )
    )
      return true;
    await sleep(100);
  }
  return false;
}
async function navigate(id, a) {
  const waitUntil = a.waitUntil || 'load',
    timeout = a.timeoutMs ?? 30000,
    l = logs.get(id),
    mark = l.lifeSeq;
  let loaderId;
  if (a.url !== undefined && a.action !== undefined) throw Error('Give url or action, not both');
  if (a.url !== undefined) {
    const r = await cdp(id, 'Page.navigate', { url: url(a.url) });
    if (r.errorText) throw Error('Navigation failed: ' + r.errorText);
    // No loaderId means a same-document navigation (for example #hash): nothing to load.
    if (!r.loaderId) return { loaded: true };
    loaderId = r.loaderId;
  } else if (a.action === 'reload') {
    await cdp(id, 'Page.reload');
  } else if (a.action === 'back' || a.action === 'forward') {
    const h = await cdp(id, 'Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + (a.action === 'back' ? -1 : 1)];
    if (!entry) throw Error(`There is no page to go ${a.action} to`);
    await cdp(id, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  } else throw Error('Give url, or action back, forward or reload');
  if (waitUntil === 'none') return {};
  const loaded = await waitLoad(id, l, mark, loaderId, waitUntil, timeout);
  return loaded ? { loaded } : { loaded, reason: `Not loaded after ${timeout} ms. Use qa_wait to wait longer` };
}
async function frameUrl(id, frame) {
  const f = flatten(await frameTree(id)).find(f => f.id === frame);
  if (!f) throw Error('Frame is not in this claimed tab');
  // about:blank and srcdoc frames run in their parent's origin.
  return f.securityOrigin || f.url;
}
// The optional policy.json check. The native host sends the policy with every request, so an
// agent cannot skip it. qa_batch checks each step with this too.
async function checkPolicy(policy, method, id, a, tab) {
  if (!policy) return;
  const sensitive = QaRules.sensitiveCall(method, a);
  const places = [];
  if (method === 'qa_navigate') {
    // Leaving a page is always allowed; the target must be allowed.
    if (a.url !== undefined) places.push({ what: 'navigation target', url: a.url });
    else if (a.action === 'reload') places.push({ what: 'navigation target', url: tab.url });
    else if (a.action === 'back' || a.action === 'forward') {
      const h = await cdp(id, 'Page.getNavigationHistory');
      const entry = h.entries[h.currentIndex + (a.action === 'back' ? -1 : 1)];
      if (entry) places.push({ what: 'navigation target', url: entry.url });
    }
  } else {
    places.push({ what: 'tab', url: tab.url }, { what: 'tab (loading)', url: tab.pendingUrl });
    // The frames the tool acts in: frameId, the frame of a ref, or the frames of qa_fill fields.
    const frames = new Set([targetFrame(id, a)]);
    for (const f of a.fields || []) frames.add(targetFrame(id, { ...f, frameId: a.frameId }));
    frames.delete(undefined);
    for (const frame of frames) places.push({ what: 'frame', url: await frameUrl(id, frame) });
    if (method === 'qa_cdp') {
      // Raw CDP params (contextId, objectId, nodeId, frameId...) can reach any frame in the tab,
      // so every frame must be on an allowed site.
      for (const f of flatten(await frameTree(id)))
        places.push({ what: 'frame ' + f.id, url: f.securityOrigin || f.url });
    }
    if (method === 'qa_downloads') places.push({ what: 'download URL', url: a.url });
    if (method === 'qa_network' && a.request !== undefined) {
      const r = logs.get(id).requests.find(x => x.id === a.request);
      if (r) places.push({ what: 'request', url: r.url });
    }
  }
  QaRules.checkPolicy(policy, { tool: method, sensitive, places });
  if (method === 'qa_cdp' && a.method !== undefined) await checkCdpTarget(policy, id, a);
  if (
    method === 'qa_cdp' &&
    /^Fetch\.(fulfillRequest|continueRequest|continueResponse)$/.test(a.method)
  ) {
    // Changing a paused page load would let an allowed tab run code in a site that is not allowed.
    const paused = logs.get(id)?.paused.get(a.params?.requestId);
    if (!paused) throw Error('policy.json is active: unknown Fetch requestId');
    if (paused.type === 'Document' || paused.type === 'Other')
      QaRules.checkPolicy(policy, { tool: method, sensitive: true, places: [{ what: 'paused page load', url: paused.url }] });
  }
}
// qa_cdp commands that read a request or a resource, or navigate: the same checks as qa_network
// request and qa_navigate (see QaRules.cdpPolicyCheck). A request the bridge does not know is refused.
async function checkCdpTarget(policy, id, a) {
  const kind = QaRules.cdpPolicyCheck(a.method);
  if (!kind) return;
  const p = a.params || {};
  const l = logs.get(id);
  const check = (what, url, sensitive = true) =>
    QaRules.checkPolicy(policy, { tool: 'qa_cdp', sensitive, places: [{ what, url }] });
  const unknown = what => {
    throw Error(`policy.json is active, so qa_cdp ${a.method} needs ${what}, so the bridge can check its site`);
  };
  if (kind === 'request') {
    const key = (route(id, a.frameId).sessionId || '') + ':' + p.requestId;
    const r = l.byKey.get(key) || l.byKey.get(':' + p.requestId);
    if (!r) unknown(`a requestId of this tab's last ${PAGES_KEPT} pages`);
    check('request', r.url);
  } else if (kind === 'paused') {
    const paused = l.paused.get(p.requestId);
    if (!paused) unknown('the requestId of a paused request of this tab');
    check('paused request', paused.url);
  } else if (kind === 'resource') check('resource', p.url);
  else if (kind === 'navigation') check('navigation target', p.url, false);
  else if (kind === 'history') {
    const entry = (await cdp(id, 'Page.getNavigationHistory')).entries.find(e => e.id === p.entryId);
    if (!entry) unknown('an entryId of this tab');
    check('navigation target', entry.url, false);
  }
}
// One form field: text, password and hidden inputs, textarea, contenteditable, select, checkbox, radio.
const FILL = `function (value, values) {
  const e = this;
  const type = (e.getAttribute('type') || '').toLowerCase();
  const fire = () => {
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (e.tagName === 'SELECT') {
    const wanted = values || [value];
    const found = [...e.options].filter(o => wanted.includes(o.value) || wanted.includes(o.label.trim()));
    if (found.length < wanted.length) throw Error('No option with value or label ' + JSON.stringify(wanted.filter(w => !found.some(o => o.value === w || o.label.trim() === w))));
    if (found.length > 1 && !e.multiple) throw Error('This select takes one value');
    for (const o of e.options) o.selected = found.includes(o);
    fire();
    return;
  }
  if (values) throw Error('values works only for a select');
  if (type === 'checkbox' || type === 'radio') {
    if (value !== 'true' && value !== 'false') throw Error('A ' + type + ' takes "true" or "false"');
    const want = value === 'true';
    if (type === 'radio' && !want && e.checked) throw Error('A radio button cannot be unchecked; choose another one');
    if (e.checked !== want) e.click();
    return;
  }
  if (type === 'file') throw Error('Use qa_upload for a file input');
  if (e.isContentEditable) {
    e.focus();
    e.textContent = value;
  } else {
    if (!('value' in e)) throw Error('This element is not a form field');
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter && e instanceof (e.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement)) setter.call(e, value);
    else e.value = value;
  }
  fire();
}`;
// Window placement. The settings come from bridge-config.json through the native host
// (see README "Window modes"). A new window never takes focus unless the session is visible.
async function openWindow(state, display) {
  const base = { url: 'about:blank', focused: state.visible, type: 'normal' };
  if (display.mode === 'headless') return chrome.windows.create({ ...base, width: 1280, height: 1000 });
  const screen = QaRules.chooseScreen(await chrome.system.display.getInfo(), display.screen);
  return chrome.windows.create({ ...base, ...QaRules.fillBounds(screen, display.state) });
}
// Headless Chrome has one screen, set by --screen-info in Lifecycle.cs. Do not ask
// chrome.system.display there: in a live test with Chrome 157 headless, that call ended the extension.
const HEADLESS_SCREEN = {
  name: 'headless',
  isPrimary: true,
  bounds: { left: 0, top: 0, width: 1920, height: 1080 },
  workArea: { left: 0, top: 0, width: 1920, height: 1080 }
};
// The screen that holds the middle of a window.
async function screenOf(w, display) {
  if (display.mode === 'headless') return HEADLESS_SCREEN;
  const screens = await chrome.system.display.getInfo();
  const x = w.left + w.width / 2,
    y = w.top + w.height / 2;
  const inside = d =>
    x >= d.bounds.left &&
    x < d.bounds.left + d.bounds.width &&
    y >= d.bounds.top &&
    y < d.bounds.top + d.bounds.height;
  return screens.find(inside) || screens.find(d => d.isPrimary) || screens[0];
}
function claimDownload(id, s) {
  if (downloadClaims.size >= 512 && !downloadClaims.has(id))
    throw Error('Download tracking limit reached; reconnect after existing sessions finish');
  downloadClaims.set(id, s);
}
function downloadView(d) {
  return {
    id: d.id,
    state: d.state,
    filename: d.filename,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    error: d.error || null,
    danger: d.danger,
    exists: d.exists
  };
}
async function dispatch(req) {
  const {
    method,
    args: a = {},
    session: s,
    policy = null,
    display = { mode: 'display' },
    limits = { tabs: 32 }
  } = req;
  if (method === '__hello') {
    if (policy) QaRules.readPolicy(policy);
    return { version: VERSION, extensionId: chrome.runtime.id, instance: INSTANCE };
  }
  const state = session(s);
  const quiet =
    display.mode !== 'headless' &&
    !state.visible &&
    method !== 'qa_session';
  if (quiet) quietCalls++;
  try {
    return await handle(method, a, s, state, { policy, display, limits });
  } finally {
    if (quiet) {
      quietCalls--;
      quietUntil = Date.now() + 1500;
    }
  }
}
function ownTabs(s) {
  return [...claims].filter(([, owner]) => owner === s).map(([id]) => id);
}
async function sessionInfo(s, state, env) {
  let window = null;
  const own = ownTabs(s);
  if (own.length) {
    try {
      const t = await chrome.tabs.get(own[0]),
        w = await chrome.windows.get(t.windowId);
      window = { id: w.id, state: w.state, focused: w.focused };
    } catch {}
  }
  const tabs = [];
  for (const id of own) {
    try {
      const t = await chrome.tabs.get(id);
      tabs.push({ id, url: QaLogs.hideUrl(t.url), title: cut(t.title, 100), ...(kept.has(id) ? { keepOpen: true } : {}) });
    } catch {}
  }
  return {
    version: VERSION,
    ...(INSTANCE ? { instance: INSTANCE } : {}),
    sessionId: s,
    name: state.name || null,
    sessions: [...sessions.keys()].map(x => (x === s ? 'you' : ownerName(x))),
    tabs,
    window,
    visible: state.visible,
    display: env.display,
    limits: env.limits,
    policy: QaRules.describePolicy(env.policy),
    screens:
      env.display.mode === 'headless'
        ? []
        : (await chrome.system.display.getInfo()).map((d, i) => ({
            number: i + 1,
            name: d.name,
            primary: d.isPrimary,
            workArea: d.workArea
          }))
  };
}
function findSession(raw) {
  if (sessions.has(raw)) return raw;
  for (const [id, st] of sessions) if (st.name === raw) return id;
  throw Error(`No active session is named or has the id ${raw}`);
}
async function tabs(a, s, state, env) {
  const action = a.action || 'list';
  if (action === 'list') {
    const windows = await chrome.windows.getAll({ populate: true });
    return {
      you: state.name || ownerName(s),
      windows: windows.slice(0, 50).map(w => ({
        id: w.id,
        state: w.state,
        tabs: w.tabs.slice(0, 200).map(t => {
          const owner = claims.get(t.id);
          const row = {
            id: t.id,
            owner: owner === s ? 'you' : owner ? ownerName(owner) : 'unclaimed',
            title: cut(t.title, 100),
            url: QaLogs.hideUrl(t.url)
          };
          if (kept.has(t.id)) row.keepOpen = true;
          if (t.active) row.active = true;
          if (t.openerTabId !== undefined) row.openedBy = t.openerTabId;
          return row;
        })
      }))
    };
  }
  if (action === 'cleanup') return cleanup(s, false);
  if (action === 'new') {
    if (a.url === undefined) throw Error('new needs url');
    const target = url(a.url);
    QaRules.checkPolicy(env.policy, { tool: 'qa_tabs', places: [{ what: 'new tab URL', url: target }] });
    let tab;
    if (state.windowId && !a.newWindow) {
      try {
        await chrome.windows.get(state.windowId);
      } catch {
        state.windowId = null;
      }
    }
    if (!state.windowId || a.newWindow) {
      const w = await openWindow(state, env.display);
      state.windowId = w.id;
      tab = w.tabs[0];
    } else tab = await chrome.tabs.create({ windowId: state.windowId, url: 'about:blank', active: true });
    try {
      await adopt(tab.id, s, env.limits);
      logs.get(tab.id).policy = env.policy;
    } catch (e) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw e;
    }
    if (a.keepOpen) kept.add(tab.id);
    const since = Date.now();
    inflight.add(tab.id);
    try {
      const r = await navigate(tab.id, { url: target, timeoutMs: 30000 });
      return { tabId: tab.id, ...r, ...(await afterAction(tab.id, a, since)) };
    } finally {
      inflight.delete(tab.id);
    }
  }
  if (a.tabId === undefined) throw Error(action + ' needs tabId');
  const id = a.tabId;
  if (action === 'adopt') {
    const r = await adopt(id, s, env.limits);
    if (a.keepOpen) kept.add(id);
    return r;
  }
  if (action === 'release') return release(id, s);
  await owned(id, s);
  if (action === 'close') {
    await chrome.tabs.remove(id);
    return { closed: id };
  }
  if (action === 'keep') {
    if (a.keepOpen === false) kept.delete(id);
    else kept.add(id);
    return { tabId: id, keepOpen: kept.has(id) };
  }
  if (action === 'transfer') {
    if (a.toSession === undefined) throw Error('transfer needs toSession');
    if (tabBusy(id)) throw Error('Tab operation still in progress');
    if (recordings.has(id)) throw Error('This tab is being recorded. Stop the recording first (qa_record action stop)');
    const to = findSession(a.toSession);
    if (ownTabs(to).length >= env.limits.tabs) throw Error('Target session tab limit reached');
    claims.set(id, to);
    kept.delete(id);
    logs.get(id).tree = null;
    return { transferred: id, to: ownerName(to) };
  }
  throw Error('Unknown action ' + action);
}
async function downloadsTool(a, s, env) {
  const action = a.action || 'list';
  if (action === 'list') {
    const recent = await chrome.downloads.search({ limit: 100, orderBy: ['-startTime'] });
    return {
      downloads: recent.map(d => {
        const owner = downloadClaims.get(d.id);
        return { ...downloadView(d), owner: owner === s ? 'you' : owner ? ownerName(owner) : 'unclaimed' };
      })
    };
  }
  if (action === 'adopt') {
    const owner = downloadClaims.get(a.downloadId);
    if (owner && owner !== s) throw Error('Download claim conflict');
    const rows = await chrome.downloads.search({ id: a.downloadId });
    if (!rows.length) throw Error('Download not found in QA profile');
    claimDownload(a.downloadId, s);
    return downloadView(rows[0]);
  }
  if (action === 'wait') {
    if (downloadClaims.get(a.downloadId) !== s) throw Error('Download is not owned by this session');
    const end = Date.now() + (a.timeoutMs ?? 30000);
    do {
      const list = await chrome.downloads.search({ id: a.downloadId });
      if (!list[0]) throw Error('Download no longer exists');
      const d = downloadView(list[0]);
      if (d.state !== 'in_progress') return d;
      if (Date.now() >= end) throw Error('Download wait timed out');
      await sleep(200);
    } while (true);
  }
  if (action === 'start') {
    if (a.tabId === undefined || a.url === undefined || a.filename === undefined)
      throw Error('start needs tabId, url and filename');
    const tab = await owned(a.tabId, s);
    await checkPolicy(env.policy, 'qa_downloads', a.tabId, a, tab);
    if (downloadClaims.size >= 512) throw Error('Download tracking limit reached');
    url(a.url);
    if (!a.filename || a.filename.includes('..') || /[\\/:]/.test(a.filename))
      throw Error('A filename, not a path, is required');
    const downloadId = await chrome.downloads.download({
      url: a.url,
      filename: 'ChromeBridge' + (INSTANCE ? '-' + INSTANCE : '') + '/' + s + '/' + a.filename,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    claimDownload(downloadId, s);
    return { downloadId };
  }
  throw Error('Unknown action ' + action);
}
async function handle(method, a, s, state, env) {
  if (method === 'qa_session') {
    if (a.name !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(a.name) || /^(you|unclaimed|session .*)$/i.test(a.name))
        throw Error('name: 1 to 40 letters, digits, spaces, dots, dashes or underscores, not "you" or "unclaimed"');
      for (const [id, st] of sessions)
        if (id !== s && st.name === a.name) throw Error(`Another session is already named ${a.name}`);
      state.name = a.name;
    }
    if (a.visible !== undefined) {
      if (a.visible && env.display.mode === 'headless')
        throw Error(
          'QA Chrome runs headless, so there is no window to show. ' +
            'Set windowMode to "display" in bridge-config.json and restart QA Chrome'
        );
      state.visible = a.visible;
      if (state.windowId && a.visible) await chrome.windows.update(state.windowId, { focused: true });
    }
    return sessionInfo(s, state, env);
  }
  if (method === 'qa_tabs') return tabs(a, s, state, env);
  if (method === 'qa_downloads') return downloadsTool(a, s, env);
  // stop and status work also after the recorded tab closed.
  if (method === 'qa_record' && a.action !== 'start') return recordTool(a, s);
  if (method === '__recording') {
    // Recordings end with the session. Before __release, the native host asks for them one by one and
    // saves each file, so one reply never holds more than one video.
    const rec = [...recordings.values()].find(r => r.session === s);
    if (!rec) return { none: true };
    await finishRecording(rec, 'session ended');
    return savedRecording(rec).catch(e => ({ tabId: rec.tabId, error: errorText(e) }));
  }
  if (method === '__release') {
    for (const rec of [...recordings.values()].filter(r => r.session === s)) {
      finishRecording(rec, 'session ended');
      recordings.delete(rec.tabId);
    }
    const result = await cleanup(s, true);
    sessions.delete(s);
    for (const [id, owner] of downloadClaims) if (owner === s) downloadClaims.delete(id);
    return result;
  }
  const id = a.tabId;
  let tab = await owned(id, s);
  a = { ...a, frameId: frameArg(id, a.frameId) };
  // Page reads after an action need the policy to leave out frames of blocked (or, in strict mode, unlisted) sites.
  logs.get(id).policy = env.policy;
  // Allow dialog responses while another command awaits the dialog. Other tab operations are serialized.
  const concurrent = method === 'qa_dialog';
  if (tabBusy(id) && !concurrent)
    throw Error(
      'This tab already has an operation in progress' +
        (lingering.has(id) ? ' (an earlier call timed out, and its last step still runs)' : '')
    );
  if (!concurrent) inflight.add(id);
  try {
    // The steps of a batch, leak or trace end before the call's own time limit, so the call can
    // still report which steps ran.
    const deadline = Date.now() + STEPS_MS;
    if (method === 'qa_batch') return await bounded(batch(id, a, s, state, { ...env, deadline }), 40000, id);
    await checkPolicy(env.policy, method, id, a, tab);
    return await bounded(
      operation(method, id, a, tab, state, s, { ...env, deadline }),
      Math.min(40000, (a.timeoutMs ?? 30000) + 5000),
      id
    );
  } finally {
    if (!concurrent) inflight.delete(id);
  }
}
// qa_batch: the steps run in order on one tab. Each step gets the same checks as a single call.
// The page is read once, at the end.
const BATCH_TOOLS = new Set([
  'qa_navigate',
  'qa_snapshot',
  'qa_click',
  'qa_fill',
  'qa_type',
  'qa_wait',
  'qa_screenshot',
  'qa_dialog',
  'qa_hover',
  'qa_scroll',
  'qa_drag',
  'qa_console',
  'qa_network',
  'qa_eval',
  'qa_upload',
  'qa_emulate',
  'qa_storage',
  'qa_cdp',
  'qa_window'
]);
async function batch(id, a, s, state, env) {
  const since = Date.now();
  const steps = [];
  let failed = false;
  for (const [i, step] of a.steps.entries()) {
    try {
      if (!BATCH_TOOLS.has(step.tool)) throw Error(`${step.tool} cannot be a qa_batch step`);
      const args = { ...step.args, tabId: id, snapshot: false };
      args.frameId = frameArg(id, args.frameId);
      if (step.tool === 'qa_screenshot' && args.file === undefined)
        throw Error('In qa_batch, qa_screenshot needs file');
      const left = stepTime(env.deadline, 'the batch');
      const tab = await owned(id, s);
      let r = await bounded(
        checkPolicy(env.policy, step.tool, id, args, tab).then(() => operation(step.tool, id, args, tab, state, s, env)),
        left,
        id
      );
      if (r && r.$text instanceof Out) {
        const { $text, ...rest } = r;
        r = { ...rest, text: $text.data };
      }
      steps.push({ step: i + 1, tool: step.tool, ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : { result: r }) });
      if (r && r.clicked === false) throw Error('The click was not delivered: ' + r.reason);
      // An open dialog blocks the page: the next steps could not run.
      if (r && r.dialog) break;
    } catch (e) {
      if (!steps[i]) steps.push({ step: i + 1, tool: step.tool, ok: false, error: errorText(e) });
      else steps[i] = { ...steps[i], ok: false, error: errorText(e) };
      failed = true;
      break;
    }
  }
  const out = { steps, done: failed ? steps.length - 1 : steps.length, of: a.steps.length };
  return { ...out, ...(await afterAction(id, a, since)) };
}
function saveOrText(a, text) {
  return a.file !== undefined ? { saved: fileOut({ name: a.file, text }) } : { $text: textOut(text) };
}
async function networkTool(id, a, tab) {
  const l = logs.get(id);
  const origin = QaRules.originOf(tab.url);
  if (a.request === undefined) {
    const text = QaLogs.requests(l.requests, {
      filter: a.filter,
      type: a.type,
      failed: a.failed,
      offset: a.offset,
      limit: a.file !== undefined ? MAX_REQUESTS : a.limit,
      origin,
      pages: l.pages,
      show: a.showSecrets === true
    });
    return saveOrText(a, text);
  }
  const r = l.requests.find(x => x.id === a.request);
  if (!r) throw Error(`Unknown request ${a.request}. List the requests with qa_network`);
  const show = a.showSecrets === true;
  const send = (method, params) =>
    chrome.debugger.sendCommand(r.session ? { tabId: id, sessionId: r.session } : { tabId: id }, method, params);
  const lines = [
    r.id + ' ' + r.method + ' ' + (show ? r.url : QaLogs.hideUrl(r.url)),
    'status ' + (r.failed ? 'FAILED ' + r.failed : r.status === undefined ? 'pending' : r.status + ' ' + (r.statusText || '')) +
      ', type ' + (r.type || 'other') + ', ' + QaLogs.size(r.size) + (r.ms !== undefined ? ', ' + Math.round(r.ms) + ' ms' : '') +
      (r.redirected ? ', redirected' : '')
  ];
  const headerBlock = (title, h) => {
    lines.push(title + ':');
    for (const [k, v] of Object.entries(QaLogs.headers(h, show))) lines.push('  ' + k + ': ' + cut(v, 2000));
  };
  headerBlock('Request headers', r.requestHeaders);
  let post = r.postData;
  if (post === undefined && r.hasPostData)
    post = await send('Network.getRequestPostData', { requestId: r.cdpId }).then(x => x.postData, () => undefined);
  if (post !== undefined) {
    const contentType = Object.entries(r.requestHeaders || {}).find(([k]) => /^content-type$/i.test(k))?.[1];
    const b = QaLogs.body(post, contentType, show);
    lines.push('Request body' + (b.hidden ? ' (' + b.hidden + ' secret fields hidden)' : '') + ':', cut(b.text, 20000));
  }
  if (r.responseHeaders) headerBlock('Response headers', r.responseHeaders);
  let saved;
  if (r.status !== undefined && !r.failed && !r.redirected) {
    let body;
    try {
      body = await send('Network.getResponseBody', { requestId: r.cdpId });
    } catch (e) {
      lines.push('Response body: not available (' + errorText(e) + '). Chrome keeps bodies only for a while, and not after some navigations');
    }
    if (body) {
      if (body.base64Encoded) {
        const bytes = Math.floor((body.body.length * 3) / 4);
        if (a.file !== undefined) saved = fileOut({ name: a.file, base64: body.body });
        else lines.push('Response body: binary, about ' + QaLogs.size(bytes) + '. Give file to save it');
      } else {
        const b = QaLogs.body(body.body, r.mimeType, show);
        const note = b.hidden ? ' (' + b.hidden + ' secret fields hidden)' : '';
        if (a.file !== undefined) {
          saved = fileOut({ name: a.file, text: b.text });
          lines.push('Response body' + note + ': saved to the file');
        } else {
          lines.push('Response body (' + (r.mimeType || 'unknown type') + ', ' + b.text.length + ' characters)' + note + ':');
          lines.push(cut(b.text, 20000));
          if (b.text.length > 20000) lines.push('[Cut at 20000 characters. Give file to save all of it.]');
        }
      }
    }
  }
  if (!show) lines.push('[Secret headers and fields are hidden. showSecrets=true shows them.]');
  return { ...(saved ? { saved } : {}), $text: textOut(lines.join('\n')) };
}
async function emulate(id, a) {
  const l = logs.get(id);
  if (a.reset) {
    await cdp(id, 'Emulation.clearDeviceMetricsOverride');
    if (l.userAgent !== undefined) await cdp(id, 'Emulation.setUserAgentOverride', { userAgent: l.userAgent });
    await cdp(id, 'Emulation.clearGeolocationOverride');
    await cdp(id, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  if (a.viewport) {
    const v = a.viewport;
    if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.height < 1 || v.width > 8192 || v.height > 8192)
      throw Error('viewport needs width and height from 1 to 8192');
    await cdp(id, 'Emulation.setDeviceMetricsOverride', {
      width: v.width,
      height: v.height,
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      mobile: v.mobile === true
    });
  }
  if (a.userAgent !== undefined) {
    if (l.userAgent === undefined) l.userAgent = await evaluate(id, 'navigator.userAgent');
    await cdp(id, 'Emulation.setUserAgentOverride', { userAgent: a.userAgent });
  }
  if (a.geolocation) await cdp(id, 'Emulation.setGeolocationOverride', { accuracy: 10, ...a.geolocation });
  if (a.touch !== undefined) await cdp(id, 'Emulation.setTouchEmulationEnabled', { enabled: a.touch });
  return { emulated: true };
}
async function operation(method, id, a, tab, state, s, env) {
  try {
    return await operationOf(method, id, a, tab, state, s, env);
  } catch (e) {
    if (!(e instanceof DialogOpen)) throw e;
    return { dialog: dialogs.get(id), note: 'A dialog opened during the action. Answer it with qa_dialog' };
  }
}
async function operationOf(method, id, a, tab, state, s, env) {
  const since = Date.now();
  const withPage = async r => ({ ...r, ...(await afterAction(id, a, since)) });
  switch (method) {
    case 'qa_window': {
      const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
      if (tabsInWindow.some(t => claims.has(t.id) && claims.get(t.id) !== s))
        throw Error('Window is shared with another session');
      if (a.focus && !state.visible)
        throw Error('focus=true changes the Windows foreground window. Call qa_session visible=true first');
      if (a.focus || state.visible) {
        await chrome.windows.update(tab.windowId, a.focus ? { state: a.state, focused: true } : { state: a.state });
      } else if (a.state !== 'minimized') {
        // Not visible: change only the size, which keeps the Windows foreground window (see rules.js fillBounds).
        const w = await chrome.windows.get(tab.windowId);
        if (w.state !== 'normal')
          throw Error(`The window is ${w.state}. Changing that needs qa_session visible=true first`);
        await chrome.windows.update(tab.windowId, QaRules.fillBounds(await screenOf(w, env.display), a.state));
        const after = await chrome.windows.get(tab.windowId);
        return { id: after.id, state: a.state, filledBy: 'size', focused: after.focused };
      } else {
        await chrome.windows.update(tab.windowId, { state: a.state });
      }
      const w = await chrome.windows.get(tab.windowId);
      return { id: w.id, state: w.state, focused: w.focused };
    }
    case 'qa_navigate':
      return withPage(await navigate(id, a));
    case 'qa_snapshot': {
      const text = await pageRead(id, a);
      return saveOrText(a, text);
    }
    case 'qa_screenshot':
      return screenshot(id, a);
    case 'qa_eval': {
      const value = await evaluate(id, a.expression, a.frameId, {
        main: true,
        timeout: a.timeoutMs ?? 10000,
        max: a.maxOutputBytes ?? (a.file !== undefined ? 10485760 : 262144)
      });
      if (a.file === undefined) return value;
      return { saved: fileOut({ name: a.file, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }) };
    }
    case 'qa_cdp': {
      const l = logs.get(id);
      if (a.events) {
        if (a.method !== undefined) throw Error('Give method or events, not both');
        const events = l.cdpEvents;
        const dropped = l.cdpDropped;
        l.cdpEvents = [];
        l.cdpDropped = 0;
        return {
          events,
          dropped,
          domains: [...l.cdpDomains],
          ...(l.cdpDomains.size ? {} : { note: 'No domain is recorded. Enable one first, for example method Animation.enable' })
        };
      }
      if (a.method === undefined) throw Error('method is required');
      const params = QaRules.cdpParams(a.method, a.params, tab.url, !!env.policy);
      if (a.frameId) await context(id, a.frameId);
      const r = limited(
        await bounded(cdp(id, a.method, params, a.frameId), a.timeoutMs ?? 10000),
        a.maxOutputBytes ?? 262144
      );
      const domain = a.method.split('.')[0];
      if (/\.enable$/.test(a.method) && l.cdpDomains.size < 10) l.cdpDomains.add(domain);
      if (/\.disable$/.test(a.method)) l.cdpDomains.delete(domain);
      return r;
    }
    case 'qa_click':
      if (a.text !== undefined) {
        if (a.ref !== undefined || a.selector !== undefined) throw Error('Give ref, selector or text, not two');
        return withPage(await clickText(id, a, state.visible));
      }
      return withPage(await click(id, a, state.visible));
    case 'qa_hover': {
      const point = await mouseElement(id, a);
      await input(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      return withPage({ hovered: true });
    }
    case 'qa_scroll':
      if (a.ref !== undefined || a.selector !== undefined) {
        const t = await target(id, a);
        await cdp(id, 'DOM.scrollIntoViewIfNeeded', { objectId: t.objectId }, t.frame);
      } else
        await input(id, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: a.x ?? 100,
          y: a.y ?? 100,
          deltaX: a.deltaX ?? 0,
          deltaY: a.deltaY ?? 0
        });
      return withPage({ scrolled: true });
    case 'qa_drag': {
      const from = a.ref !== undefined ? await mouseElement(id, a) : { x: a.fromX, y: a.fromY };
      const to = a.toRef !== undefined ? await mouseElement(id, { ref: a.toRef }) : { x: a.toX, y: a.toY };
      if ([from.x, from.y, to.x, to.y].some(v => typeof v !== 'number'))
        throw Error('Give ref or fromX and fromY, and toRef or toX and toY');
      const n = a.steps ?? 10;
      await input(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
      await input(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
      for (let i = 1; i <= n; i++)
        await input(id, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + ((to.x - from.x) * i) / n,
          y: from.y + ((to.y - from.y) * i) / n,
          button: 'left',
          buttons: 1
        });
      await input(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
      return withPage({ dragged: true });
    }
    case 'qa_type': {
      if (a.text === undefined && a.key === undefined) throw Error('Give text, key or both');
      const events = a.key !== undefined ? QaRules.keyEvents({ key: a.key }) : [];
      await cdp(id, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      try {
        if (a.ref !== undefined || a.selector !== undefined)
          await callOn(id, await target(id, a), 'function () { this.focus(); }');
        if (a.text !== undefined) await input(id, 'Input.insertText', { text: a.text });
        for (const e of events) await input(id, 'Input.dispatchKeyEvent', e);
      } finally {
        await quietly(id, cdp(id, 'Emulation.setFocusEmulationEnabled', { enabled: false }));
      }
      return withPage({ typed: true });
    }
    case 'qa_fill': {
      if (!a.fields.length) throw Error('fields is empty');
      for (const [i, f] of a.fields.entries()) {
        try {
          if (f.value === undefined && f.values === undefined) throw Error('give value (or values for a select)');
          const t = await target(id, { ref: f.ref, selector: f.selector, frameId: a.frameId });
          await callOn(id, t, FILL, [f.value === undefined ? null : f.value, f.values === undefined ? null : f.values]);
        } catch (e) {
          throw Error(`Field ${i + 1} (${f.ref || f.selector}): ${errorText(e)}` + (i ? `. Fields 1 to ${i} were set` : ''));
        }
      }
      return withPage({ filled: a.fields.length });
    }
    case 'qa_upload': {
      const t = await target(id, a);
      await cdp(id, 'DOM.setFileInputFiles', { objectId: t.objectId, files: a.paths }, t.frame);
      return withPage({ fileCount: a.paths.length });
    }
    case 'qa_wait': {
      const timeout = a.timeoutMs ?? 30000,
        end = Date.now() + timeout;
      const wanted = [];
      if (a.selector !== undefined) wanted.push('selector ' + a.selector);
      if (a.text !== undefined) wanted.push('text ' + JSON.stringify(a.text));
      if (a.textGone !== undefined) wanted.push('text gone ' + JSON.stringify(a.textGone));
      if (a.url !== undefined) wanted.push('URL with ' + a.url);
      const check = `(() => {
        const norm = s => (s || '').replace(/\\s+/gu, ' ');
        const text = norm(document.body?.innerText);
        return document.readyState === 'complete' &&
          ${a.selector !== undefined ? `!!document.querySelector(${JSON.stringify(a.selector)})` : 'true'} &&
          ${a.text !== undefined ? `text.includes(norm(${JSON.stringify(a.text)}).trim())` : 'true'} &&
          ${a.textGone !== undefined ? `!text.includes(norm(${JSON.stringify(a.textGone)}).trim())` : 'true'};
      })()`;
      do {
        let ok = false;
        try {
          ok = await evaluate(id, check, a.frameId);
          if (ok && a.url !== undefined) ok = (await chrome.tabs.get(id)).url.includes(a.url);
        } catch (e) {
          if (/Expected|SyntaxError|not a valid selector/.test(errorText(e))) throw e;
        }
        if (ok) return withPage({ waited: true });
        if (Date.now() >= end)
          throw Error(`Waited ${timeout} ms for the page to load` + (wanted.length ? ' and for ' + wanted.join(', ') : ''));
        await sleep(150);
      } while (true);
    }
    case 'qa_emulate':
      return emulate(id, a);
    case 'qa_dialog':
      if (a.action === 'inspect') return { dialog: dialogs.get(id) || null };
      await cdp(id, 'Page.handleJavaScriptDialog', {
        accept: a.action === 'accept',
        promptText: a.promptText || ''
      });
      return withPage({ handled: true });
    case 'qa_storage': {
      if (a.area === 'cookies') {
        if (a.action === 'get') {
          const { cookies } = await cdp(id, 'Network.getCookies', { urls: [tab.url] });
          return { cookies: a.key !== undefined ? cookies.filter(c => c.name === a.key) : cookies };
        }
        if (a.action === 'set') {
          if (!a.cookie) throw Error('set needs cookie, for example {"name":"a","value":"b"}');
          return cdp(id, 'Network.setCookie', QaRules.tabCookie(a.cookie, tab.url));
        }
        const { cookies } = await cdp(id, 'Network.getCookies', { urls: [tab.url] });
        const names = a.action === 'clear' ? cookies.map(c => c.name) : [a.key];
        if (a.action === 'delete' && a.key === undefined) throw Error('delete needs key (the cookie name)');
        for (const name of names) await cdp(id, 'Network.deleteCookies', QaRules.tabCookie({ name }, tab.url));
        return { deleted: names.length };
      }
      return evaluate(
        id,
        `(() => {
          const store = ${a.area === 'local' ? 'localStorage' : 'sessionStorage'};
          const action = ${JSON.stringify(a.action)}, key = ${JSON.stringify(a.key ?? null)};
          if (action === 'get')
            return key !== null
              ? { value: store.getItem(key) }
              : { items: Object.fromEntries(Object.keys(store).map(k => [k, store.getItem(k)])) };
          if (action === 'set') {
            if (key === null) throw Error('set needs key');
            store.setItem(key, ${JSON.stringify(a.value ?? '')});
          } else if (action === 'delete') {
            if (key === null) throw Error('delete needs key');
            store.removeItem(key);
          } else store.clear();
          return { updated: true };
        })()`,
        a.frameId
      );
    }
    case 'qa_console': {
      const l = logs.get(id);
      const text = QaLogs.consoleList(l.messages, {
        level: a.level,
        filter: a.filter,
        offset: a.offset,
        limit: a.file !== undefined ? MAX_MESSAGES : a.limit,
        origin: QaRules.originOf(tab.url),
        pages: l.pages
      });
      return saveOrText(a, text);
    }
    case 'qa_network':
      return networkTool(id, a, tab);
    case 'qa_record':
      return startRecording(id, a, s, env);
    case 'qa_perf':
      return perfTool(id, a, s, state, env);
    default:
      throw Error('Unknown operation');
  }
}

// ---------------------------------------------------------------------------
// Recording (qa_record). Page.startScreencast sends a JPEG frame when the page changes. The
// offscreen document recorder.html encodes the frames to H.264 and writes an MP4 file. When the
// screencast sends nothing (a page that does not change, or a tab that is not shown), a screenshot
// is taken instead: once a second, or up to 5 times a second for a hidden tab.

// GitHub takes videos up to 10 MB in issues and pull requests on free plans. Stop at 9.5 MB
// (decimal), so the finished file stays under 10,000,000 bytes.
const RECORD_MAX_BYTES = 9500000,
  RECORD_MAX_AT_ONCE = 4;
const recordings = new Map();
let recorderReady = null;
function recorderPage() {
  if (!recorderReady)
    recorderReady = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: 'recorder.html',
        reasons: ['BLOBS'],
        justification: 'Encode the frames of a recorded tab into an MP4 file'
      });
    })().catch(e => {
      recorderReady = null;
      throw e;
    });
  return recorderReady;
}
async function toRecorder(m) {
  const r = await chrome.runtime.sendMessage({ target: 'recorder', ...m });
  if (!r) throw Error('The recorder page did not answer');
  if (!r.ok) throw Error(r.error);
  return r;
}
const recordSeconds = rec => (Date.now() - rec.startedAt) / 1000;
// A frame may be recorded only while the tab is on a site that the policy lets qa_record use.
function recordable(rec) {
  try {
    const l = logs.get(rec.tabId);
    QaRules.checkPolicy(rec.policy, { tool: 'qa_record', places: [{ what: 'tab', url: l && l.pages[l.pages.length - 1].url }] });
    return true;
  } catch {
    return false;
  }
}
function sendFrame(rec, data, t) {
  rec.lastSent = t;
  rec.lastFrameAt = Date.now();
  rec.inflight++;
  rec.sending = rec.sending
    .then(() => toRecorder({ op: 'frame', id: rec.id, data, t }))
    .then(
      r => {
        rec.bytes = r.bytes;
        rec.frames = r.frames;
        if (r.bytes >= RECORD_MAX_BYTES) finishRecording(rec, 'size limit (9.5 MB)');
      },
      e => {
        rec.error = errorText(e);
        finishRecording(rec, 'error');
      }
    )
    .finally(() => rec.inflight--);
}
// One frame from the screencast or a screenshot. At most fps frames a second are encoded; a frame
// that comes too early waits, and a newer one replaces it, so the last picture is never lost.
function onFrame(rec, data) {
  if (rec.stoppedBy) return;
  const t = rec.starting ? 0 : recordSeconds(rec);
  if (!recordable(rec)) {
    rec.skipped++;
    rec.pending = null;
    if (!rec.blanked) {
      rec.blanked = true;
      rec.lastFrameAt = Date.now();
      rec.sending = rec.sending.then(() =>
        toRecorder({ op: 'blank', id: rec.id, t, text: 'Not recorded: policy.json does not allow this site' }).catch(() => {})
      );
    }
    return;
  }
  rec.blanked = false;
  const gap = 1 / rec.fps;
  if (rec.lastSent === undefined || (t - rec.lastSent >= gap && rec.inflight < 3)) return sendFrame(rec, data, t);
  rec.pending = data;
  if (!rec.timer)
    rec.timer = setTimeout(() => {
      rec.timer = null;
      const next = rec.pending;
      rec.pending = null;
      if (next) onFrame(rec, next);
    }, Math.max(20, (rec.lastSent + gap - t) * 1000));
}
async function pollFrame(rec, first = false) {
  if (rec.capturing || rec.stoppedBy) return;
  rec.capturing = true;
  try {
    const params = { format: 'jpeg', quality: 80 };
    const r = first ? await captureTab(rec.tabId, params) : await bounded(cdp(rec.tabId, 'Page.captureScreenshot', params), 3000);
    onFrame(rec, r.data);
  } catch {
  } finally {
    rec.capturing = false;
  }
}
async function startRecording(id, a, s, env) {
  if (recordings.has(id)) throw Error('This tab is already being recorded. Stop that recording first');
  if ([...recordings.values()].filter(r => !r.stoppedBy).length >= RECORD_MAX_AT_ONCE)
    throw Error(`At most ${RECORD_MAX_AT_ONCE} recordings can run at once`);
  const file = a.file || 'recording-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '.mp4';
  if (/\.[^.]*$/.test(file) && !/\.mp4$/i.test(file)) throw Error('A recording is an MP4 file: give a file name that ends with .mp4');
  await recorderPage();
  const rec = {
    id: Math.random().toString(36).slice(2),
    tabId: id,
    session: s,
    file,
    policy: env.policy,
    fps: a.fps ?? 10,
    maxSeconds: a.maxSeconds ?? 60,
    maxSize: a.maxSize ?? 1280,
    startedAt: Date.now(),
    frames: 0,
    bytes: 0,
    skipped: 0,
    inflight: 0,
    visible: true,
    sending: Promise.resolve()
  };
  await toRecorder({ op: 'start', id: rec.id, maxSize: rec.maxSize, fps: rec.fps, bitrate: 2000000 });
  recordings.set(id, rec);
  // The first frame starts the encoder, which can take a second or two. The clock starts after it,
  // so the video begins when this call returns.
  try {
    rec.starting = true;
    await pollFrame(rec, true);
    await rec.sending;
    if (rec.error) throw Error(rec.error);
    if (!rec.frames) throw Error('Could not capture the tab');
  } catch (e) {
    recordings.delete(id);
    finishRecording(rec, 'error');
    throw Error('The recording could not start: ' + errorText(e));
  }
  rec.starting = false;
  rec.startedAt = Date.now();
  rec.lastSent = 0;
  await cdp(id, 'Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: rec.maxSize, maxHeight: rec.maxSize });
  rec.poll = setInterval(() => {
    const wait = rec.visible ? 1000 : 1000 / Math.min(rec.fps, 5);
    if (Date.now() - (rec.lastFrameAt || 0) >= wait) pollFrame(rec);
  }, 100);
  rec.stopTimer = setTimeout(() => finishRecording(rec, 'maxSeconds (' + rec.maxSeconds + ' s)'), rec.maxSeconds * 1000);
  return { recording: true, tabId: id, file, maxSeconds: rec.maxSeconds, fps: rec.fps, maxSize: rec.maxSize };
}
// Stop a recording (once) and make the MP4 file. The file waits in memory until qa_record stop,
// or the end of the session, saves it.
function finishRecording(rec, why) {
  if (rec.finished) return rec.finished;
  rec.stoppedBy = why;
  rec.seconds = Math.round(recordSeconds(rec) * 10) / 10;
  clearInterval(rec.poll);
  clearTimeout(rec.stopTimer);
  clearTimeout(rec.timer);
  if (claims.has(rec.tabId)) cdp(rec.tabId, 'Page.stopScreencast').catch(() => {});
  if (rec.pending && recordable(rec)) sendFrame(rec, rec.pending, recordSeconds(rec));
  const end = recordSeconds(rec);
  rec.finished = rec.sending
    .then(() => toRecorder({ op: 'stop', id: rec.id, t: end }))
    .then(
      r => (rec.result = r),
      e => (rec.error = rec.error || errorText(e))
    );
  return rec.finished;
}
async function savedRecording(rec) {
  await finishRecording(rec, 'stop');
  recordings.delete(rec.tabId);
  if (!rec.result) throw Error('The recording failed: ' + rec.error);
  const r = rec.result;
  return {
    saved: fileOut({ name: rec.file, base64: r.data, ext: 'mp4' }),
    tabId: rec.tabId,
    seconds: r.seconds,
    frames: r.frames,
    width: r.width,
    height: r.height,
    format: 'mp4 (' + r.codec + ')',
    stoppedBy: rec.stoppedBy,
    ...(rec.skipped ? { framesNotRecorded: rec.skipped, note: 'Some frames were left out: the tab was on a site that policy.json does not allow' } : {})
  };
}
async function recordTool(a, s) {
  const mine = [...recordings.values()].filter(r => r.session === s);
  if (a.action === 'status' || a.action === undefined)
    return {
      recordings: mine.map(r => ({
        tabId: r.tabId,
        file: r.file,
        state: r.stoppedBy ? 'stopped: ' + r.stoppedBy : 'recording',
        seconds: r.stoppedBy ? r.seconds : Math.round(recordSeconds(r) * 10) / 10,
        frames: r.frames,
        bytes: r.bytes
      }))
    };
  if (a.action !== 'stop') throw Error('Unknown action ' + a.action);
  const rec = a.tabId !== undefined ? mine.find(r => r.tabId === a.tabId) : mine.length === 1 ? mine[0] : undefined;
  if (!rec)
    throw Error(a.tabId === undefined && mine.length > 1 ? 'Several recordings run. Give tabId' : 'No recording of this session on that tab. Start one with action start');
  return savedRecording(rec);
}
chrome.tabs.onRemoved.addListener(id => {
  const rec = recordings.get(id);
  if (rec) finishRecording(rec, 'tab closed');
});

// ---------------------------------------------------------------------------
// Speed and memory (qa_perf).

// The network presets of Chrome DevTools (bytes per second, latency in ms).
const NETWORK = {
  'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
  'slow-4g': { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 },
  'fast-4g': { offline: false, latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
};
// Throttling for the tab and the cross-site frames in it (they run in their own process).
async function throttleTarget(target, t) {
  await chrome.debugger.sendCommand(target, 'Emulation.setCPUThrottlingRate', { rate: t.cpu });
  await chrome.debugger.sendCommand(target, 'Network.emulateNetworkConditions', NETWORK[t.network]);
}
async function throttle(id, a) {
  const l = logs.get(id);
  l.throttle = { cpu: a.cpu ?? 1, network: a.network ?? 'none' };
  await throttleTarget({ tabId: id }, l.throttle);
  for (const c of children.get(id).values()) await throttleTarget({ tabId: id, sessionId: c.sessionId }, l.throttle).catch(() => {});
  return { throttle: l.throttle, note: 'It stays until you change it or release the tab. Reload the page to measure the load under it' };
}
const PERF_READ = `(async () => {
  const take = type => new Promise(done => {
    const got = [];
    let o;
    try {
      o = new PerformanceObserver(l => got.push(...l.getEntries()));
      o.observe({ type, buffered: true });
    } catch {
      return done(got);
    }
    setTimeout(() => { got.push(...o.takeRecords()); o.disconnect(); done(got); }, 50);
  });
  const name = e => !e || !e.tagName ? null : e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
    (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const [lcp, shifts, events, first, long] = await Promise.all(
    ['largest-contentful-paint', 'layout-shift', 'event', 'first-input', 'longtask'].map(take));
  const n = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const last = lcp[lcp.length - 1];
  return {
    url: location.href,
    nav: n && { type: n.type, ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, transfer: n.transferSize },
    fcp: fcp ? fcp.startTime : null,
    lcp: last ? { t: last.startTime, element: name(last.element), url: last.url } : null,
    shifts: shifts.map(s => ({ t: s.startTime, v: s.value, input: s.hadRecentInput })),
    events: events.concat(first).filter(e => e.interactionId).map(e => ({ id: e.interactionId, name: e.name, d: e.duration, target: name(e.target) })),
    longTasks: long.map(e => e.duration),
    resources: performance.getEntriesByType('resource').map(r => ({ url: r.name, type: r.initiatorType, d: r.duration, size: r.transferSize, blocking: r.renderBlockingStatus === 'blocking' }))
  };
})()`;
// Memory after a full garbage collection. Chrome does not give extensions
// HeapProfiler.collectGarbage, so the native host asks the Chrome keeper, which has the browser's
// CDP pipe (see Lifecycle.cs GcService). Nodes and listeners are counted for the tab's renderer
// process, so they include elements that left the page but are still held.
async function memory(id) {
  const l = logs.get(id);
  if (!l.perfOn) {
    await cdp(id, 'Performance.enable');
    l.perfOn = true;
  }
  const targetId = (await chrome.debugger.getTargets()).find(t => t.tabId === id && t.type === 'page')?.id;
  let gc = true;
  try {
    // Twice: the first collection can leave objects that wait for a finalizer.
    for (let i = 0; i < 2; i++) await hostCall({ keeper: 'gc', targetId });
  } catch (e) {
    gc = false;
    l.gcError = errorText(e);
  }
  const heap = await cdp(id, 'Runtime.getHeapUsage');
  const m = Object.fromEntries((await cdp(id, 'Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  return {
    gc,
    heapUsedBytes: heap.usedSize,
    heapTotalBytes: heap.totalSize,
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    documents: m.Documents,
    domElements: await evaluate(id, "document.getElementsByTagName('*').length")
  };
}
// Steps for leak and trace: tool calls on this tab, like qa_batch steps, with the same checks.
async function perfSteps(id, steps, s, state, env) {
  for (const [i, step] of (steps || []).entries()) {
    try {
      if (!BATCH_TOOLS.has(step.tool)) throw Error(`${step.tool} cannot be a step`);
      const args = { ...step.args, tabId: id, snapshot: false };
      args.frameId = frameArg(id, args.frameId);
      const left = stepTime(env.deadline, 'qa_perf');
      const tab = await owned(id, s);
      const r = await bounded(
        checkPolicy(env.policy, step.tool, id, args, tab).then(() => operation(step.tool, id, args, tab, state, s, env)),
        left,
        id
      );
      if (r && r.clicked === false) throw Error('The click was not delivered: ' + r.reason);
      if (r && r.dialog) throw Error('A dialog opened. Answer it with qa_dialog');
    } catch (e) {
      throw Error(`Step ${i + 1} (${step.tool}): ${errorText(e)}`);
    }
  }
}
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'latencyInfo',
  'toplevel'
];
// The trace goes back as JSON text, where its quotes are escaped. 7 MB stays under the 15 MB reply limit.
const TRACE_MAX_CHARS = 7 * 1024 * 1024;
async function trace(id, a, s, state, env) {
  if (a.file === undefined) throw Error('trace needs file, for example trace.json');
  const l = logs.get(id);
  const done = new Promise(r => (l.traceDone = r));
  await cdp(id, 'Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: TRACE_CATEGORIES } });
  const started = Date.now();
  try {
    if (a.steps && a.steps.length) await perfSteps(id, a.steps, s, state, env);
    else {
      const r = await navigate(id, { action: 'reload', timeoutMs: 20000 });
      if (!r.loaded) throw Error(r.reason);
    }
    await sleep(500);
  } finally {
    await cdp(id, 'Tracing.end');
  }
  const { stream } = await bounded(done, 15000);
  const parts = [];
  let chars = 0;
  try {
    for (;;) {
      const r = await cdp(id, 'IO.read', { handle: stream, size: 1048576 });
      const text = r.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(r.data), c => c.charCodeAt(0))) : r.data;
      parts.push(text);
      chars += text.length;
      if (chars > TRACE_MAX_CHARS) throw Error('The trace is over 7 MB. Trace fewer steps');
      if (r.eof) break;
    }
  } finally {
    await cdp(id, 'IO.close', { handle: stream }).catch(() => {});
  }
  const text = parts.join('');
  let events = null;
  try {
    const j = JSON.parse(text);
    events = (Array.isArray(j) ? j : j.traceEvents || []).length;
  } catch {}
  return {
    saved: fileOut({ name: a.file, text, ext: 'json' }),
    events,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    note: 'Open the file in Chrome DevTools: Performance panel, Load profile'
  };
}
async function perfTool(id, a, s, state, env) {
  const action = a.action || 'metrics';
  const l = logs.get(id);
  if (action === 'throttle') return throttle(id, a);
  if (action === 'metrics')
    return {
      ...QaPerf.summary(await evaluate(id, PERF_READ, undefined, { timeout: 5000 }), a.limit ?? 5, QaLogs.hideUrl),
      throttle: l.throttle || { cpu: 1, network: 'none' }
    };
  if (action === 'memory') {
    const m = await memory(id);
    return m.gc ? m : { ...m, note: 'No garbage collection, so the numbers include garbage: ' + l.gcError };
  }
  if (action === 'leak') {
    if (!a.steps || !a.steps.length) throw Error('leak needs steps: the action to repeat, for example [{tool:"qa_click", args:{ref:"e5"}}]');
    const repeat = a.repeat ?? 5;
    // One run first, so caches and lazy code do not count as a leak.
    await perfSteps(id, a.steps, s, state, env);
    const samples = [await memory(id)];
    for (let i = 0; i < repeat; i++) {
      await perfSteps(id, a.steps, s, state, env);
      stepTime(env.deadline, 'qa_perf');
      samples.push(await memory(id));
    }
    return {
      ...QaPerf.leak(samples),
      before: samples[0],
      after: samples[repeat],
      nodes: samples.map(x => x.nodes),
      heapKB: samples.map(x => Math.round(x.heapUsedBytes / 1024))
    };
  }
  if (action === 'trace') return trace(id, a, s, state, env);
  throw Error('Unknown action ' + action);
}

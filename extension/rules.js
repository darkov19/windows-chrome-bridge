'use strict';
// Pure rules with no browser calls. background.js loads this file with importScripts().
// tests/rules.test.js loads it in node.
(function (root) {
  // ---------------------------------------------------------------------------
  // Keys: turn "Enter", "a" or "Control+A" into CDP Input.dispatchKeyEvent params.
  // Codes follow the US keyboard layout.

  const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const MODIFIER_NAMES = {
    alt: 'Alt',
    option: 'Alt',
    control: 'Control',
    ctrl: 'Control',
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    win: 'Meta',
    shift: 'Shift'
  };
  const MODIFIER_KEYS = {
    Alt: { code: 'AltLeft', keyCode: 18 },
    Control: { code: 'ControlLeft', keyCode: 17 },
    Meta: { code: 'MetaLeft', keyCode: 91 },
    Shift: { code: 'ShiftLeft', keyCode: 16 }
  };
  const NAMED_KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    Insert: { code: 'Insert', keyCode: 45 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ContextMenu: { code: 'ContextMenu', keyCode: 93 },
    CapsLock: { code: 'CapsLock', keyCode: 20 }
  };
  for (let n = 1; n <= 12; n++) NAMED_KEYS['F' + n] = { code: 'F' + n, keyCode: 111 + n };
  const KEY_ALIASES = {
    esc: 'Escape',
    return: 'Enter',
    del: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    pgup: 'PageUp',
    pgdn: 'PageDown'
  };
  const NAMED_LOWER = {};
  for (const name of Object.keys(NAMED_KEYS)) NAMED_LOWER[name.toLowerCase()] = name;
  // Base character -> [code, keyCode, character with Shift].
  const CHARACTER_KEYS = {
    0: ['Digit0', 48, ')'],
    1: ['Digit1', 49, '!'],
    2: ['Digit2', 50, '@'],
    3: ['Digit3', 51, '#'],
    4: ['Digit4', 52, '$'],
    5: ['Digit5', 53, '%'],
    6: ['Digit6', 54, '^'],
    7: ['Digit7', 55, '&'],
    8: ['Digit8', 56, '*'],
    9: ['Digit9', 57, '('],
    '-': ['Minus', 189, '_'],
    '=': ['Equal', 187, '+'],
    '[': ['BracketLeft', 219, '{'],
    ']': ['BracketRight', 221, '}'],
    '\\': ['Backslash', 220, '|'],
    ';': ['Semicolon', 186, ':'],
    "'": ['Quote', 222, '"'],
    ',': ['Comma', 188, '<'],
    '.': ['Period', 190, '>'],
    '/': ['Slash', 191, '?'],
    '`': ['Backquote', 192, '~']
  };
  const SHIFTED_CHARACTERS = {};
  for (const [base, [code, keyCode, shifted]] of Object.entries(CHARACTER_KEYS))
    SHIFTED_CHARACTERS[shifted] = { base, code, keyCode };

  // One key without modifiers. shift=true gives the shifted character (a -> A, 1 -> !).
  function mainKey(name, shift) {
    if (name === ' ' || name.toLowerCase() === 'space')
      return { key: ' ', code: 'Space', keyCode: 32, text: ' ' };
    const modifier = MODIFIER_NAMES[name.toLowerCase()];
    if (modifier) return { key: modifier, ...MODIFIER_KEYS[modifier] };
    const named = NAMED_LOWER[name.toLowerCase()] || KEY_ALIASES[name.toLowerCase()];
    if (named && name.length > 1) return { key: named, ...NAMED_KEYS[named] };
    if ([...name].length !== 1)
      throw Error(
        `Unknown key "${name}". Use one character or a name like Enter, Tab, Escape, ArrowDown, F5`
      );
    if (/^[a-z]$/i.test(name)) {
      const upper = name.toUpperCase();
      const key = shift ? upper : name;
      return { key, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: key };
    }
    if (CHARACTER_KEYS[name]) {
      const [code, keyCode, shifted] = CHARACTER_KEYS[name];
      const key = shift ? shifted : name;
      return { key, code, keyCode, text: key };
    }
    if (SHIFTED_CHARACTERS[name]) {
      const { code, keyCode } = SHIFTED_CHARACTERS[name];
      return { key: name, code, keyCode, text: name };
    }
    // Any other single character (for example é): no physical key code.
    return { key: name, code: '', keyCode: 0, text: name };
  }

  // Parse "Control+Shift+Tab". The last part is the key; the others are modifiers.
  function parseKey(spec) {
    if (typeof spec !== 'string' || !spec) throw Error('key is required');
    let parts;
    if (spec === '+') parts = ['+'];
    else if (spec.endsWith('++')) parts = [...spec.slice(0, -2).split('+'), '+'];
    else parts = spec.split('+');
    const name = parts.pop();
    if (!name) throw Error(`Invalid key "${spec}"`);
    const modifiers = [];
    for (const part of parts) {
      const modifier = MODIFIER_NAMES[part.toLowerCase()];
      if (!modifier)
        throw Error(`Unknown modifier "${part}" in "${spec}". Use Alt, Control, Meta or Shift`);
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
    }
    return { modifiers, ...mainKey(name, modifiers.includes('Shift')) };
  }

  // The CDP Input.dispatchKeyEvent events for a key such as "Enter" or "Control+A" (qa_type key).
  function keyEvents(a) {
    const k = parseKey(a.key);
    const all = k.modifiers.reduce((bits, m) => bits | MODIFIER_BITS[m], 0);
    // A shortcut (Control, Alt or Meta held) types no text.
    const shortcut = (all & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) !== 0;
    const text = shortcut ? undefined : k.text;
    const events = [];
    let held = 0;
    for (const m of k.modifiers) {
      held |= MODIFIER_BITS[m];
      events.push({
        type: 'rawKeyDown',
        key: m,
        code: MODIFIER_KEYS[m].code,
        windowsVirtualKeyCode: MODIFIER_KEYS[m].keyCode,
        modifiers: held,
        location: 1
      });
    }
    const p = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: all };
    events.push(
      text ? { ...p, type: 'keyDown', text, unmodifiedText: text } : { ...p, type: 'rawKeyDown' }
    );
    events.push({ ...p, type: 'keyUp' });
    for (const m of [...k.modifiers].reverse()) {
      held &= ~MODIFIER_BITS[m];
      events.push({
        type: 'keyUp',
        key: m,
        code: MODIFIER_KEYS[m].code,
        windowsVirtualKeyCode: MODIFIER_KEYS[m].keyCode,
        modifiers: held,
        location: 1
      });
    }
    return events;
  }

  // ---------------------------------------------------------------------------
  // qa_cdp: keep raw CDP inside the claimed tab.

  // Domains that reach the whole browser, the whole profile, or other origins' storage.
  const BLOCKED_DOMAINS = {
    Target: 'use the tab and window tools',
    Browser: 'use the tab and window tools',
    SystemInfo: 'not tab-scoped',
    Tethering: 'not tab-scoped',
    Storage:
      'it reads and clears data of every origin in the profile; use qa_storage',
    DOMStorage: "it reaches other origins' storage; use qa_storage",
    IndexedDB: "it reaches other origins' databases; use qa_eval in the page",
    CacheStorage: "it reaches other origins' caches; use qa_eval in the page",
    Database: "it reaches other origins' databases",
    ServiceWorker: 'it controls service workers of every origin in the profile',
    Tracing: 'a trace records every tab in the profile'
  };
  const BLOCKED_METHODS = {
    'Network.getAllCookies':
      'it reads every cookie in the profile; use Network.getCookies or qa_storage area cookies',
    'Network.clearBrowserCookies': 'it deletes every cookie in the profile',
    'Network.clearBrowserCache': 'it clears the cache of the whole profile',
    'Network.setCookies': 'it can set cookies for any site; use Network.setCookie or qa_storage area cookies',
    'Network.loadNetworkResource': "it fetches any URL with that site's cookies",
    'Page.setDownloadBehavior': 'it can save files to any folder; use qa_downloads'
  };
  // Blocked only when policy.json is active: their effect lasts after the tab moves to
  // an origin that is not listed.
  const POLICY_BLOCKED_METHODS = {
    'Page.addScriptToEvaluateOnNewDocument':
      'the script would also run on origins that are not listed',
    // Streams and old interception ids: the bridge cannot tell which site the data comes from.
    'IO.read': 'it reads a stream by handle, and the bridge cannot tell which site the stream comes from',
    'Fetch.takeResponseBodyAsStream': 'the stream can only be read with IO.read, which is blocked',
    'Network.takeResponseBodyForInterceptionAsStream': 'the stream can only be read with IO.read, which is blocked',
    'Network.getResponseBodyForInterception': 'the bridge cannot tell which site an interception id belongs to',
    'Network.continueInterceptedRequest': 'the bridge cannot tell which site an interception id belongs to'
  };
  // Checked when policy.json is active, like qa_network request and qa_navigate (see background.js
  // checkPolicy): request = params.requestId, a Network request of the tab; paused = a paused Fetch
  // request; resource = params.url; navigation = params.url as a navigation target; history =
  // params.entryId, an entry of the tab's history.
  const POLICY_CHECKED_METHODS = {
    'Network.getResponseBody': 'request',
    'Network.streamResourceContent': 'request',
    'Network.getRequestPostData': 'request',
    'Network.searchInResponseBody': 'request',
    'Network.replayXHR': 'request',
    'Audits.getEncodedResponse': 'request',
    'Fetch.getResponseBody': 'paused',
    'Page.getResourceContent': 'resource',
    'Page.searchInResource': 'resource',
    'Page.navigate': 'navigation',
    'Page.navigateToHistoryEntry': 'history'
  };
  const cdpPolicyCheck = method => POLICY_CHECKED_METHODS[method];

  function httpUrl(raw, what) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw Error(`${what} is not a valid URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw Error(`${what} must be an http(s) URL`);
    return u;
  }

  // A cookie domain must be the tab's host or a parent of it.
  function checkCookieDomain(domain, tabUrl) {
    if (domain === undefined) return;
    const host = new URL(tabUrl).hostname.toLowerCase();
    const d = String(domain).replace(/^\./, '').toLowerCase();
    if (!d || (host !== d && !host.endsWith('.' + d)))
      throw Error(`Cookie domain ${domain} does not match the claimed tab (${host})`);
  }

  // A cookie for set/delete, tied to the claimed tab's URL.
  function tabCookie(cookie, tabUrl) {
    const tab = httpUrl(tabUrl, 'The claimed tab URL');
    const c = { ...(cookie || {}) };
    if (c.url !== undefined && httpUrl(c.url, 'Cookie url').origin !== tab.origin)
      throw Error('Cookies are limited to the claimed tab URL; leave url out');
    checkCookieDomain(c.domain, tabUrl);
    c.url = tabUrl;
    return c;
  }

  // Returns the params to send, or throws with the reason.
  function cdpParams(method, params, tabUrl, policyActive) {
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method))
      throw Error('Invalid CDP method');
    const domain = method.split('.')[0];
    if (BLOCKED_DOMAINS[domain])
      throw Error(`qa_cdp blocks the ${domain} domain: ${BLOCKED_DOMAINS[domain]}`);
    if (BLOCKED_METHODS[method]) throw Error(`qa_cdp blocks ${method}: ${BLOCKED_METHODS[method]}`);
    if (policyActive && POLICY_BLOCKED_METHODS[method])
      throw Error(
        `policy.json is active, so qa_cdp blocks ${method}: ${POLICY_BLOCKED_METHODS[method]}`
      );
    const p = { ...(params || {}) };
    // A page can load a script or style sheet from another site, and these ids do not say which.
    if (policyActive && (domain === 'Debugger' || domain === 'CSS') && ('scriptId' in p || 'styleSheetId' in p))
      throw Error(
        `policy.json is active, so qa_cdp blocks ${method} with a scriptId or styleSheetId: the script or style sheet can come from a site that is not allowed`
      );
    if (method === 'Network.getCookies') {
      const tab = httpUrl(tabUrl, 'The claimed tab URL');
      if (p.urls === undefined) p.urls = [tabUrl];
      else if (
        !Array.isArray(p.urls) ||
        p.urls.some(u => httpUrl(u, 'Each url').origin !== tab.origin)
      )
        throw Error('Network.getCookies is limited to the claimed tab origin');
    }
    if (method === 'Network.setCookie' || method === 'Network.deleteCookies')
      return tabCookie(p, tabUrl);
    if (method === 'Page.navigate') httpUrl(p.url, 'Page.navigate url');
    // Chrome opens these files. A network path would connect to that server with the user's
    // Windows login, so only local paths and WSL shares pass (like qa_upload).
    const files = method === 'DOM.setFileInputFiles' ? p.files : method === 'Input.dispatchDragEvent' ? p.data && p.data.files : undefined;
    for (const f of Array.isArray(files) ? files : [])
      if (!localPath(f))
        throw Error(
          `qa_cdp blocks ${method} with the path ${String(f).slice(0, 100)}: use a drive path (C:\\...) or a WSL share (\\\\wsl.localhost\\...). A network path would connect to that server with your Windows login`
        );
    return p;
  }

  // An allow list: a drive path (C:\x) or a WSL share (\\wsl.localhost\<distro>\x, \\wsl$\<distro>\x),
  // with no .. part. Everything else (\\server\share, \\?\UNC\..., \??\..., relative paths) is refused.
  function localPath(raw) {
    const s = String(raw);
    if (s.split(/[\\/]/).includes('..')) return false;
    return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/](?!\.{1,2}[\\/])[^\\/?*:]+[\\/]/i.test(s);
  }

  // ---------------------------------------------------------------------------
  // Optional site policy (policy.json, sent by the native host with every request).
  //
  //   { "version": 2, "allow": [...], "block": [...], "strict": false }
  //
  // A pattern is an exact origin ("https://app.example.com", "http://localhost:5173") or a site
  // with all its subdomains ("*.example.com": example.com and every subdomain, http or https, any port).
  // - block: no tool works on a blocked site, and no tool navigates to one.
  // - allow: the sensitive tools work only on allowed sites.
  // - strict: every tool works only on allowed sites, and navigation goes only to allowed sites.

  // Tools that are always sensitive. A call that opens one network request (qa_network with
  // request, which shows headers and bodies) or starts a download is sensitive too.
  // Saving output to a file (the file argument) is as sensitive as the same call without it.
  const SENSITIVE_TOOLS = ['qa_upload', 'qa_eval', 'qa_cdp', 'qa_storage'];

  function sensitiveCall(tool, a) {
    return (
      SENSITIVE_TOOLS.includes(tool) ||
      (tool === 'qa_network' && a && a.request !== undefined) ||
      (tool === 'qa_downloads' && a && a.action === 'start')
    );
  }

  function readPattern(raw, field) {
    if (typeof raw !== 'string' || !raw) throw Error(`policy.json: ${field} must list strings`);
    const site = /^\*\.([a-z0-9-]+(\.[a-z0-9-]+)*)$/.exec(raw);
    if (site) return { site: site[1], text: raw };
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw Error(`policy.json: "${raw}" in ${field} is not an origin or *.site`);
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== raw)
      throw Error(
        `policy.json: "${raw}" in ${field} is not a plain http(s) origin. Write it like ${u.origin}, or *.${u.hostname} for the site and its subdomains`
      );
    return { origin: raw, text: raw };
  }

  // Validate the parsed policy.json. Returns {allow, block, strict}.
  function readPolicy(policy) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
      throw Error('policy.json must be a JSON object');
    if (policy.version === 1)
      throw Error('policy.json: version 1 is no longer read. Write version 2, with "allow" in place of "sensitiveOrigins"');
    if (policy.version !== 2) throw Error('policy.json: version must be 2');
    const keys = Object.keys(policy).filter(k => !['version', 'allow', 'block', 'strict'].includes(k));
    if (keys.length) throw Error('policy.json: unknown field ' + keys[0]);
    const list = field => {
      const v = policy[field] === undefined ? [] : policy[field];
      if (!Array.isArray(v) || v.length > 256)
        throw Error(`policy.json: ${field} must be a list of at most 256 patterns`);
      return v.map(x => readPattern(x, field));
    };
    const allow = list('allow'),
      block = list('block');
    if (policy.strict !== undefined && typeof policy.strict !== 'boolean')
      throw Error('policy.json: strict must be true or false');
    const strict = policy.strict === true;
    if (strict && !allow.length) throw Error('policy.json: strict needs at least one site in allow');
    if (!allow.length && !block.length) throw Error('policy.json: give allow, block or both');
    return { allow, block, strict };
  }

  function originOf(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
      return null;
    }
  }

  function matches(patterns, origin) {
    if (!origin) return false;
    const host = new URL(origin).hostname;
    return patterns.some(p =>
      p.origin ? p.origin === origin : host === p.site || host.endsWith('.' + p.site)
    );
  }

  // c: {tool, sensitive, places: [{what, url}]}. Throws with the reason when the policy refuses.
  // An empty url (no pending load, no frame) is skipped.
  function checkPolicy(policy, c) {
    if (!policy) return;
    const p = readPolicy(policy);
    for (const place of c.places) {
      if (place.url === undefined || place.url === null || place.url === '') continue;
      const origin = originOf(place.url);
      if (matches(p.block, origin))
        throw Error(`policy.json blocks ${origin}, so ${c.tool} cannot use it. The ${place.what} is on it`);
      if ((p.strict || (c.sensitive && p.allow.length)) && !matches(p.allow, origin))
        throw Error(
          `policy.json allows ${p.strict ? 'every tool (strict mode)' : c.tool} only on listed sites. ` +
            `The ${place.what} is on ${origin || place.url}, which is not listed`
        );
    }
  }

  // Why a page read leaves out a frame from raw, or null: the site is blocked, or strict mode is on
  // and the site is not allowed.
  function hiddenFrame(policy, raw) {
    if (!policy) return null;
    const p = readPolicy(policy),
      origin = originOf(raw);
    if (matches(p.block, origin)) return 'policy.json blocks this site';
    if (p.strict && !matches(p.allow, origin)) return 'policy.json strict mode allows only listed sites';
    return null;
  }

  // For qa_session: what the policy does, in short.
  function describePolicy(policy) {
    if (!policy) return { active: false };
    const p = readPolicy(policy);
    return {
      active: true,
      allow: p.allow.map(x => x.text),
      block: p.block.map(x => x.text),
      strict: p.strict,
      sensitiveTools: SENSITIVE_TOOLS.concat(['qa_network request', 'qa_downloads start'])
    };
  }

  // ---------------------------------------------------------------------------
  // Window placement. screens: chrome.system.display.getInfo() items.

  // choice: "primary", "secondary" (the primary screen when there is only one) or a 1-based number.
  function chooseScreen(screens, choice) {
    if (!screens.length) throw Error('Chrome reports no screens');
    const primary = screens.find(d => d.isPrimary) || screens[0];
    let found;
    if (choice === 'primary') found = primary;
    else if (choice === 'secondary') found = screens.find(d => !d.isPrimary) || primary;
    else if (/^\d+$/.test(choice)) found = screens[+choice - 1];
    if (!found) {
      const list = screens
        .map((d, i) => `${i + 1}: "${d.name}"${d.isPrimary ? ' (primary)' : ''}`)
        .join(', ');
      throw Error(
        `bridge-config.json screen "${choice}" matches no screen. Use primary, secondary or a number. Screens: ${list}`
      );
    }
    return found;
  }

  // On Windows, Chrome makes a window the foreground window when it maximizes it or makes it
  // fullscreen. So "maximized" and "fullscreen" are done with the window size: maximized fills the
  // work area (the screen without the taskbar), fullscreen fills the whole screen.
  function fillBounds(screen, how) {
    const r = how === 'fullscreen' ? screen.bounds : screen.workArea;
    if (how === 'maximized' || how === 'fullscreen')
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    return { left: r.left, top: r.top, width: Math.min(1280, r.width), height: Math.min(1000, r.height) };
  }

  // ---------------------------------------------------------------------------
  // The wait before connect attempt n + 1 to the native host, after n failed ones in a row: 0.5 s,
  // 1 s, 2 s, 4 s, 8 s, then every 15 s for good. 15 s is under the 30 s after which Chrome stops an
  // idle service worker, so the worker stays up to try again. Never 0, so it cannot spin.
  function reconnectDelay(n) {
    const tries = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    return tries <= 5 ? 500 * 2 ** (tries - 1) : 15000;
  }

  const QaRules = {
    reconnectDelay,
    chooseScreen,
    fillBounds,
    parseKey,
    keyEvents,
    cdpParams,
    localPath,
    cdpPolicyCheck,
    tabCookie,
    readPolicy,
    checkPolicy,
    describePolicy,
    hiddenFrame,
    sensitiveCall,
    originOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = QaRules;
  else root.QaRules = QaRules;
})(typeof self !== 'undefined' ? self : globalThis);

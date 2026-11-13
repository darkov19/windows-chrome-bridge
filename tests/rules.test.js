// Unit tests for extension/rules.js. Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../extension/rules.js');

test('keys: plain names', () => {
  const enter = R.keyEvents({ key: 'Enter' });
  assert.deepEqual(enter[0], {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    modifiers: 0,
    type: 'keyDown',
    text: '\r',
    unmodifiedText: '\r'
  });
  assert.equal(enter[1].type, 'keyUp');
  assert.deepEqual(R.parseKey('ArrowDown'), {
    modifiers: [],
    key: 'ArrowDown',
    code: 'ArrowDown',
    keyCode: 40
  });
  assert.equal(R.parseKey('esc').key, 'Escape');
  assert.equal(R.parseKey('F5').keyCode, 116);
  const a = R.parseKey('a');
  assert.deepEqual([a.key, a.code, a.keyCode, a.text], ['a', 'KeyA', 65, 'a']);
  const tab = R.keyEvents({ key: 'Tab' });
  assert.equal(tab[0].type, 'rawKeyDown');
  assert.equal(tab[0].text, undefined);
});

test('keys: chords', () => {
  const selectAll = R.keyEvents({ key: 'Control+A' });
  assert.deepEqual(
    selectAll.map(e => [e.type, e.key, e.modifiers]),
    [
      ['rawKeyDown', 'Control', 2],
      ['rawKeyDown', 'A', 2],
      ['keyUp', 'A', 2],
      ['keyUp', 'Control', 0]
    ]
  );
  assert.equal(selectAll[1].text, undefined, 'a shortcut types no text');
  assert.equal(selectAll[1].code, 'KeyA');
  const back = R.keyEvents({ key: 'Shift+Tab' });
  assert.deepEqual(
    back.map(e => [e.type, e.key, e.modifiers]),
    [
      ['rawKeyDown', 'Shift', 8],
      ['rawKeyDown', 'Tab', 8],
      ['keyUp', 'Tab', 8],
      ['keyUp', 'Shift', 0]
    ]
  );
  const bang = R.keyEvents({ key: 'Shift+1' });
  assert.deepEqual([bang[1].key, bang[1].text, bang[1].code], ['!', '!', 'Digit1']);
  assert.equal(R.parseKey('Ctrl++').key, '+');
  assert.deepEqual(R.parseKey('Ctrl++').modifiers, ['Control']);
  assert.throws(() => R.parseKey('Hyper+A'), /Unknown modifier/);
  assert.throws(() => R.parseKey('Enterr'), /Unknown key/);
});

test('qa_cdp: profile-wide cookie and storage access is blocked', () => {
  const tab = 'https://app.example.com/page';
  for (const m of [
    'Network.getAllCookies',
    'Network.clearBrowserCookies',
    'Network.setCookies',
    'Network.loadNetworkResource',
    'Storage.getCookies',
    'Storage.clearDataForOrigin',
    'DOMStorage.getDOMStorageItems',
    'IndexedDB.requestData',
    'CacheStorage.requestEntries',
    'Target.getTargets',
    'Browser.getVersion',
    'Page.setDownloadBehavior'
  ])
    assert.throws(() => R.cdpParams(m, {}, tab, false), /qa_cdp blocks/, m);
  for (const m of [
    'Runtime.evaluate',
    'Fetch.enable',
    'Network.getResponseBody',
    'Emulation.setDeviceMetricsOverride',
    'DOM.getDocument',
    'Page.reload'
  ])
    assert.deepEqual(R.cdpParams(m, { x: 1 }, tab, false), { x: 1 }, m);
});

test('qa_cdp: file paths on a network share are blocked', () => {
  const tab = 'https://app.example.com/page';
  for (const f of [
    '\\\\attacker\\share\\x.txt',
    '//attacker/share/x.txt',
    '\\/attacker/share/x',
    '\\??\\UNC\\attacker\\share\\x',
    '\\\\?\\UNC\\attacker\\share\\x',
    '\\\\.\\pipe\\x',
    '\\\\wsl.localhost\\..\\attacker\\share\\x',
    '\\\\wsl$\\Ubuntu\\..\\..\\attacker\\x',
    'x.txt'
  ])
    assert.throws(() => R.cdpParams('DOM.setFileInputFiles', { files: [f], nodeId: 1 }, tab, false), /network path/, f);
  assert.throws(
    () => R.cdpParams('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files: ['\\\\h\\s\\x'] } }, tab, false),
    /network path/
  );
  for (const f of ['C:\\Users\\me\\x.txt', '\\\\wsl.localhost\\Ubuntu\\home\\me\\x.txt', '\\\\wsl$\\Ubuntu\\tmp\\x'])
    assert.deepEqual(R.cdpParams('DOM.setFileInputFiles', { files: [f] }, tab, false), { files: [f] }, f);
});

test('qa_cdp: cookies are scoped to the claimed tab', () => {
  const tab = 'https://app.example.com/page';
  assert.deepEqual(R.cdpParams('Network.getCookies', {}, tab, false), { urls: [tab] });
  assert.deepEqual(
    R.cdpParams('Network.getCookies', { urls: ['https://app.example.com/other'] }, tab, false),
    { urls: ['https://app.example.com/other'] }
  );
  assert.throws(
    () => R.cdpParams('Network.getCookies', { urls: ['https://bank.example.org/'] }, tab, false),
    /limited to the claimed tab/
  );
  assert.deepEqual(R.cdpParams('Network.setCookie', { name: 'a', value: 'b' }, tab, false), {
    name: 'a',
    value: 'b',
    url: tab
  });
  assert.deepEqual(
    R.cdpParams('Network.setCookie', { name: 'a', value: 'b', domain: '.example.com' }, tab, false)
      .domain,
    '.example.com'
  );
  assert.throws(
    () => R.cdpParams('Network.setCookie', { name: 'a', domain: 'bank.example.org' }, tab, false),
    /does not match/
  );
  assert.throws(
    () => R.cdpParams('Network.deleteCookies', { name: 'a', url: 'https://bank.example.org/' }, tab, false),
    /limited to the claimed tab/
  );
  assert.throws(() => R.cdpParams('Network.getCookies', {}, 'about:blank', false), /http\(s\)/);
  assert.throws(() => R.cdpParams('Page.navigate', { url: 'file:///C:/x' }, tab, false), /http\(s\)/);
  // qa_storage with area cookies uses the same rule.
  assert.throws(() => R.tabCookie({ name: 'a', url: 'https://bank.example.org/' }, tab), /limited/);
});

test('policy: format', () => {
  const p = R.readPolicy({ version: 2, allow: ['https://app.example.com', '*.example.org'], strict: false });
  assert.deepEqual(p.allow.map(x => x.text), ['https://app.example.com', '*.example.org']);
  assert.throws(() => R.readPolicy({ version: 1, sensitiveOrigins: [] }), /in place of "sensitiveOrigins"/);
  assert.throws(() => R.readPolicy({ allow: [] }), /version must be 2/);
  assert.throws(
    () => R.readPolicy({ version: 2, allow: ['https://App.example.com/'] }),
    /Write it like https:\/\/app\.example\.com, or \*\.app\.example\.com/
  );
  assert.throws(() => R.readPolicy({ version: 2, allow: ['file:///C:/'] }), /plain http/);
  assert.throws(() => R.readPolicy({ version: 2, allow: ['*.'] }), /not an origin or \*\.site/);
  assert.throws(() => R.readPolicy({ version: 2, allow: ['https://a.example'], extra: 1 }), /unknown field/);
  assert.throws(() => R.readPolicy({ version: 2, block: ['https://a.example'], strict: true }), /strict needs/);
  assert.throws(() => R.readPolicy({ version: 2 }), /give allow, block or both/);
});

test('policy: allow, block and strict', () => {
  const policy = {
    version: 2,
    allow: ['http://localhost:5173', '*.example.com'],
    block: ['https://bank.example.com']
  };
  const check = (tool, url, a) =>
    R.checkPolicy(policy, { tool, sensitive: R.sensitiveCall(tool, a), places: [{ what: 'tab', url }] });
  // *.example.com: the site itself and every subdomain, http or https, any port.
  for (const url of ['https://example.com/', 'http://app.example.com:8080/x', 'https://a.b.example.com/'])
    check('qa_eval', url);
  check('qa_eval', 'http://localhost:5173/?q=1');
  for (const url of ['https://badexample.com/', 'http://localhost:5174/', 'about:blank'])
    assert.throws(() => check('qa_eval', url), /only on listed sites/, url);
  // A block wins over a broader allow, and stops every tool, not only the sensitive ones.
  assert.throws(() => check('qa_click', 'https://bank.example.com/'), /blocks https:\/\/bank\.example\.com/);
  assert.throws(() => check('qa_snapshot', 'https://bank.example.com/'), /blocks/);
  // Without strict, reading and clicking work on any other site.
  check('qa_click', 'https://other.org/');
  check('qa_snapshot', 'https://other.org/');
  // Saving to a file is as sensitive as the tool: a page read or screenshot file works here, an eval file does not.
  check('qa_snapshot', 'https://other.org/', { file: 'a.txt' });
  check('qa_screenshot', 'https://other.org/', { file: 'a.png' });
  assert.throws(() => check('qa_eval', 'https://other.org/', { file: 'a.json' }), /not listed/);
  // One network request and a download start are sensitive.
  assert.throws(() => check('qa_network', 'https://other.org/', { request: 'r1' }), /not listed/);
  check('qa_network', 'https://other.org/', {});
  assert.throws(() => check('qa_downloads', 'https://other.org/', { action: 'start' }), /not listed/);
  // Strict: every tool, and the navigation target, must be on an allowed site.
  const strict = { ...policy, strict: true };
  assert.throws(
    () => R.checkPolicy(strict, { tool: 'qa_click', places: [{ what: 'tab', url: 'https://other.org/' }] }),
    /strict mode/
  );
  assert.throws(
    () =>
      R.checkPolicy(strict, {
        tool: 'qa_navigate',
        places: [{ what: 'navigation target', url: 'https://other.org/' }]
      }),
    /navigation target is on https:\/\/other\.org/
  );
  R.checkPolicy(strict, { tool: 'qa_click', places: [{ what: 'tab', url: 'https://app.example.com/' }] });
  // No policy file: nothing is limited.
  R.checkPolicy(null, { tool: 'qa_eval', sensitive: true, places: [{ what: 'tab', url: 'https://other.org/' }] });
  assert.throws(
    () => R.cdpParams('Page.addScriptToEvaluateOnNewDocument', {}, 'https://app.example.com/', true),
    /policy\.json is active/
  );
  R.cdpParams('Page.addScriptToEvaluateOnNewDocument', {}, 'https://app.example.com/', false);
});

// Two screens as chrome.system.display reports them: a laptop left of a primary monitor.
const SCREENS = [
  {
    name: 'Generic PnP Monitor',
    isPrimary: false,
    bounds: { left: -1600, top: 0, width: 1600, height: 900 },
    workArea: { left: -1600, top: 0, width: 1600, height: 852 }
  },
  {
    name: 'Generic PnP Monitor',
    isPrimary: true,
    bounds: { left: 0, top: 0, width: 2560, height: 1440 },
    workArea: { left: 0, top: 0, width: 2560, height: 1392 }
  }
];

test('window placement: choose a screen', () => {
  assert.equal(R.chooseScreen(SCREENS, 'primary'), SCREENS[1]);
  assert.equal(R.chooseScreen(SCREENS, 'secondary'), SCREENS[0]);
  assert.equal(R.chooseScreen([SCREENS[1]], 'secondary'), SCREENS[1]);
  assert.equal(R.chooseScreen(SCREENS, '2'), SCREENS[1]);
  assert.throws(() => R.chooseScreen(SCREENS, '3'), /matches no screen/);
  assert.throws(() => R.chooseScreen(SCREENS, 'Generic'), /Use primary, secondary or a number/);
});

test('window placement: fill the screen by size', () => {
  assert.deepEqual(R.fillBounds(SCREENS[0], 'maximized'), { left: -1600, top: 0, width: 1600, height: 852 });
  assert.deepEqual(R.fillBounds(SCREENS[0], 'fullscreen'), { left: -1600, top: 0, width: 1600, height: 900 });
  assert.deepEqual(R.fillBounds(SCREENS[1], 'normal'), { left: 0, top: 0, width: 1280, height: 1000 });
});

test('native host: reconnect for good, never faster than 0.5 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(R.reconnectDelay), [500, 1000, 2000, 4000, 8000, 15000, 15000]);
  for (const n of [0, -1, NaN, undefined, 1e9]) {
    const d = R.reconnectDelay(n);
    assert.ok(d >= 500 && d <= 15000, String(n));
  }
});

test('policy: frames left out of page reads', () => {
  const allow = { version: 2, allow: ['https://app.example.com'], block: ['*.bank.example'] };
  assert.equal(R.hiddenFrame(null, 'https://any.example/'), null);
  assert.equal(R.hiddenFrame(allow, 'https://other.example/'), null);
  assert.match(R.hiddenFrame(allow, 'https://www.bank.example/'), /blocks/);
  const strict = { ...allow, strict: true };
  assert.equal(R.hiddenFrame(strict, 'https://app.example.com/x'), null);
  assert.match(R.hiddenFrame(strict, 'https://other.example/'), /strict/);
  assert.match(R.hiddenFrame(strict, 'about:blank'), /strict/);
});

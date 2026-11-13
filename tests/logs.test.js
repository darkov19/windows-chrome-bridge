// Unit tests for extension/logs.js (network and console lists). Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../extension/logs.js');

test('network: secret headers and body fields are hidden unless asked', () => {
  const h = { Authorization: 'Bearer abc', Cookie: 'a=b', 'X-Api-Key': 'k', 'Content-Type': 'text/html' };
  assert.deepEqual(L.headers(h, false), {
    Authorization: '(hidden, 10 characters)',
    Cookie: '(hidden, 3 characters)',
    'X-Api-Key': '(hidden, 1 characters)',
    'Content-Type': 'text/html'
  });
  assert.deepEqual(L.headers(h, true), h);
  const json = L.body('{"user":"ann","password":"pw1","nested":{"access_token":"t"}}', 'application/json', false);
  assert.equal(json.hidden, 2);
  assert.equal(
    json.text,
    '{"user":"ann","password":"(hidden, 3 characters)","nested":{"access_token":"(hidden, 1 characters)"}}'
  );
  const form = L.body('user=ann&pass=pw1', 'application/x-www-form-urlencoded', false);
  assert.equal(form.hidden, 1);
  assert.match(form.text, /^user=ann&pass=%28hidden/);
  assert.equal(L.body('{"password":"x"}', 'application/json', true).text, '{"password":"x"}');
  assert.equal(L.body('<p>password: x</p>', 'text/html', false).hidden, 0);
});

test('network: list with filters and paging', () => {
  const rows = [
    { id: 'r1', page: 1, method: 'GET', url: 'https://a.example/', type: 'Document', status: 200, size: 1500, ms: 12 },
    { id: 'r2', page: 2, method: 'POST', url: 'https://a.example/api/x', type: 'Fetch', status: 500, size: 20, ms: 3.4 },
    { id: 'r3', page: 2, method: 'GET', url: 'https://cdn.example/x.js', type: 'Script', failed: 'net::ERR_FAILED' }
  ];
  const navs = [{ n: 1, url: 'https://a.example/' }, { n: 2, url: 'https://a.example/next' }];
  assert.equal(
    L.requests(rows, { origin: 'https://a.example', pages: navs }),
    [
      '3 requests. Columns: id method status type size time url.',
      '-- page 1: https://a.example/ --',
      'r1 GET 200 document 1.5 kB 12 ms /',
      '-- page 2: https://a.example/next --',
      'r2 POST 500 fetch 20 B 3 ms /api/x',
      'r3 GET FAILED net::ERR_FAILED script - - https://cdn.example/x.js'
    ].join('\n')
  );
  assert.match(L.requests(rows, { failed: true }), /^2 requests match \(of 3\)/);
  assert.match(L.requests(rows, { type: 'fetch' }), /r2 POST/);
  assert.match(L.requests(rows, { limit: 1, offset: 1 }), /^3 requests, 1 shown\. Next: offset=2\./);
});

test('console: level filter, text filter, stacks', () => {
  const rows = [
    { n: 1, page: 1, level: 'info', text: 'ready', url: 'https://a.example/app.js', line: 0, col: 4 },
    { n: 2, page: 1, level: 'error', text: 'Uncaught TypeError: x', url: 'https://a.example/app.js', line: 9, col: 1, stack: ['f https://a.example/app.js:10:2'] },
    { n: 3, page: 1, level: 'warning', text: 'old API' }
  ];
  assert.equal(
    L.consoleList(rows, { level: "error", origin: "https://a.example" }),
    ['1 messages match (of 3).', '-- page 1 --', '#2 [error] Uncaught TypeError: x (/app.js:10:2)', '    at f https://a.example/app.js:10:2'].join('\n')
  );
  assert.match(L.consoleList(rows, { level: 'warning' }), /^2 messages match/);
  assert.match(L.consoleList(rows, { filter: 'READY' }), /#1 \[info\] ready/);
});

test('network: tokens in URLs are hidden unless asked', () => {
  assert.equal(L.hideUrl('https://a.example/cb#access_token=abc.def&expires_in=3600'), 'https://a.example/cb#access_token=(hidden)&expires_in=3600');
  assert.equal(L.hideUrl('https://maps.example/js?key=AIza1&libraries=places'), 'https://maps.example/js?key=(hidden)&libraries=places');
  assert.equal(L.hideUrl('https://ann:pw1@a.example/x?page=2&author=ann'), 'https://ann:(hidden)@a.example/x?page=2&author=ann');
  assert.equal(L.hideUrl('https://a.example/x?q=a+b&sort=name'), 'https://a.example/x?q=a+b&sort=name');
  const rows = [
    { id: 'r1', page: 1, method: 'GET', url: 'https://a.example/api?token=t1&page=1', type: 'Fetch', status: 200 },
    { id: 'r2', page: 1, method: 'GET', url: 'https://a.example/api?token=t2&page=2', type: 'Fetch', status: 200 }
  ];
  const pages = [{ n: 1, url: 'https://a.example/#id_token=t0' }];
  const list = L.requests(rows, { origin: 'https://a.example', pages });
  assert.doesNotMatch(list, /t0|t1|t2/);
  assert.match(list, /page 1: https:\/\/a\.example\/#id_token=\(hidden\)/);
  // The other parameters still tell the requests apart.
  assert.match(list, /r1 GET 200 fetch - - \/api\?token=\(hidden\)&page=1\nr2 .*&page=2$/);
  assert.match(L.requests(rows, { show: true }), /token=t1/);
  assert.deepEqual(L.headers({ Referer: 'https://a.example/?code=c1', ':path': '/x?sig=s1' }, false), {
    Referer: 'https://a.example/?code=(hidden)',
    ':path': '/x?sig=(hidden)'
  });
  assert.match(L.consoleList([{ n: 1, page: 1, level: 'info', text: 'x', url: 'https://a.example/a.js?key=k1', line: 0, col: 0 }]), /a\.js\?key=\(hidden\)/);
});

test('a filter that matches nothing says what the list holds', () => {
  const messages = [
    { n: 1, page: 1, level: 'info', text: 'a' },
    { n: 2, page: 1, level: 'warning', text: 'b' },
    { n: 3, page: 1, level: 'info', text: 'c' }
  ];
  assert.equal(L.consoleList(messages, { level: 'error' }), '0 messages match (of 3). By level: 2 info, 1 warning.');
  const rows = [
    { id: 'r1', page: 1, method: 'GET', url: 'https://a.example/', type: 'Document', status: 200 },
    { id: 'r2', page: 1, method: 'GET', url: 'https://a.example/x.js', type: 'Script', status: 404 }
  ];
  assert.equal(L.requests(rows, { type: 'fetch' }), '0 requests match (of 2). By type: 1 document, 1 script; 1 failed.');
  assert.equal(L.consoleList([], { level: 'error' }), '0 messages.');
});

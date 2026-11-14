// Unit tests for extension/tree.js (page reads and their changes). Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../extension/tree.js');

// A small page in the shape of Accessibility.getFullAXTree.
let next = 1;
function node(role, name, o = {}) {
  const n = {
    nodeId: String(next),
    backendDOMNodeId: next++,
    role: { value: role },
    ...(name !== undefined ? { name: { value: name } } : {}),
    ...o
  };
  n.kids = o.kids || [];
  return n;
}
function page(root) {
  const out = [];
  (function walk(n, parent) {
    const { kids, ...rest } = n;
    out.push({ ...rest, parentId: parent, childIds: kids.map(k => k.nodeId) });
    kids.forEach(k => walk(k, n.nodeId));
  })(root);
  return out;
}
const noRefs = text => text.replace(/ \[e\d+\]/g, '');
const refOf = (lines, start) => /\[(e\d+)\]/.exec(lines.find(l => l.text.startsWith(start)).text)[1];
const read = (nodes, o = {}) =>
  T.lines(T.build(nodes, { refOf: b => 'e' + b, origin: 'https://app.example.com', ...o }));
function form(status = 'Not sent', extra = []) {
  next = 1;
  const pw = node('textbox', 'Password', { value: { value: 'Secret-1' } });
  const nodes = page(
    node('RootWebArea', 'App', {
      kids: [
        node('heading', 'Contact', {
          properties: [{ name: 'level', value: { value: 1 } }],
          kids: [node('StaticText', 'Contact')]
        }),
        node('link', 'Help', { properties: [{ name: 'url', value: { value: 'https://app.example.com/help' } }] }),
        node('generic', '', {
          kids: [
            node('LabelText', '', { kids: [node('StaticText', 'Name '), node('textbox', 'Name', { value: { value: 'Ann' } })] }),
            pw,
            node('checkbox', 'I agree', { properties: [{ name: 'checked', value: { value: 'true' } }] }),
            node('combobox', 'Topic', {
              value: { value: 'Bug' },
              kids: [node('MenuListPopup', '', { kids: [node('option', 'Question'), node('option', 'Bug')] })]
            }),
            node('button', 'Send', { properties: [{ name: 'disabled', value: { value: true } }], kids: [node('StaticText', 'Send')] })
          ]
        }),
        node('status', '', { kids: [node('StaticText', status)] }),
        ...extra
      ]
    })
  );
  return { nodes, secret: new Set([pw.backendDOMNodeId]) };
}

test('page read: roles, names, states, values and refs', () => {
  const { nodes, secret } = form();
  const lines = read(nodes, { secret });
  assert.ok(lines.every(l => /\[e\d+\]/.test(l.text)), 'every element has a ref');
  assert.equal(
    noRefs(T.view(lines).text),
    [
      '- heading "Contact" [level=1]',
      '- link "Help" -> /help',
      '- textbox "Name": Ann',
      '- textbox "Password": (hidden)',
      '- checkbox "I agree" [checked]',
      '- combobox "Topic": Bug (options: "Question", "Bug")',
      '- button "Send" [disabled]',
      '- status: Not sent'
    ].join('\n')
  );
  // A value Chrome shows as dots is hidden even without the password check.
  next = 1;
  const dots = page(node('RootWebArea', '', { kids: [node('textbox', 'PIN', { value: { value: '••••' } })] }));
  assert.equal(noRefs(T.view(read(dots)).text), '- textbox "PIN": (hidden)');
});

test('page read: tokens in link URLs are hidden', () => {
  next = 1;
  const L = require('../extension/logs.js');
  const nodes = page(
    node('RootWebArea', 'App', {
      kids: [node('link', 'Reset', { properties: [{ name: 'url', value: { value: 'https://app.example.com/reset?token=abc123&lang=en' } }] })]
    })
  );
  assert.equal(read(nodes, { hideUrl: L.hideUrl })[0].text, 'link "Reset" [e1] -> /reset?token=(hidden)&lang=en');
});

test('page read: password fields are marked, nameless fields get an attribute', () => {
  next = 1;
  const user = node('textbox'),
    pw = node('textbox'),
    named = node('textbox', 'PIN', { value: { value: '••••' } }),
    box = node('checkbox', '', { properties: [] });
  const nodes = page(node('RootWebArea', 'Login', { kids: [user, pw, named, box] }));
  const fields = new Map([
    [user.backendDOMNodeId, { id: 'user', name: 'login' }],
    [pw.backendDOMNodeId, { password: true, name: 'pw' }],
    [named.backendDOMNodeId, { password: true, id: 'pin' }],
    [box.backendDOMNodeId, { placeholder: ' ', name: 'agree to "terms"' }]
  ]);
  assert.deepEqual(noRefs(read(nodes, { fields, secret: new Set([named.backendDOMNodeId]) }).map(l => l.text).join('\n')), [
    'textbox [id="user"]',
    'textbox [password] [name="pw"]',
    'textbox "PIN" [password]: (hidden)',
    'checkbox [name="agree to \\"terms\\""]'
  ].join('\n'));
});

test('page read: views', () => {
  const { nodes, secret } = form();
  const lines = read(nodes, { secret });
  assert.deepEqual(
    noRefs(T.view(lines, { interactive: true }).text).split('\n').map(l => l.split(' [')[0].split(':')[0]),
    ['- link "Help" -> /help', '- textbox "Name"', '- textbox "Password"', '- checkbox "I agree"', '- combobox "Topic"', '- button "Send"']
  );
  const status = refOf(lines, 'status');
  assert.equal(T.view(lines, { root: status }).text, '- status [' + status + ']: Not sent');
  assert.ok(T.view(lines, { root: 'e99' }).missing);
  const found = T.view(lines, { search: 'agree' });
  assert.equal(found.matches, 1);
  assert.match(found.text, /1 matches for "agree":\n- checkbox "I agree"/);
  assert.match(T.view(lines, { maxChars: 60 }).text, /\[Cut at 60 characters: 1 of 8 lines shown/);
});

test('page read: names cannot fake a ref or an end of the name', () => {
  // The list keeps its ref (e2) in both reads; the new link inside it is named like a ref.
  next = 2;
  const before = read(page(node('RootWebArea', '', { kids: [node('list', 'Items')] })));
  next = 1;
  const after = read(page(node('RootWebArea', '', {
    kids: [node('list', 'Items', { kids: [node('link', 'x [e99]')] }), node('main', 'a\\" b\\')]
  })));
  const text = T.diff(before, after).text;
  assert.match(text, /\+ - link "x \[e99\]" \[e1\]  \(in e2\)/);
  assert.ok(text.includes('+ - main "a\\\\\\" b\\\\" [e3]'), text);
});

test('page read: changes since the last read', () => {
  const before = read(form().nodes);
  const after = read(form('Thanks, Ann', [node('alert', 'Saved')]).nodes);
  assert.equal(
    noRefs(T.diff(before, after).text),
    [
      'Changes since the last read: 1 changed (~), 1 added (+), 0 removed (x).',
      '~ - status: Thanks, Ann',
      '+ - alert "Saved"'
    ].join('\n')
  );
  assert.equal(T.diff(after, after).text, 'No changes since the last read.');
  assert.match(noRefs(T.diff(after, before).text), /x - alert "Saved"/);
  // When most of the page changed, a full read is better.
  next = 100;
  const other = read(page(node('RootWebArea', '', { kids: Array.from({ length: 30 }, (_, i) => node('button', 'B' + i)) })));
  assert.equal(T.diff(before, other), null);
});

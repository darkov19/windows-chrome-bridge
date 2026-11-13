'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../extension/perf.js');

test('perf: CLS is the worst session window and leaves out shifts after input', () => {
  const shifts = [
    { t: 100, v: 0.05 },
    { t: 600, v: 0.05 },
    { t: 3000, v: 0.2 },
    { t: 3500, v: 0.5, input: true }
  ];
  assert.strictEqual(P.cls(shifts), 0.2);
  // Shifts less than 1 s apart, in at most 5 s, add up.
  assert.strictEqual(P.cls([{ t: 0, v: 0.1 }, { t: 900, v: 0.1 }, { t: 1800, v: 0.1 }]), 0.3);
});

test('perf: INP is the longest interaction, one left out per 50', () => {
  assert.deepStrictEqual(P.inp([]), { ms: null, interactions: 0 });
  const one = P.inp([{ id: 1, name: 'pointerdown', d: 120 }, { id: 1, name: 'click', d: 312, target: 'button#work' }]);
  assert.strictEqual(one.ms, 312);
  assert.strictEqual(one.interactions, 1);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: 'click', d: i === 0 ? 900 : 150 }));
  assert.strictEqual(P.inp(many).ms, 150);
  assert.strictEqual(P.rate('inp', 312), 'needs improvement');
  assert.strictEqual(P.rate('cls', 0.3), 'poor');
});

test('perf: a leak is growth in almost every repeat', () => {
  const s = (nodes, heap, listeners = 3) => ({ nodes, heapUsedBytes: heap, listeners, documents: 1 });
  const leaking = P.leak([s(400, 1e6), s(801, 1.01e6), s(1202, 1.02e6), s(1603, 1.03e6)]);
  assert.strictEqual(leaking.likelyLeak, true);
  assert.deepStrictEqual(leaking.growing, ['nodes']);
  assert.strictEqual(leaking.perRepeat.nodes, 401);
  // Heap noise and one-time growth are not a leak.
  const flat = P.leak([s(400, 1e6), s(900, 1.004e6), s(900, 1.002e6), s(900, 1.006e6)]);
  assert.strictEqual(flat.likelyLeak, false);
});

test('perf: metrics hide secret values in the page, LCP and resource URLs', () => {
  const hide = u => u.replace(/token=[^&]+/, 'token=(hidden)');
  const raw = {
    url: 'https://a.test/?token=abc',
    nav: {},
    lcp: { t: 10, element: 'img', url: 'https://a.test/hero.png?token=abc' },
    shifts: [],
    events: [],
    resources: [{ d: 5, type: 'img', url: 'https://a.test/x.png?token=abc', size: 1 }]
  };
  const out = P.summary(raw, 5, hide);
  assert.ok(!JSON.stringify(out).includes('abc'));
  assert.strictEqual(out.slowestResources[0].url, 'https://a.test/x.png?token=(hidden)');
});

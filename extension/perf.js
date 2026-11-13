'use strict';
// Speed and memory numbers for qa_perf, without browser calls, so they can be unit tested.
(function (root) {
  // Core Web Vitals and load thresholds (web.dev): [good up to, poor above].
  const LIMITS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500], fcp: [1800, 3000], ttfb: [800, 1800] };

  function rate(metric, value) {
    if (value === null || value === undefined) return null;
    const [good, poor] = LIMITS[metric];
    return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor';
  }

  const ms = v => (v === null || v === undefined || !(v > 0) ? null : Math.round(v));
  const kb = v => (v > 0 ? Math.round(v / 102.4) / 10 : 0);

  // CLS: the largest sum of layout shifts in one session window (shifts less than 1 s apart, at
  // most 5 s long). Shifts right after user input do not count.
  function cls(shifts) {
    let best = 0,
      sum = 0,
      first = null,
      last = null;
    for (const s of shifts.filter(x => !x.input).sort((a, b) => a.t - b.t)) {
      if (first !== null && s.t - last < 1000 && s.t - first < 5000) sum += s.v;
      else {
        sum = s.v;
        first = s.t;
      }
      last = s.t;
      best = Math.max(best, sum);
    }
    return Math.round(best * 1000) / 1000;
  }

  // INP: the longest interaction, or with 50 or more interactions, one of the longest
  // (one is left out for every 50). An interaction lasts as long as its longest event.
  function inp(events) {
    const by = new Map();
    for (const e of events) {
      const prev = by.get(e.id);
      if (!prev || e.d > prev.d) by.set(e.id, e);
    }
    const list = [...by.values()].sort((a, b) => b.d - a.d);
    if (!list.length) return { ms: null, interactions: 0 };
    const pick = list[Math.min(list.length - 1, Math.floor(list.length / 50))];
    return { ms: Math.round(pick.d), interactions: list.length, slowest: { event: list[0].name, target: list[0].target, ms: Math.round(list[0].d) } };
  }

  // raw: what the page script in background.js returns. limit: how many slow resources to list.
  // hide(url): hides secret values (tokens, keys) in a URL, as in qa_network.
  function summary(raw, limit = 5, hide = u => u) {
    const n = raw.nav || {};
    const out = {
      url: hide(raw.url),
      load: {
        type: n.type || null,
        ttfbMs: ms(n.ttfb),
        ttfbRating: rate('ttfb', ms(n.ttfb)),
        fcpMs: ms(raw.fcp),
        fcpRating: rate('fcp', ms(raw.fcp)),
        domContentLoadedMs: ms(n.dcl),
        loadMs: ms(n.load),
        transferKB: kb(n.transfer)
      }
    };
    out.lcp = raw.lcp
      ? { ms: ms(raw.lcp.t), rating: rate('lcp', ms(raw.lcp.t)), element: raw.lcp.element, url: raw.lcp.url ? hide(raw.lcp.url) : undefined }
      : { ms: null, note: 'No largest contentful paint yet' };
    const c = cls(raw.shifts);
    out.cls = { value: c, rating: rate('cls', c), shifts: raw.shifts.filter(x => !x.input).length };
    const i = inp(raw.events);
    out.inp = { ...i, rating: rate('inp', i.ms) };
    if (i.ms === null)
      out.inp.note =
        'No interaction of 104 ms or more. Chrome keeps only those, so the INP is under 104 ms (good) or there was no click, tap or key press';
    const long = raw.longTasks || [];
    out.longTasks = {
      count: long.length,
      totalMs: Math.round(long.reduce((a, b) => a + b, 0)),
      blockingMs: Math.round(long.reduce((a, b) => a + Math.max(0, b - 50), 0))
    };
    out.slowestResources = raw.resources
      .slice()
      .sort((a, b) => b.d - a.d)
      .slice(0, limit)
      .map(r => ({ ms: Math.round(r.d), type: r.type, url: hide(r.url), kb: kb(r.size), ...(r.blocking ? { renderBlocking: true } : {}) }));
    out.resources = raw.resources.length;
    return out;
  }

  // samples: memory readings ({heapUsedBytes, nodes, listeners, documents}), the first before the
  // repeats and one after each repeat. A leak shows as growth in (almost) every repeat.
  function leak(samples) {
    const repeat = samples.length - 1;
    const keys = { heapUsedBytes: 102400, nodes: 1, listeners: 1, documents: 1 };
    const growth = {},
      perRepeat = {},
      grows = [];
    for (const [k, threshold] of Object.entries(keys)) {
      const series = samples.map(s => s[k]);
      if (series.some(v => typeof v !== 'number')) continue;
      growth[k] = series[repeat] - series[0];
      perRepeat[k] = Math.round((growth[k] / repeat) * 10) / 10;
      const ups = series.slice(1).filter((v, i) => v > series[i]).length;
      if (perRepeat[k] >= threshold && ups >= Math.ceil(repeat * 0.8)) grows.push(k);
    }
    return { repeat, growth, perRepeat, likelyLeak: grows.length > 0, growing: grows };
  }

  const QaPerf = { rate, cls, inp, summary, leak };
  if (typeof module !== 'undefined' && module.exports) module.exports = QaPerf;
  else root.QaPerf = QaPerf;
})(typeof self !== 'undefined' ? self : globalThis);

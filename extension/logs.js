'use strict';
// Network and console lists: filters, paging, text output, and hiding of secrets.
// Pure code with no browser calls; tests/logs.test.js runs it in node.
(function (root) {
  // Header values that are hidden unless the agent asks with showSecrets.
  const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|passw|session|api[-_]?key|auth|csrf|xsrf/i;
  // JSON and form fields whose values are hidden in request and response bodies.
  const SECRET_FIELD = /pass|secret|token|api[-_]?key|auth|session|credential|cookie/i;
  // Query and fragment parameters whose values are hidden in URLs: ?token=, ?key=, #access_token=, ?sig=...
  const SECRET_PARAM = /pass|secret|token|api[-_]?key|auth(?!or)|session|credential|cookie|^key$|[-_]key$|^sig$|signature|^jwt$|^code$/i;
  // Headers that hold a URL: their secret parameters are hidden like those of the request URL.
  const URL_HEADER = /^(referer|location|content-location|:path)$/i;
  const LEVELS = ['error', 'warning', 'info', 'debug'];

  const hidden = v => '(hidden, ' + String(v).length + ' characters)';

  const decode = s => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };

  // The URL with the values of secret query and fragment parameters, and a password in it, replaced
  // by (hidden). Everything else stays as it is, so requests can still be told apart.
  function hideUrl(raw) {
    if (typeof raw !== 'string') return raw;
    let s = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@]*?:)[^/?#@]+@/i, '$1(hidden)@');
    const at = s.search(/[?#]/);
    if (at < 0) return s;
    return (
      s.slice(0, at) +
      s.slice(at).replace(/([?&#])([^=&#?]+)=([^&#]*)/g, (all, sep, name, value) =>
        value && SECRET_PARAM.test(decode(name)) ? sep + name + '=(hidden)' : all
      )
    );
  }

  function headers(h, show) {
    const out = {};
    for (const [k, v] of Object.entries(h || {}))
      out[k] = show ? v : SECRET_HEADER.test(k) ? hidden(v) : URL_HEADER.test(k) ? hideUrl(v) : v;
    return out;
  }

  // Returns {text, hidden: number of values hidden}.
  function body(text, mimeType, show) {
    if (show || typeof text !== 'string' || !text) return { text, hidden: 0 };
    let count = 0;
    const walk = v => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) {
          if (SECRET_FIELD.test(k) && (typeof x === 'string' || typeof x === 'number')) {
            count++;
            o[k] = hidden(x);
          } else o[k] = walk(x);
        }
        return o;
      }
      return v;
    };
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const out = JSON.stringify(walk(JSON.parse(t)));
        return { text: count ? out : text, hidden: count };
      } catch {}
    }
    if (/x-www-form-urlencoded/i.test(mimeType || '') || /^[\w.%-]+=[^&\s]*(&[\w.%-]+=[^&\s]*)*$/.test(t)) {
      const params = new URLSearchParams(t);
      for (const [k, v] of [...params]) {
        if (SECRET_FIELD.test(k)) {
          count++;
          params.set(k, hidden(v));
        }
      }
      return { text: count ? params.toString() : text, hidden: count };
    }
    return { text, hidden: 0 };
  }

  function size(n) {
    if (n === undefined || n === null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // show: true keeps secret URL parameters (qa_network showSecrets).
  function shortUrl(raw, origin, show) {
    let s = show ? raw || '' : hideUrl(raw || '');
    if (origin && (s === origin || s.startsWith(origin + '/'))) s = s.slice(origin.length) || '/';
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }

  // "3 info, 1 warning": how many items of the list have each key, most first.
  function counts(list, keyOf) {
    const n = new Map();
    for (const x of list) n.set(keyOf(x), (n.get(keyOf(x)) || 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([k, c]) => c + ' ' + k).join(', ');
  }

  function page(list, offset = 0, limit = 50) {
    const shown = list.slice(offset, offset + limit);
    const rest = list.length - offset - shown.length;
    return { shown, more: rest > 0 ? ' Next: offset=' + (offset + shown.length) + '.' : '' };
  }

  // One line per request. r: {id, page, method, url, type, status, failed, size, ms}.
  function requestLine(r, origin, show) {
    const status = r.failed ? 'FAILED ' + r.failed : r.status === undefined ? 'pending' : String(r.status);
    return [
      r.id,
      r.method,
      status,
      (r.type || 'other').toLowerCase(),
      size(r.size),
      r.ms === undefined ? '-' : Math.round(r.ms) + ' ms',
      shortUrl(r.url, origin, show)
    ].join(' ');
  }

  // o: {filter, type, failed, offset, limit, origin, pages: [{n, url}], show}.
  function requests(list, o = {}) {
    let rows = list;
    if (o.filter) rows = rows.filter(r => r.url.toLowerCase().includes(o.filter.toLowerCase()));
    if (o.type) rows = rows.filter(r => (r.type || 'other').toLowerCase() === o.type.toLowerCase());
    if (o.failed) rows = rows.filter(r => r.failed || r.status >= 400);
    const { shown, more } = page(rows, o.offset, o.limit);
    const out = [
      rows.length + ' requests' + (rows.length !== list.length ? ' match (of ' + list.length + ')' : '') +
        (shown.length < rows.length ? ', ' + shown.length + ' shown.' : '.') + more +
        // Nothing matched: say what the list holds, so the next filter can be right.
        (!rows.length && list.length
          ? ' By type: ' + counts(list, r => (r.type || 'other').toLowerCase()) + '; ' +
            list.filter(r => r.failed || r.status >= 400).length + ' failed.'
          : ' Columns: id method status type size time url.')
    ];
    let nav;
    for (const r of shown) {
      if (r.page !== nav) {
        nav = r.page;
        const n = (o.pages || []).find(x => x.n === nav);
        out.push('-- page ' + nav + (n && n.url ? ': ' + shortUrl(n.url, null, o.show) : '') + ' --');
      }
      out.push(requestLine(r, o.origin, o.show));
    }
    return out.join('\n');
  }

  function levelOf(type) {
    if (type === 'error' || type === 'assert') return 'error';
    if (type === 'warning' || type === 'warn') return 'warning';
    if (type === 'debug' || type === 'verbose') return 'debug';
    return 'info';
  }

  // A page can print line breaks. Every further line of one message starts with "    | ", so the text
  // cannot look like another message, a stack line or a page line.
  const moreLines = s => String(s).replace(/\r\n|[\r\n\u2028\u2029]/g, '\n    | ');

  // o: {level, filter, offset, limit, pages}. m: {n, page, level, text, url, line, col, stack}.
  function consoleList(list, o = {}) {
    let rows = list;
    if (o.level) {
      const max = LEVELS.indexOf(o.level);
      rows = rows.filter(m => LEVELS.indexOf(m.level) <= max);
    }
    if (o.filter) rows = rows.filter(m => m.text.toLowerCase().includes(o.filter.toLowerCase()));
    const { shown, more } = page(rows, o.offset, o.limit);
    const out = [
      rows.length + ' messages' + (rows.length !== list.length ? ' match (of ' + list.length + ')' : '') +
        (shown.length < rows.length ? ', ' + shown.length + ' shown.' : '.') + more +
        (!rows.length && list.length ? ' By level: ' + counts(list, m => m.level) + '.' : '')
    ];
    let nav;
    for (const m of shown) {
      if (m.page !== nav) {
        nav = m.page;
        const n = (o.pages || []).find(x => x.n === nav);
        out.push('-- page ' + nav + (n && n.url ? ': ' + shortUrl(n.url, null) : '') + ' --');
      }
      const where = m.url ? ' (' + shortUrl(m.url, o.origin) + ':' + (m.line + 1) + ':' + (m.col + 1) + ')' : '';
      out.push('#' + m.n + ' [' + m.level + '] ' + moreLines(m.text) + where);
      for (const s of m.stack || []) out.push('    at ' + moreLines(s));
    }
    return out.join('\n');
  }

  // Short stack lines from a CDP StackTrace.
  function stack(trace, origin, max = 8) {
    if (!trace || !trace.callFrames) return [];
    return trace.callFrames
      .slice(0, max)
      .map(f => (f.functionName || '(anonymous)') + ' ' + shortUrl(f.url, origin) + ':' + (f.lineNumber + 1) + ':' + (f.columnNumber + 1));
  }

  const QaLogs = { headers, body, hideUrl, requests, consoleList, levelOf, stack, size, shortUrl, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = QaLogs;
  else root.QaLogs = QaLogs;
})(typeof self !== 'undefined' ? self : globalThis);

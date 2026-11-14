'use strict';
// Page reads: turn a CDP accessibility tree (Accessibility.getFullAXTree) into short text lines
// with refs, and compare two reads. Pure code with no browser calls, so tests/tree.test.js can
// run it in node. background.js loads it with importScripts().
(function (root) {
  // Never shown, with their children.
  const SKIP = new Set(['InlineTextBox', 'LineBreak', 'MenuListPopup', 'ListMarker']);
  // Shown only when they have a name. Otherwise their children move up one level.
  const GROUPS = new Set([
    'generic',
    'none',
    'presentation',
    'LabelText',
    'paragraph',
    'Section',
    'group',
    'Canvas',
    'Abbr',
    'DescriptionList',
    'ruby',
    'time',
    'emphasis',
    'strong',
    'subscript',
    'superscript',
    'mark',
    'code',
    'deletion',
    'insertion'
  ]);
  // Their value is shown; their own children (the inner editor) are not.
  const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  // Form fields: their element attributes can mark them (password) or tell them apart (no name).
  const FIELD_ROLES = new Set([...FIELDS, 'checkbox', 'radio', 'switch']);
  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'listbox',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'slider',
    'spinbutton',
    'treeitem',
    'Iframe'
  ]);
  const MAX_OPTIONS = 20;

  const norm = s => String(s == null ? '' : s).replace(/\s+/gu, ' ').trim();
  const quote = s => '"' + s.replace(/[\\"]/g, '\\$&') + '"';
  const prop = (n, name) => {
    const p = (n.properties || []).find(x => x.name === name);
    return p && p.value ? p.value.value : undefined;
  };

  function states(n) {
    const out = [];
    const checked = prop(n, 'checked');
    if (checked === 'true' || checked === true) out.push('checked');
    if (checked === 'mixed') out.push('checked=mixed');
    const pressed = prop(n, 'pressed');
    if (pressed === 'true' || pressed === true) out.push('pressed');
    if (pressed === 'mixed') out.push('pressed=mixed');
    if (prop(n, 'selected') === true && n.role.value !== 'option') out.push('selected');
    const expanded = prop(n, 'expanded');
    if (expanded === true) out.push('expanded');
    if (expanded === false) out.push('collapsed');
    for (const flag of ['disabled', 'focused', 'required', 'readonly', 'modal'])
      if (prop(n, flag) === true) out.push(flag);
    const invalid = prop(n, 'invalid');
    if (invalid !== undefined && invalid !== 'false' && invalid !== false) out.push('invalid');
    const level = prop(n, 'level');
    if (level !== undefined && n.role.value === 'heading') out.push('level=' + level);
    return out;
  }

  function shortUrl(raw, origin) {
    if (!raw || typeof raw !== 'string') return '';
    if (origin && raw.startsWith(origin + '/')) return raw.slice(origin.length);
    return raw;
  }

  // nodes: the AX nodes of one frame. o: {
  //   refOf(backendDOMNodeId) -> ref string,
  //   secret: Set of backendDOMNodeIds whose value must not be shown (password fields),
  //   fields: Map backendDOMNodeId -> {password, id, name, placeholder} of form field elements,
  //   frames: Map backendDOMNodeId of an iframe element -> {alias, items} of its document,
  //   origin: the page origin, to shorten link URLs,
  //   hideUrl(url) -> the url with secret parameters (tokens, keys) hidden }
  // Returns items: {node: {role, name, ref, states, value, url, options, frame}, children} or {text}.
  function build(nodes, o) {
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const top = nodes.find(n => !n.parentId || !byId.has(n.parentId)) || nodes[0];
    if (!top) return [];
    const seen = new Set();

    function visit(n) {
      if (!n || seen.has(n.nodeId)) return [];
      seen.add(n.nodeId);
      const role = n.role ? n.role.value : '';
      if (SKIP.has(role)) return [];
      const kids = () => mergeText((n.childIds || []).flatMap(c => visit(byId.get(c))));
      if (n.ignored) return kids();
      if (role === 'StaticText') {
        const text = norm(n.name && n.name.value);
        return text ? [{ text }] : [];
      }
      if (role === 'RootWebArea') return kids();
      const name = norm(n.name && n.name.value);
      if (GROUPS.has(role) && !name) return kids();
      const bid = n.backendDOMNodeId;
      const item = {
        node: {
          role,
          name,
          ref: bid !== undefined && o.refOf ? o.refOf(bid) : '',
          states: states(n)
        },
        children: []
      };
      if (FIELD_ROLES.has(role)) {
        const f = o.fields && o.fields.get(bid);
        if (f && f.password) item.node.states.push('password');
        // A field with no name: its id, name or placeholder attribute, written as a CSS selector.
        if (f && !name) {
          const [attr, v] = [['id', f.id], ['name', f.name], ['placeholder', f.placeholder]].find(([, x]) => norm(x)) || [];
          if (attr) item.node.hint = '[' + attr + '=' + quote(norm(v).slice(0, 100)) + ']';
        }
        let value = norm(n.value && n.value.value);
        if (value && ((o.secret && o.secret.has(bid)) || /^[•●*]+$/u.test(value))) value = '(hidden)';
        if (value && value !== name) item.node.value = value;
        if (role === 'combobox') {
          const popup = (n.childIds || []).map(c => byId.get(c)).find(c => c && c.role && c.role.value === 'MenuListPopup');
          if (popup) {
            const names = (popup.childIds || [])
              .map(c => byId.get(c))
              .filter(c => c && c.role && c.role.value === 'option')
              .map(c => norm(c.name && c.name.value));
            if (names.length) item.node.options = names;
          }
        }
        return [item];
      }
      if (role === 'link') item.node.url = shortUrl(o.hideUrl ? o.hideUrl(prop(n, 'url')) : prop(n, 'url'), o.origin);
      if ((role === 'Iframe' || role === 'IframePresentational') && o.frames && o.frames.has(bid)) {
        const f = o.frames.get(bid);
        item.node.frame = f.alias;
        item.children = f.items;
        return [item];
      }
      item.children = kids();
      // A button "Send" with the text "Send" inside: the text adds nothing.
      if (item.children.length === 1 && item.children[0].text === name) item.children = [];
      return [item];
    }

    return visit(top);
  }

  // Join neighbouring text items ("Name " and "Email" can be separate StaticText nodes), and drop
  // a text that only repeats the name of an element next to it (a label and its field).
  function mergeText(items) {
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (it.text !== undefined && last && last.text !== undefined) last.text = norm(last.text + ' ' + it.text);
      else out.push(it);
    }
    const names = new Set(out.filter(it => it.node && it.node.name).map(it => it.node.name));
    return out.filter(it => it.text === undefined || !names.has(it.text));
  }

  // Chrome's own role names start with a capital (Iframe, DescriptionListTerm).
  const roleName = r => (r === 'IframePresentational' ? 'iframe' : r.charAt(0).toLowerCase() + r.slice(1));

  function nodeText(nd) {
    let s = roleName(nd.role);
    if (nd.name) s += ' ' + quote(nd.name.slice(0, 300));
    if (nd.ref) s += ' [' + nd.ref + ']';
    for (const st of nd.states) s += ' [' + st + ']';
    if (nd.hint) s += ' ' + nd.hint;
    if (nd.frame) s += ' [frame ' + nd.frame + ']';
    if (nd.url) s += ' -> ' + nd.url.slice(0, 200);
    if (nd.value !== undefined) s += ': ' + nd.value.slice(0, 300);
    if (nd.options) {
      const shown = nd.options.slice(0, MAX_OPTIONS).map(quote).join(', ');
      const more = nd.options.length > MAX_OPTIONS ? ', +' + (nd.options.length - MAX_OPTIONS) + ' more' : '';
      s += ' (options: ' + shown + more + ')';
    }
    return s;
  }

  // Items -> lines {depth, text, key, parent, interactive}. key is the ref, or a key built from
  // the parent for text lines; diffs match lines by key.
  function lines(items) {
    const out = [];
    function walk(list, depth, parentKey, parentIndex) {
      let textIndex = 0;
      for (const it of list) {
        if (it.text !== undefined) {
          out.push({
            depth,
            text: 'text: ' + it.text,
            key: parentKey + '>t' + textIndex++,
            parent: parentIndex,
            interactive: false
          });
          continue;
        }
        const nd = it.node;
        let text = nodeText(nd);
        let children = it.children;
        // One text child: put it on the same line.
        if (children.length === 1 && children[0].text !== undefined && nd.value === undefined) {
          text += ': ' + children[0].text;
          children = [];
        }
        const index = out.length;
        const key = nd.ref || parentKey + '>' + nd.role + out.length;
        out.push({ depth, text, key, parent: parentIndex, interactive: INTERACTIVE.has(nd.role) });
        walk(children, depth + 1, key, index);
      }
    }
    walk(items, 0, '', -1);
    return out;
  }

  const lineText = l => '  '.repeat(l.depth) + '- ' + l.text;

  // The text of one read. o: {interactive, depth, root (a key), search, maxChars}.
  // Returns {text, cut, matches}.
  function view(all, o = {}) {
    let list = all;
    if (o.root !== undefined) {
      const start = all.findIndex(l => l.key === o.root);
      if (start < 0) return { text: '', missing: true };
      let end = start + 1;
      while (end < all.length && all[end].depth > all[start].depth) end++;
      const base = all[start].depth;
      list = all.slice(start, end).map(l => ({ ...l, depth: l.depth - base }));
    }
    if (o.search !== undefined) return search(list, o.search, o.maxChars);
    if (o.interactive) list = list.filter(l => l.interactive).map(l => ({ ...l, depth: 0 }));
    const out = [];
    let hidden = 0;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (o.depth !== undefined && l.depth >= o.depth) {
        hidden++;
        continue;
      }
      let more = 0;
      if (o.depth !== undefined && l.depth === o.depth - 1)
        for (let j = i + 1; j < list.length && list[j].depth > l.depth; j++) more++;
      out.push(lineText(l) + (more ? ' (+' + more + ' inside)' : ''));
    }
    return limit(out, o.maxChars, hidden ? ' Raise depth to see the ' + hidden + ' lines below it.' : '');
  }

  function limit(out, maxChars, note = '') {
    let size = 0,
      n = 0;
    for (; n < out.length; n++) {
      size += out[n].length + 1;
      if (maxChars && size > maxChars) break;
    }
    const cut = n < out.length;
    let text = out.slice(0, n).join('\n');
    if (cut)
      text +=
        '\n[Cut at ' + maxChars + ' characters: ' + n + ' of ' + out.length + ' lines shown. ' +
        'Read less with ref, depth, interactive or search, or save it with file.]';
    else if (note) text += '\n[' + note.trim() + ']';
    return { text, cut };
  }

  // Lines that contain the text (any case), each with up to two parent lines for context.
  function search(list, query, maxChars) {
    const q = norm(query).toLowerCase();
    if (!q) throw Error('search must not be empty');
    const byIndex = new Map(list.map((l, i) => [l, i]));
    const index = new Map(list.map((l, i) => [i, l]));
    const parentOf = l => {
      // Parent indexes point into the full list; find the line by walking up depths instead.
      const i = byIndex.get(l);
      for (let j = i - 1; j >= 0; j--) if (index.get(j).depth < l.depth) return index.get(j);
      return null;
    };
    const keep = new Set();
    let matches = 0;
    for (const l of list) {
      if (!l.text.toLowerCase().includes(q)) continue;
      matches++;
      if (matches > 50) break;
      keep.add(l);
      let p = l;
      for (let k = 0; k < 2 && (p = parentOf(p)); k++) keep.add(p);
    }
    const out = list.filter(l => keep.has(l)).map(lineText);
    const head = matches
      ? (matches > 50 ? 'More than 50' : String(matches)) + ' matches for ' + quote(query) + ':'
      : 'No line contains ' + quote(query) + '.';
    const r = limit([head, ...out], maxChars);
    r.matches = Math.min(matches, 50);
    return r;
  }

  // What changed between two reads of the same page. Returns null when the change is so big that
  // the full read is shorter or clearer.
  function diff(before, after, maxChars) {
    const old = new Map(before.map(l => [l.key, l]));
    const now = new Set(after.map(l => l.key));
    const out = [];
    let added = 0,
      changed = 0,
      removed = 0;
    const addedKeys = new Set();
    for (const l of after) {
      const was = old.get(l.key);
      if (!was) {
        added++;
        addedKeys.add(l.key);
        const parent = l.parent >= 0 ? after[l.parent] : null;
        if (parent && addedKeys.has(parent.key)) {
          // Inside a new block: indent under it.
          let top = parent;
          while (top.parent >= 0 && addedKeys.has(after[top.parent].key)) top = after[top.parent];
          out.push('+ ' + '  '.repeat(l.depth - top.depth) + '- ' + l.text);
        } else out.push('+ - ' + l.text + (parent ? '  (in ' + refOrText(parent) + ')' : ''));
      } else if (was.text !== l.text) {
        changed++;
        out.push('~ - ' + l.text);
      }
    }
    const gone = before.filter(l => !now.has(l.key));
    const goneKeys = new Set(gone.map(l => l.key));
    for (const l of gone) {
      removed++;
      const parent = l.parent >= 0 ? before[l.parent] : null;
      if (parent && goneKeys.has(parent.key)) continue;
      let inside = 0;
      const i = before.indexOf(l);
      for (let j = i + 1; j < before.length && before[j].depth > l.depth; j++) inside++;
      out.push('x - ' + l.text + (inside ? '  (and ' + inside + ' lines inside)' : ''));
    }
    if (!out.length) return { text: 'No changes since the last read.', changes: 0 };
    if (added + changed + removed > Math.max(20, after.length * 0.6)) return null;
    const head =
      'Changes since the last read: ' + changed + ' changed (~), ' + added + ' added (+), ' +
      removed + ' removed (x).';
    const r = limit([head, ...out], maxChars);
    r.changes = added + changed + removed;
    return r;
  }

  // A line with a ref has the ref as its key. Its text can hold anything, for example a name "x [e99]".
  const refOrText = l => (/^(?:f\d+)?e\d+$/.test(l.key) ? l.key : l.text.slice(0, 60));

  const QaTree = { build, lines, view, diff, INTERACTIVE, FIELD_ROLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = QaTree;
  else root.QaTree = QaTree;
})(typeof self !== 'undefined' ? self : globalThis);

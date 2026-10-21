/*
 * Daybook lines: to-do boxes and #hashtags, worked out from a note's own text.
 *
 * A to-do item is a line that starts with "[ ]" (open) or "[x]" (done). Keeping
 * them in the text means search, backups and older versions of the app all
 * handle checklists with no extra fields. Hashtags are simply words that start
 * with "#" and contain at least one letter ("#garden", "#trip-2027", not "#1").
 */
(function (global) {
  'use strict';

  var TODO = /^([ \t]*)\[([ xX]?)\][ \t]?/;
  // A tag starts after the start of the text, a space or punctuation (not after a
  // letter, digit, "&", "/" or "#", so "C#", "&#39;" and "site/#part" aren't tags).
  var TAG = /(^|[^\p{L}\p{N}_&\/#\\])#([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)/gu;
  var LETTER = /\p{L}/u;

  function splitLines(text) { return String(text || '').split('\n'); }

  function parseLine(line) {
    var m = TODO.exec(line);
    if (!m) return { todo: false, done: false, indent: '', body: line };
    return { todo: true, done: m[2] === 'x' || m[2] === 'X', indent: m[1], body: line.slice(m[0].length) };
  }

  // [{ todo, done, indent, body, line }] for every line of the text.
  function parse(text) {
    return splitLines(text).map(function (l, i) {
      var p = parseLine(l);
      p.line = i;
      return p;
    });
  }

  function isChecklist(text) {
    return splitLines(text).some(function (l) { return TODO.test(l); });
  }

  function counts(text) {
    var c = { done: 0, total: 0 };
    splitLines(text).forEach(function (l) {
      var p = parseLine(l);
      if (p.todo) { c.total += 1; if (p.done) c.done += 1; }
    });
    return c;
  }

  // Ticks or unticks the to-do on line `index`. Other lines are left exactly as they were.
  function toggle(text, index) {
    var lines = splitLines(text);
    var p = lines[index] !== undefined ? parseLine(lines[index]) : null;
    if (!p || !p.todo) return String(text || '');
    lines[index] = p.indent + (p.done ? '[ ] ' : '[x] ') + p.body;
    return lines.join('\n');
  }

  function lineAt(value, pos) {
    var start = value.lastIndexOf('\n', pos - 1) + 1;
    var end = value.indexOf('\n', pos);
    if (end < 0) end = value.length;
    return { start: start, end: end, text: value.slice(start, end) };
  }

  /*
   * The to-do button in the note box and the editor: makes the line the cursor
   * is on a to-do, or turns a to-do back into plain text.
   * Returns { value, cursor }.
   */
  function toggleMarker(value, pos) {
    value = String(value || '');
    pos = Math.max(0, Math.min(value.length, pos == null ? value.length : pos));
    var l = lineAt(value, pos);
    var col = pos - l.start;
    var m = TODO.exec(l.text);
    var replacement, cursor;
    if (m) {
      replacement = m[1] + l.text.slice(m[0].length);
      cursor = col >= m[0].length ? pos - (m[0].length - m[1].length) : l.start + m[1].length;
    } else {
      var indent = /^[ \t]*/.exec(l.text)[0];
      replacement = indent + '[ ] ' + l.text.slice(indent.length);
      cursor = col >= indent.length ? pos + 4 : l.start + indent.length + 4;
    }
    return { value: value.slice(0, l.start) + replacement + value.slice(l.end), cursor: cursor };
  }

  /*
   * Return pressed inside a to-do line: start a new to-do on the next line, or,
   * on an empty to-do, end the list by removing its box.
   * Returns { value, cursor }, or null to let Return work as usual.
   */
  function enterAt(value, selStart, selEnd) {
    value = String(value || '');
    if (selEnd == null) selEnd = selStart;
    var l = lineAt(value, selStart);
    var m = TODO.exec(l.text);
    if (!m || selStart < l.start + m[0].length && selStart > l.start) return null;
    if (selStart === l.start) return null; // at the very start: just push the line down
    var rest = l.text.slice(m[0].length);
    if (!rest.trim() && selEnd <= l.end) {
      var cleared = value.slice(0, l.start) + m[1] + value.slice(l.end);
      return { value: cleared, cursor: l.start + m[1].length };
    }
    var insert = '\n' + m[1] + '[ ] ';
    return { value: value.slice(0, selStart) + insert + value.slice(selEnd), cursor: selStart + insert.length };
  }

  // Drops empty to-do boxes left at the end, e.g. after Return on the last item.
  function tidy(text) {
    var lines = splitLines(text);
    while (lines.length > 1) {
      var p = parseLine(lines[lines.length - 1]);
      if (p.todo && !p.body.trim()) lines.pop();
      else if (!p.todo && !p.body.trim()) lines.pop();
      else break;
    }
    if (lines.length === 1) {
      var only = parseLine(lines[0]);
      if (only.todo && !only.body.trim()) return '';
    }
    return lines.join('\n');
  }

  // For short previews (search results, the On this day slip): boxes drawn as ☐ and ☑.
  function display(text) {
    return splitLines(text).map(function (l) {
      var p = parseLine(l);
      return p.todo ? p.indent + (p.done ? '☑ ' : '☐ ') + p.body : l;
    }).join('\n');
  }

  function tagKey(tag) {
    return String(tag).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // The text split into plain runs and hashtags: [{ text }, { text: '#tag', tag: 'tag' }, ...].
  function segments(text) {
    text = String(text || '');
    var out = [];
    var at = 0;
    TAG.lastIndex = 0;
    var m;
    while ((m = TAG.exec(text))) {
      if (!LETTER.test(m[2])) continue;
      var start = m.index + m[1].length;
      if (start > at) out.push({ text: text.slice(at, start) });
      out.push({ text: '#' + m[2], tag: m[2] });
      at = start + 1 + m[2].length;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }

  // Distinct tags in the text (first spelling wins), without the "#".
  function tags(text) {
    var seen = new Set();
    var list = [];
    segments(text).forEach(function (s) {
      if (!s.tag) return;
      var k = tagKey(s.tag);
      if (seen.has(k)) return;
      seen.add(k);
      list.push(s.tag);
    });
    return list;
  }

  /*
   * Every tag across many notes, most used first: [{ tag, key, count }].
   * The spelling shown is the one used most often.
   */
  function tagIndex(notes) {
    var byKey = new Map();
    notes.forEach(function (n) {
      tags(n.text).forEach(function (t) {
        var k = tagKey(t);
        var e = byKey.get(k);
        if (!e) { e = { key: k, count: 0, spellings: new Map() }; byKey.set(k, e); }
        e.count += 1;
        e.spellings.set(t, (e.spellings.get(t) || 0) + 1);
      });
    });
    var out = [];
    byKey.forEach(function (e) {
      var best = null;
      var bestN = -1;
      e.spellings.forEach(function (n, s) { if (n > bestN) { best = s; bestN = n; } });
      out.push({ tag: best, key: e.key, count: e.count });
    });
    out.sort(function (a, b) { return b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    return out;
  }

  global.DaybookLines = {
    parse: parse,
    isChecklist: isChecklist,
    counts: counts,
    toggle: toggle,
    toggleMarker: toggleMarker,
    enterAt: enterAt,
    tidy: tidy,
    display: display,
    segments: segments,
    tags: tags,
    tagKey: tagKey,
    tagIndex: tagIndex
  };
})(typeof window !== 'undefined' ? window : globalThis);

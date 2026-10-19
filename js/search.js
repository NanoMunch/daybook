/*
 * Daybook search: matching and highlighting, all on the phone.
 *
 * Matching ignores case and accents ("cafe" finds "Café") and treats curly and
 * straight quotes alike. Every word typed must appear somewhere in the note, in
 * any order, as the start of a word or inside one ("plum" finds "plumber").
 */
(function (global) {
  'use strict';

  var COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;
  var QUOTES = { '‘': "'", '’': "'", '‚': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"' };

  var QUOTE_RE = /[‘’‚′“”„″]/g;

  function foldChar(ch) {
    if (QUOTES[ch]) return QUOTES[ch];
    return ch.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(/ς/g, 'σ');
  }

  // Folded text only, for matching. Plain ASCII (most notes) takes the quick path.
  function fold(text) {
    text = String(text || '');
    if (!/[^\x00-\x7f]/.test(text)) return text.toLowerCase();
    return text.normalize('NFD').replace(COMBINING, '').toLowerCase()
      .replace(/ς/g, 'σ')
      .replace(QUOTE_RE, function (q) { return QUOTES[q]; });
  }

  /*
   * Folded text plus a map back to the original: for each folded character k,
   * from[k] and to[k] give the original range it came from.
   */
  function foldWithMap(text) {
    text = String(text || '');
    var out = '';
    var from = [];
    var to = [];
    var i = 0;
    for (var ch of text) {
      var f = foldChar(ch);
      // A lone accent mark folds to nothing; it belongs to the letter before it.
      if (!f.length && to.length) to[to.length - 1] = i + ch.length;
      for (var j = 0; j < f.length; j++) { from.push(i); to.push(i + ch.length); }
      out += f;
      i += ch.length;
    }
    return { text: out, from: from, to: to };
  }

  // The words in a query, folded, longest first, without repeats or words contained in another.
  function terms(query) {
    var list = fold(query).split(/\s+/).filter(Boolean);
    list = list.filter(function (t, i) { return list.indexOf(t) === i; });
    list.sort(function (a, b) { return b.length - a.length; });
    return list.filter(function (t, i) {
      for (var k = 0; k < i; k++) if (list[k].indexOf(t) >= 0) return false;
      return true;
    });
  }

  function matchesAll(folded, termList) {
    if (!termList.length) return false;
    for (var i = 0; i < termList.length; i++) if (folded.indexOf(termList[i]) < 0) return false;
    return true;
  }

  // Ranges [start, end) in the ORIGINAL text where any term appears, merged and sorted.
  function highlightRanges(text, termList) {
    var m = foldWithMap(text);
    var hits = [];
    termList.forEach(function (t) {
      if (!t) return;
      var at = m.text.indexOf(t);
      while (at >= 0) {
        hits.push([m.from[at], m.to[at + t.length - 1]]);
        at = m.text.indexOf(t, at + 1);
      }
    });
    hits.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    var merged = [];
    hits.forEach(function (h) {
      var last = merged[merged.length - 1];
      if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
      else merged.push([h[0], h[1]]);
    });
    return merged;
  }

  /*
   * A piece of the text to show in results. Long notes whose first match is far
   * in are trimmed to start a little before it, at a word boundary.
   * Returns { text, ranges, cutStart } with ranges relative to the snippet.
   */
  function snippet(text, termList, lead) {
    text = String(text || '');
    lead = lead || 60;
    var ranges = highlightRanges(text, termList);
    var start = 0;
    if (ranges.length && ranges[0][0] > lead + 20) {
      start = ranges[0][0] - lead;
      var space = text.slice(start, ranges[0][0]).search(/\s\S/);
      if (space >= 0) start += space + 1;
      // Don't begin in the middle of a surrogate pair.
      var code = text.charCodeAt(start);
      if (code >= 0xDC00 && code <= 0xDFFF) start += 1;
    }
    var cut = start > 0;
    if (cut) start += text.slice(start).search(/\S|$/); // skip leading spaces
    return {
      text: text.slice(start),
      cutStart: cut,
      ranges: ranges
        .filter(function (r) { return r[1] > start; })
        .map(function (r) { return [Math.max(0, r[0] - start), r[1] - start]; })
    };
  }

  /*
   * Runs a search over a prepared index ({ note, folded } entries).
   * Returns matching notes, newest day first, in page order within a day.
   */
  function run(index, query) {
    var termList = terms(query);
    if (!termList.length) return { terms: termList, notes: [] };
    var notes = [];
    index.forEach(function (e) { if (matchesAll(e.folded, termList)) notes.push(e.note); });
    notes.sort(function (a, b) {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      return a.createdAt - b.createdAt;
    });
    return { terms: termList, notes: notes };
  }

  function buildIndex(notes) {
    return notes.map(function (n) { return { note: n, folded: fold(n.text) }; });
  }

  // Splits a sorted list of notes into [{ day, notes }] groups, keeping order.
  function groupByDay(notes) {
    var groups = [];
    notes.forEach(function (n) {
      var last = groups[groups.length - 1];
      if (last && last.day === n.day) last.notes.push(n);
      else groups.push({ day: n.day, notes: [n] });
    });
    return groups;
  }

  global.DaybookSearch = {
    fold: fold,
    foldWithMap: foldWithMap,
    terms: terms,
    matchesAll: matchesAll,
    highlightRanges: highlightRanges,
    snippet: snippet,
    run: run,
    buildIndex: buildIndex,
    groupByDay: groupByDay
  };
})(typeof window !== 'undefined' ? window : globalThis);

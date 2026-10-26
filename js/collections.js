/*
 * Daybook smart collections: notes sorted into groups by simple rules, on the phone.
 *
 * Nothing here learns, guesses with AI or sends anything anywhere. Each
 * collection is a handful of patterns run over a note's own text (links, phone
 * numbers, amounts of money, street addresses, ideas, open to-dos) or a look at
 * what the note holds (photos, voice notes, a pin). There are no folders to
 * keep up: a note shows up in every collection it fits, and leaves when it
 * stops fitting.
 *
 * find(kind, text) returns what was found as [{ start, end, value, href }],
 * with offsets into the text given, so the app can mark them and offer a tap
 * (open a link, call a number, write an email, look up an address in Maps).
 */
(function (global) {
  'use strict';

  var KINDS = [
    { kind: 'todos', label: 'To-dos', hint: 'Boxes still to tick' },
    { kind: 'links', label: 'Links', hint: 'Web addresses' },
    { kind: 'photos', label: 'Photos', hint: 'Every photo note' },
    { kind: 'voice', label: 'Voice notes', hint: 'Every recording' },
    { kind: 'pinned', label: 'Pinned', hint: 'Pinned to their day' },
    { kind: 'places', label: 'Addresses', hint: 'Street addresses' },
    { kind: 'phones', label: 'Phones', hint: 'Numbers to call' },
    { kind: 'emails', label: 'Emails', hint: 'Email addresses' },
    { kind: 'money', label: 'Money', hint: 'Prices and amounts' },
    { kind: 'ideas', label: 'Ideas', hint: 'Ideas and what-ifs' }
  ];

  /* ---------- Links and emails ---------- */

  var EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
  var TLDS = 'com|net|org|io|app|dev|co|me|edu|gov|info|ai|au|nz|uk|ie|ca|us|ly|tv|fm|gg|xyz|shop|store|page|site|blog|news|online|travel';
  var URL_RE = new RegExp(
    '(?:https?:\\/\\/|www\\.)[^\\s<>"`]+' +
    '|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:' + TLDS + ')(?![\\w-])(?:\\/[^\\s<>"`]*)?',
    'gi'
  );

  // Trailing punctuation belongs to the sentence, not the link ("see example.com.").
  function trimUrl(s) {
    for (;;) {
      var last = s.slice(-1);
      if (/[.,;:!?'"’”…]/.test(last)) { s = s.slice(0, -1); continue; }
      if (last === ')' && (s.split('(').length < s.split(')').length)) { s = s.slice(0, -1); continue; }
      if (last === ']' && (s.split('[').length < s.split(']').length)) { s = s.slice(0, -1); continue; }
      return s;
    }
  }

  function webHref(s) {
    var href = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    try {
      var u = new URL(href);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (!/\./.test(u.hostname)) return null;
      return u.href;
    } catch (e) { return null; }
  }

  function findEmails(text) {
    var out = [];
    var m;
    EMAIL.lastIndex = 0;
    while ((m = EMAIL.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0], href: 'mailto:' + m[0] });
    }
    return out;
  }

  function findLinks(text) {
    var emails = findEmails(text);
    var out = [];
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      var start = m.index;
      var prev = text.charAt(start - 1);
      // Part of a word, an email or a longer address: not a link on its own.
      if (prev && /[\w@.\/-]/.test(prev)) continue;
      var value = trimUrl(m[0]);
      var end = start + value.length;
      if (emails.some(function (e) { return start < e.end && end > e.start; })) continue;
      // A bare "word.word" needs a letter in its name ("v1.2" isn't a link) unless it has a scheme.
      if (!/^(?:https?:\/\/|www\.)/i.test(value) && !/[a-z]/i.test(value.split('.')[0])) continue;
      var href = webHref(value);
      if (!href) continue;
      out.push({ start: start, end: end, value: value, href: href });
    }
    return out;
  }

  /* ---------- Phone numbers ---------- */

  // Runs of digits with the usual separators; trimmed and checked below.
  var PHONE_RUN = /\+?\(?\d[\d \t()\-]{4,}\d/g;

  function phoneOk(raw) {
    var plus = raw.charAt(0) === '+';
    var d = raw.replace(/\D/g, '');
    if (plus) return d.length >= 8 && d.length <= 15;
    if (/^0[2-578]\d{8}$/.test(d)) return true;   // Australian mobiles and landlines: 04xx xxx xxx, (03) 9xxx xxxx
    if (/^1[38]00\d{6}$/.test(d)) return true;    // 1300 / 1800 numbers
    if (/^13\d{4}$/.test(d) && /\s/.test(raw)) return true; // 13 xx xx
    if (/^00\d{8,13}$/.test(d)) return true;      // dialled overseas from Australia
    return false;
  }

  function findPhones(text) {
    var out = [];
    var m;
    PHONE_RUN.lastIndex = 0;
    while ((m = PHONE_RUN.exec(text))) {
      var start = m.index;
      var prev = text.charAt(start - 1);
      if (prev && /[\w$€£¥.,:\/#-]/.test(prev)) continue;
      // Try the whole run, then shorter runs ending at a group boundary ("call 0412 345 678 2 times").
      var raw = m[0];
      var found = null;
      while (raw) {
        var clean = raw.replace(/[\s(\-]+$/, '');
        var after = text.slice(start + clean.length, start + clean.length + 2);
        if (phoneOk(clean) && !/^[\w%\/:]/.test(after) && !/^[.,]\w/.test(after)) {
          found = clean;
          break;
        }
        var cut = raw.search(/[\s\-]+\S*$/);
        if (cut <= 0) break;
        raw = raw.slice(0, cut);
      }
      if (!found) continue;
      // An unmatched "(" at the start ("(call 0412…") isn't part of the number.
      if (found.charAt(0) === '(' && found.indexOf(')') < 0) { found = found.slice(1); start += 1; }
      var digits = found.replace(/\D/g, '');
      out.push({
        start: start,
        end: start + found.length,
        value: found,
        href: 'tel:' + (found.charAt(0) === '+' ? '+' : '') + digits
      });
    }
    return out;
  }

  /* ---------- Money ---------- */

  var AMOUNT = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?';
  var MONEY = new RegExp(
    '(?:(?:\\b(?:A|AU|US|NZ|C|HK|S))?\\$|€|£|¥|₹)\\s?(?:' + AMOUNT + ')(?:\\s?(?:k|m|bn)\\b)?' +
    '|\\b(?:AUD|USD|NZD|EUR|GBP|JPY|CAD)\\s?(?:' + AMOUNT + ')' +
    '|\\b(?:' + AMOUNT + ')\\s?(?:k\\s)?(?:dollars?|bucks|cents|euros?|AUD|USD|NZD|EUR|GBP|JPY|CAD)\\b',
    'gi'
  );

  function findMoney(text) {
    var out = [];
    var m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(text))) {
      var value = m[0].replace(/\s+$/, '');
      out.push({ start: m.index, end: m.index + value.length, value: value });
    }
    return out;
  }

  /* ---------- Street addresses ---------- */

  var TYPES = 'Street|St|Road|Rd|Avenue|Ave|Parade|Pde|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Crescent|Cres|' +
    'Boulevard|Blvd|Bvd|Highway|Hwy|Terrace|Tce|Way|Grove|Gr|Close|Square|Sq|Esplanade|Esp|' +
    'Circuit|Cct|Promenade|Walk|Rise|Mews|Row|Alley|Arcade|Track|Quay|Parkway|Pkwy';
  var STATES = 'VIC|NSW|QLD|SA|WA|TAS|NT|ACT|Vic|Victoria';
  var WORD = "[A-Z][\\p{L}'’\\-]*";
  var NUMBER = '(?:(?:Unit|Apt|Shop|Suite|Level)\\s*\\d+[A-Za-z]?,?\\s+)?\\d+[A-Za-z]?(?:[\\/\\-]\\d+[A-Za-z]?)?';
  var TAIL = '(?:,\\s*' + WORD + '(?:\\s+' + WORD + '){0,2})?(?:,?\\s+(?:' + STATES + ')\\b)?(?:,?\\s+\\d{4}\\b)?';
  // "12 Smith St", "3/45 Lygon Street, Carlton VIC 3053", "Unit 2, 8 Little Collins St".
  var ADDRESS = new RegExp('\\b' + NUMBER + '\\s+(?:' + WORD + '\\.?\\s+){1,3}(?:' + TYPES + ')\\b\\.?' + TAIL, 'gu');
  // Typed in lower case: "12 smith st". Short street words only, to avoid stray matches.
  var ADDRESS_LOWER = new RegExp('\\b\\d+[a-z]?(?:\\/\\d+)?\\s+(?:[a-z][a-z\'’\\-]+\\s+){1,2}(?:st|rd|ave|pde|hwy|cres|tce|blvd)\\b\\.?', 'g');
  // A suburb with its state and postcode on its own: "Fitzroy VIC 3065".
  var LOCALITY = new RegExp('\\b' + WORD + '(?:\\s+' + WORD + '){0,2},?\\s+(?:VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\\s+\\d{4}\\b', 'gu');

  function findPlaces(text) {
    var out = [];
    [ADDRESS, ADDRESS_LOWER, LOCALITY].forEach(function (re) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        var value = m[0].replace(/[\s,.]+$/, '');
        var start = m.index;
        var end = start + value.length;
        if (out.some(function (o) { return start < o.end && end > o.start; })) continue;
        out.push({
          start: start,
          end: end,
          value: value,
          href: 'https://maps.apple.com/?q=' + encodeURIComponent(value)
        });
      }
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* ---------- Ideas ---------- */

  var IDEA_RES = [
    /(?:^|\n)[ \t]*(?:💡|(?:new |another |random |app |gift |business |startup |project )?ideas?\b|what if\b|brainstorm(?:ing)?\b|shower thought\b)/gi,
    /(?:^|[^\p{L}\p{N}_&\/#])#(?:ideas?|brainstorm|someday)\b/giu,
    /\b(?:it(?:’|')?d|it would|would|wouldn(?:’|')?t it) be (?:so |really )?(?:cool|fun|nice|great|good|neat|amazing) (?:if|to)\b/gi,
    /\b(?:i|we) (?:could|should|might|want to) (?:build|make|write|start|create|design|invent|open|launch|try making)\b/gi,
    /\b(?:someday|some day|one day) (?:i|we)(?:(?:’|')?(?:d|ll)| would| will| could| should)?\b/gi,
    /\bmaybe (?:i|we) (?:could|should)\b/gi,
    /💡/g
  ];

  function findIdeas(text) {
    var out = [];
    IDEA_RES.forEach(function (re) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        var value = m[0];
        var start = m.index;
        // Leave out the line break or space a pattern starts with.
        var lead = value.search(/[^\s#]|#/);
        if (/^(?:\n|[^\p{L}\p{N}_&\/#])#/u.test(value)) lead = 1;
        if (lead > 0) { start += lead; value = value.slice(lead); }
        var end = start + value.length;
        if (!value || out.some(function (o) { return start < o.end && end > o.start; })) continue;
        out.push({ start: start, end: end, value: value });
        if (m[0].length === 0) re.lastIndex += 1;
      }
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* ---------- To-dos ---------- */

  // Open to-do lines, in the stored form ("[ ] milk") or the preview form ("☐ milk").
  function findTodos(text) {
    var out = [];
    var at = 0;
    String(text).split('\n').forEach(function (line) {
      var m = /^([ \t]*)(?:\[ ?\]|☐)[ \t]?/.exec(line);
      if (m && line.length > m[0].length) {
        out.push({ start: at + m[0].length, end: at + line.length, value: line.slice(m[0].length) });
      }
      at += line.length + 1;
    });
    return out;
  }

  var FINDERS = {
    links: findLinks,
    emails: findEmails,
    phones: findPhones,
    money: findMoney,
    places: findPlaces,
    ideas: findIdeas,
    todos: findTodos
  };

  function find(kind, text) {
    var f = FINDERS[kind];
    return f ? f(String(text || '')) : [];
  }

  function has(kind, note) {
    if (!note) return false;
    if (kind === 'photos') return Array.isArray(note.photos) && note.photos.length > 0;
    if (kind === 'voice') return Array.isArray(note.audio) && note.audio.length > 0;
    if (kind === 'pinned') return !!note.pinned;
    return find(kind, note.text).length > 0;
  }

  /*
   * Sorts every note into collections at once.
   * Returns Map kind -> notes (newest day first, page order within a day).
   */
  function sort(notes) {
    var byKind = new Map();
    KINDS.forEach(function (k) { byKind.set(k.kind, []); });
    var ordered = notes.slice().sort(function (a, b) {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      return a.createdAt - b.createdAt;
    });
    ordered.forEach(function (n) {
      KINDS.forEach(function (k) { if (has(k.kind, n)) byKind.get(k.kind).push(n); });
    });
    return byKind;
  }

  global.DaybookCollections = {
    kinds: KINDS,
    find: find,
    has: has,
    sort: sort
  };
})(typeof window !== 'undefined' ? window : globalThis);

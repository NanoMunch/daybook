/*
 * Daybook agenda: dates and times found in notes, worked out on the phone.
 *
 * Plain rules only, no AI and nothing sent anywhere. Each line of a note is read
 * for things like "tomorrow", "Friday", "next Tue", "12 Nov", "Nov 12th",
 * "12/11" (day first, as in Australia), "2026-11-12", "in 3 days", "this
 * weekend", and times like "3pm", "3:30 pm", "15:30" and "noon". Words such as
 * "Friday" are read from the day the note belongs to, so a note written last
 * Monday that says "Friday" means the Friday of that week.
 *
 * build(notes) returns agenda items, soonest first:
 *   { key, noteId, noteDay, createdAt, date: 'YYYY-MM-DD', time: 'HH:MM' | null,
 *     text, marks: [[start, end]], todo }
 * where text is the line (or, if the line is only a date, the note's first line)
 * and marks are the date and time words within it.
 */
(function (global) {
  'use strict';

  var DAY_MS = 86400000;

  /* ---------- Day keys (calendar maths in UTC, so daylight saving can't shift a day) ---------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toKey(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function keyToUTC(key) { return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)); }
  function utcToKey(t) { var d = new Date(t); return toKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  function addDays(key, n) { return utcToKey(keyToUTC(key) + n * DAY_MS); }
  // Monday 0 … Sunday 6
  function weekdayOf(key) { return (new Date(keyToUTC(key)).getUTCDay() + 6) % 7; }
  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 ? toKey(y, m, d) : null;
  }
  function fullYear(y) { y = +y; return y < 100 ? 2000 + y : y; }

  /*
   * A day and month with no year: the first such date from 30 days before the
   * note's day onwards. So "25 Dec" written in January is last Christmas, and
   * "5 Jan" written in December is next January.
   */
  function nearestYear(anchor, m, d) {
    var y = +anchor.slice(0, 4);
    var floor = addDays(anchor, -30);
    for (var yy = y - 1; yy <= y + 1; yy++) {
      var k = validDate(yy, m, d);
      if (k && k >= floor) return k;
    }
    return validDate(y + 1, m, d) || validDate(y + 2, m, d);
  }

  /* ---------- Words ---------- */

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  var MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var ORD = '(?:st|nd|rd|th)?';
  var NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12
  };
  var WEEKDAYS = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

  function monthNum(word) { return MONTHS[word.slice(0, 3).toLowerCase()]; }

  // Before a number: not part of a longer number, an amount, a ratio or a version.
  function cleanBefore(text, i) {
    var p = text.charAt(i - 1);
    return !p || !/[\d$€£¥.,:\/#\-]/.test(p);
  }
  function cleanAfter(text, i) {
    var n = text.charAt(i);
    return !n || !/[\d\/]/.test(n);
  }

  var LEAD_WORDS = /(?:^|[\s(])(?:on|by|due|until|till|til|from|before|after|for|this|next|date|dated)\s*:?\s*$/i;

  function each(re, text, fn) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text))) {
      fn(m);
      if (!m[0].length) re.lastIndex += 1;
    }
  }

  /* ---------- Dates ---------- */

  function findDates(line, anchor) {
    var out = [];
    function add(start, end, date, kind) {
      if (date) out.push({ start: start, end: end, date: date, kind: kind || 'date' });
    }

    // 2026-11-12
    each(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, line, function (m) {
      add(m.index, m.index + m[0].length, validDate(+m[1], +m[2], +m[3]));
    });

    // 12/11/2026, 12/11/26, 12.11.2026 (day first)
    each(/(\d{1,2})([\/.])(\d{1,2})\2(\d{4}|\d{2})/g, line, function (m) {
      var end = m.index + m[0].length;
      if (!cleanBefore(line, m.index) || !cleanAfter(line, end)) return;
      add(m.index, end, validDate(fullYear(m[4]), +m[3], +m[1]));
    });

    // 12/11 (day first, no year): only after a word like "on" or "by", at the start
    // of a line, or just before a time, so fractions and unit numbers stay out.
    each(/(\d{1,2})\/(\d{1,2})(?![\/\d])/g, line, function (m) {
      var end = m.index + m[0].length;
      if (!cleanBefore(line, m.index)) return;
      var before = line.slice(0, m.index);
      var after = line.slice(end);
      var led = LEAD_WORDS.test(before) || /^[\s☐☑\-•*]*$/.test(before) ||
        /^\s*(?:,|at|@)?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:[ap]\.?m\b|:\d)/i.test(after) ||
        /^\s*(?:,|at|@)?\s*\d{1,2}:\d{2}/.test(after);
      if (!led) return;
      if (/^\s*(?:cups?|tsp|tbsp|kg|g|ml|l|of|hours?|hrs?|mins?|minutes?|days?|weeks?|times?|serves?|people|pax)\b/i.test(after)) return;
      add(m.index, end, nearestYear(anchor, +m[2], +m[1]));
    });

    // 12 Nov, 12th of November, 12 November 2026
    each(new RegExp('(\\d{1,2})' + ORD + '(?:\\s+of)?\\s+' + MONTH + '\\b\\.?(?:,?\\s+(\\d{4})\\b)?', 'gi'), line, function (m) {
      if (!cleanBefore(line, m.index)) return;
      var mo = monthNum(m[2]);
      var key = m[3] ? validDate(+m[3], mo, +m[1]) : nearestYear(anchor, mo, +m[1]);
      add(m.index, m.index + m[0].length, key);
    });

    // Nov 12, November 12th, Nov 12 2026 (not "Nov 3pm")
    each(new RegExp('\\b' + MONTH + '\\.?\\s+(\\d{1,2})' + ORD + '\\b(?!\\s*(?:[ap]\\.?m\\b|[:.]\\d))(?:,?\\s+(\\d{4})\\b)?', 'gi'), line, function (m) {
      var after = m.index + m[0].length;
      if (!cleanAfter(line, after)) return;
      var mo = monthNum(m[1]);
      var key = m[3] ? validDate(+m[3], mo, +m[2]) : nearestYear(anchor, mo, +m[2]);
      add(m.index, after, key);
    });

    // the 12th
    each(/\bthe\s+(\d{1,2})(st|nd|rd|th)\b(?!\s+(?:floor|time|century|birthday|anniversary|place|row|hole|grade|year|lap|round|level|edition|percentile)\b)/gi, line, function (m) {
      var d = +m[1];
      var y = +anchor.slice(0, 4);
      var mo = +anchor.slice(5, 7);
      var key = validDate(y, mo, d);
      if (!key || key < anchor) {
        mo += 1;
        if (mo > 12) { mo = 1; y += 1; }
        key = validDate(y, mo, d);
      }
      add(m.index, m.index + m[0].length, key);
    });

    // today, tonight, this arvo, tomorrow, the day after tomorrow
    each(/\b(?:the\s+)?day\s+after\s+tomorrow\b/gi, line, function (m) {
      add(m.index, m.index + m[0].length, addDays(anchor, 2), 'relative');
    });
    each(/\b(?:tomorrow|tmrw|tmr|tomoz)\b(?:\s+(?:morning|night|arvo|afternoon|evening))?/gi, line, function (m) {
      add(m.index, m.index + m[0].length, addDays(anchor, 1), 'relative');
    });
    each(/\b(?:today|tonight|this\s+(?:morning|afternoon|arvo|evening))\b/gi, line, function (m) {
      add(m.index, m.index + m[0].length, anchor, 'relative');
    });

    // in 3 days, in two weeks, in a fortnight
    each(/\bin\s+(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|fortnights?)\b/gi, line, function (m) {
      var n = /\d/.test(m[1]) ? +m[1] : NUMBER_WORDS[m[1].toLowerCase()];
      var unit = m[2].toLowerCase();
      var days = n * (unit.indexOf('fortnight') === 0 ? 14 : unit.indexOf('week') === 0 ? 7 : 1);
      if (days > 0 && days <= 730) add(m.index, m.index + m[0].length, addDays(anchor, days), 'relative');
    });

    // this weekend: the coming Saturday (or the weekend day it already is)
    each(/\b(?:this|the)\s+weekend\b/gi, line, function (m) {
      var wd = weekdayOf(anchor);
      add(m.index, m.index + m[0].length, wd >= 5 ? anchor : addDays(anchor, 5 - wd), 'relative');
    });

    // Friday, this Fri, on Tuesday, next Thursday (next = in the following Monday-to-Sunday week)
    var WD = /\b(?:(this|next|on|by|until|till|coming|due)\s+)?(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|MON|TUE|WED|THU|FRI|SAT|SUN))\b\.?/gi;
    each(WD, line, function (m) {
      var word = m[2] || m[3];
      var start = m.index;
      var end = start + m[0].length;
      // Short forms must be written with a capital and be clearly a day ("Sat 3pm", "on Sun"), not "sat down".
      if (m[3] && (!/^[A-Z]/.test(m[3]) || (!m[1] && !/^[\s,]+\d/.test(line.slice(end))))) return;
      var before = line.slice(0, start);
      if (/\b(?:last|every|each|past|previous)\s+$/i.test(before)) return;
      var wd = WEEKDAYS[word.slice(0, 3).toLowerCase()];
      var a = weekdayOf(anchor);
      var key;
      if (m[1] && m[1].toLowerCase() === 'next') key = addDays(anchor, 7 - a + wd);
      else key = addDays(anchor, (wd - a + 7) % 7);
      out.push({ start: start, end: end, date: key, kind: 'weekday' });
    });

    // A weekday written right before a date ("Tue 12 Nov") is part of that date.
    out.sort(function (x, y) { return x.start - y.start || (y.end - y.start) - (x.end - x.start); });
    var merged = [];
    out.forEach(function (o) {
      var prev = merged[merged.length - 1];
      if (prev && prev.kind === 'weekday' && o.kind === 'date' && o.start >= prev.end &&
          /^[\s,]*$/.test(line.slice(prev.end, o.start))) {
        merged[merged.length - 1] = { start: prev.start, end: o.end, date: o.date, kind: 'date' };
        return;
      }
      if (prev && o.start < prev.end) return; // overlaps a longer match
      merged.push(o);
    });
    return merged;
  }

  /* ---------- Times ---------- */

  function findTimes(line) {
    var out = [];
    function add(start, end, h, min) {
      if (h < 0 || h > 23 || min < 0 || min > 59) return;
      if (out.some(function (o) { return start < o.end && end > o.start; })) return;
      out.push({ start: start, end: end, time: pad(h) + ':' + pad(min) });
    }
    function twelve(h, ap) {
      if (h < 1 || h > 12) return -1;
      if (/^p/i.test(ap)) return h === 12 ? 12 : h + 12;
      return h === 12 ? 0 : h;
    }
    // 3:30pm, 3.30 pm, 10:15 a.m.
    each(/(\d{1,2})[:.](\d{2})\s*([ap])\.?m\b\.?/gi, line, function (m) {
      if (!cleanBefore(line, m.index)) return;
      add(m.index, m.index + m[0].length, twelve(+m[1], m[3]), +m[2]);
    });
    // 3pm, 11 am
    each(/(\d{1,2})\s*([ap])\.?m\b\.?/gi, line, function (m) {
      if (!cleanBefore(line, m.index)) return;
      add(m.index, m.index + m[0].length, twelve(+m[1], m[2]), 0);
    });
    // 15:30, 9:00, 2:30 (1 to 7 o'clock with no am/pm is read as afternoon)
    each(/(\d{1,2}):(\d{2})(?!\d)(?!\s*[ap]\.?m\b)/gi, line, function (m) {
      if (!cleanBefore(line, m.index)) return;
      var h = +m[1];
      if (m[1].length === 1 && h >= 1 && h <= 7) h += 12;
      add(m.index, m.index + m[0].length, h, +m[2]);
    });
    each(/\b(?:noon|midday)\b/gi, line, function (m) {
      add(m.index, m.index + m[0].length, 12, 0);
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* ---------- Notes to agenda items ---------- */

  var TODO = /^([ \t]*)\[([ xX]?)\][ \t]?/;

  function overlapsAny(list, start, end) {
    return list.some(function (o) { return start < o.end && end > o.start; });
  }

  // Street addresses, phone numbers and amounts aren't dates ("3/45 Lygon St", "$12.30").
  function blockedRanges(line) {
    var C = global.DaybookCollections;
    if (!C) return [];
    return C.find('places', line).concat(C.find('phones', line), C.find('money', line), C.find('links', line));
  }

  function localKey(ms) {
    var d = new Date(ms);
    return toKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function localTime(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function letters(s) { return (s.match(/\p{L}/gu) || []).length; }

  function itemsOf(note) {
    if (!note || typeof note.text !== 'string' || !note.text.trim()) return [];
    var anchor = note.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) return [];
    var lines = note.text.split('\n');
    var shown = lines.map(function (l) {
      var t = TODO.exec(l);
      return t ? { todo: true, done: /x/i.test(t[2]), body: (t[2] && /x/i.test(t[2]) ? '☑ ' : '☐ ') + l.slice(t[0].length), cut: t[0].length - 2 } : { todo: false, done: false, body: l, cut: 0 };
    });
    var firstLine = '';
    for (var f = 0; f < shown.length; f++) if (shown[f].body.trim()) { firstLine = shown[f].body.trim(); break; }
    var writtenOnDay = note.createdAt && localKey(note.createdAt) === anchor;
    var writtenAt = note.createdAt ? localTime(note.createdAt) : '00:00';

    var items = [];
    var lastItem = null;
    shown.forEach(function (s, li) {
      if (s.done) return;
      var line = s.body;
      if (!line.trim()) return;
      var blocked = blockedRanges(line);
      var dates = findDates(line, anchor).filter(function (d) { return !overlapsAny(blocked, d.start, d.end); });
      var times = findTimes(line).filter(function (t) {
        return !overlapsAny(blocked, t.start, t.end) && !overlapsAny(dates, t.start, t.end);
      });
      var lineItems = [];

      if (dates.length) {
        var used = new Set();
        dates.forEach(function (d, i) {
          var next = dates[i + 1];
          var t = null;
          for (var k = 0; k < times.length; k++) {
            if (used.has(k)) continue;
            if (times[k].start >= d.end && (!next || times[k].start < next.start)) { t = k; break; }
          }
          // "3pm Friday": a time before the only date in the line belongs to it.
          if (t === null && dates.length === 1 && times.length) t = 0;
          if (t !== null) used.add(t);
          var marks = [[d.start, d.end]];
          if (t !== null) marks.push([times[t].start, times[t].end]);
          lineItems.push({ date: d.date, time: t !== null ? times[t].time : null, marks: marks });
        });
      } else if (times.length) {
        var t0 = times[0];
        if (lastItem && lastItem.time === null && lastItem.line === li - 1) {
          // "Dinner at Sam's Friday" then "7pm" on the next line.
          lastItem.time = t0.time;
          return;
        }
        var date = lastItem ? lastItem.date : anchor;
        // A time on the note's own day only counts if it's still ahead ("dentist 3pm" written at 9am).
        if (!lastItem && writtenOnDay && t0.time <= writtenAt) return;
        lineItems.push({ date: date, time: t0.time, marks: [[t0.start, t0.end]] });
      }

      lineItems.forEach(function (it, i) {
        // A line that's only a date ("Friday 7pm") takes its words from the note's first line.
        var rest = line;
        it.marks.slice().sort(function (a, b) { return b[0] - a[0]; }).forEach(function (r) {
          rest = rest.slice(0, r[0]) + rest.slice(r[1]);
        });
        var bare = letters(rest.replace(/\b(?:at|on|by|from|until|till|the|and|to|☐)\b/gi, '')) < 3;
        var text = line;
        var marks = it.marks;
        if (bare && firstLine && firstLine !== line.trim()) { text = firstLine; marks = []; }
        var lead = text.length - text.replace(/^\s+/, '').length;
        text = text.trim();
        marks = marks.map(function (r) { return [r[0] - lead, r[1] - lead]; })
          .filter(function (r) { return r[0] >= 0 && r[1] <= text.length; })
          .sort(function (a, b) { return a[0] - b[0]; });
        var item = {
          key: note.id + ':' + li + ':' + i,
          noteId: note.id,
          noteDay: anchor,
          createdAt: note.createdAt || 0,
          date: it.date,
          time: it.time,
          text: text,
          marks: marks,
          todo: s.todo,
          line: li,
          bare: bare
        };
        items.push(item);
        lastItem = item;
      });
    });
    items.forEach(function (it) { delete it.line; delete it.bare; });
    return items;
  }

  function compare(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var at = a.time || '', bt = b.time || '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }

  function build(notes) {
    var out = [];
    (notes || []).forEach(function (n) {
      itemsOf(n).forEach(function (it) { out.push(it); });
    });
    out.sort(compare);
    return out;
  }

  global.DaybookAgenda = {
    findDates: findDates,
    findTimes: findTimes,
    itemsOf: itemsOf,
    build: build,
    addDays: addDays,
    weekdayOf: weekdayOf
  };
})(typeof window !== 'undefined' ? window : globalThis);

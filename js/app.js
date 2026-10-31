/*
 * Daybook app. Everything here runs on the phone; notes never leave it.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.6.0';
  var DB = window.DaybookDB;
  var Backup = window.DaybookBackup;
  var Photos = window.DaybookPhotos;
  var Voice = window.DaybookVoice;
  var Search = window.DaybookSearch;
  var Lines = window.DaybookLines;
  var Collections = window.DaybookCollections;
  var Agenda = window.DaybookAgenda;
  var MAX_RESULTS = 150;
  var DAY_MS = 86400000;
  var BACKUP_EVERY_DAYS = 7;
  var LINE = 28;
  var TRASH_KEEP_MS = 10 * 60 * 1000; // deleted photos stay recoverable (Undo) at least this long

  function $(id) { return document.getElementById(id); }

  var state = {
    day: null,
    notes: [],
    media: new Map(),     // media id -> record, for notes on the current page
    thumbUrls: new Map(), // media id -> object URL of its thumbnail
    els: new Map(),
    editing: null,        // { id, before, textarea }
    followToday: true,
    loadSeq: 0,
    undo: null,
    toastTimer: null,
    draftTimer: null,
    swReg: null,
    waitingWorker: null,
    reloadRequested: false,
    backupFile: null,
    restoreBytes: null,
    restorePlan: null,
    addingPhotos: false,
    recorder: null,       // the open voice recording, if any
    search: { index: null, tags: null, sorted: null, collection: null, seq: 0, timer: null, urls: [] },
    // Dates found in notes. Rebuilt after any change to the notes (see watchWrites).
    agenda: { items: null, stamp: 0, builtAt: -1, earlier: false, seq: 0, plannedSeq: 0 }
  };

  var viewer = { noteId: null, index: 0, url: null, ratio: 1, zoom: 1, fitW: 0, fitH: 0 };

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------- Small helpers ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayKey() { return dayKey(new Date()); }
  function parseDay(key) {
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0); // midday avoids daylight-saving edges
  }
  function addDays(key, n) {
    var d = parseDay(key);
    d.setDate(d.getDate() + n);
    return dayKey(d);
  }
  function isDayKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  var fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  var fmtLong = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  var fmtShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' });
  var fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  var fmtStamp = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  var fmtDayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var fmtDayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  var fmtDayAgenda = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  function formatBytes(n) {
    if (!isFinite(n)) return '–';
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function sentence(parts) {
    if (parts.length <= 1) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    return Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
  }

  function photosOf(note) { return (note && Array.isArray(note.photos)) ? note.photos : []; }
  function hasPhotos(note) { return photosOf(note).length > 0; }
  function audioOf(note) { return (note && Array.isArray(note.audio)) ? note.audio : []; }
  function hasAudio(note) { return audioOf(note).length > 0; }
  // Photo and voice notes can do without text: the text is their caption.
  function hasMedia(note) { return hasPhotos(note) || hasAudio(note); }

  /* ---------------- Install screen vs app ---------------- */

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true;
  }

  /* ---------------- Header & day page ---------------- */

  function renderHeader() {
    var today = todayKey();
    var date = parseDay(state.day);
    var label = fmtLong.format(date);
    if (state.day === today) label = 'Today, ' + fmtShort.format(date);
    else if (state.day === addDays(today, -1)) label = 'Yesterday, ' + fmtShort.format(date);
    else if (state.day === addDays(today, 1)) label = 'Tomorrow, ' + fmtShort.format(date);
    $('weekday').textContent = fmtWeekday.format(date);
    $('fulldate').textContent = label;
    $('date-picker').value = state.day;
    $('go-today').hidden = state.day === today;
    $('capture-text').placeholder = state.day === today ? 'Write a note' : 'Add a note to ' + fmtShort.format(date);
    document.title = state.day === today ? 'Daybook' : 'Daybook – ' + fmtShort.format(date);
  }

  function thumbUrl(id) {
    if (state.thumbUrls.has(id)) return state.thumbUrls.get(id);
    var m = state.media.get(id);
    if (!m || !m.thumb) return null;
    var url = URL.createObjectURL(m.thumb);
    state.thumbUrls.set(id, url);
    return url;
  }

  function resetThumbUrls() {
    state.thumbUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.thumbUrls = new Map();
  }

  function photosElement(note) {
    var photos = photosOf(note);
    var wrap = document.createElement('div');
    wrap.className = 'note-photos' + (photos.length === 1 ? ' is-single' : '');
    photos.forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'note-photo';
      b.style.setProperty('--r', (p.w && p.h ? p.w / p.h : 4 / 3).toFixed(4));
      var url = thumbUrl(p.id);
      if (url) {
        b.setAttribute('aria-label', photos.length === 1 ? 'Open photo' : 'Open photo ' + (i + 1) + ' of ' + photos.length);
        var img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.width = p.w || 4;
        img.height = p.h || 3;
        img.src = url;
        b.appendChild(img);
        b.addEventListener('click', function () { openViewer(note.id, i); });
      } else {
        b.classList.add('is-missing');
        b.disabled = true;
        var span = document.createElement('span');
        span.textContent = 'Photo missing';
        b.appendChild(span);
      }
      wrap.appendChild(b);
    });
    return wrap;
  }

  // Text with its #hashtags as tappable chips. Newlines are kept by the page's pre-wrap style.
  function appendWithTags(el, text) {
    Lines.segments(text).forEach(function (s) {
      if (!s.tag) { el.appendChild(document.createTextNode(s.text)); return; }
      // An inline span (not a button) so the highlight wraps the word without changing the line height.
      var chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = s.text;
      chip.tabIndex = 0;
      chip.setAttribute('role', 'button');
      chip.setAttribute('aria-label', 'Notes tagged ' + s.text);
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openTagSearch(s.tag);
      });
      chip.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openTagSearch(s.tag); }
      });
      el.appendChild(chip);
    });
  }

  // A to-do note: every line on its own ruled line, boxes you can tick in place.
  function fillChecklist(el, note) {
    Lines.parse(note.text).forEach(function (p) {
      var row = document.createElement('div');
      if (!p.todo) {
        row.className = 'line';
        appendWithTags(row, p.body);
        el.appendChild(row);
        return;
      }
      row.className = 'todo' + (p.done ? ' is-done' : '');
      if (p.indent) row.style.paddingLeft = Math.min(4, p.indent.replace(/\t/g, '  ').length) * 0.5 + 'em';
      var box = document.createElement('button');
      box.type = 'button';
      box.className = 'todo-box';
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-checked', p.done ? 'true' : 'false');
      box.setAttribute('aria-label', p.body.trim() || 'Empty to-do');
      box.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleTodo(note.id, p.line);
      });
      var text = document.createElement('span');
      text.className = 'todo-text';
      appendWithTags(text, p.body);
      row.appendChild(box);
      row.appendChild(text);
      el.appendChild(row);
    });
  }

  function noteElement(note) {
    var art = document.createElement('article');
    art.className = 'note' + (note.pinned ? ' is-pinned' : '');

    var margin = document.createElement('div');
    margin.className = 'note-margin';
    var time = document.createElement('time');
    time.className = 'note-time';
    time.dateTime = new Date(note.createdAt).toISOString();
    time.textContent = fmtTime.format(note.createdAt);
    margin.appendChild(time);
    var checklist = Lines.isChecklist(note.text);
    if (checklist) {
      var c = Lines.counts(note.text);
      if (c.total > 1) {
        var progress = document.createElement('span');
        progress.className = 'note-progress' + (c.done === c.total ? ' is-complete' : '');
        progress.textContent = c.done + ' of ' + c.total;
        progress.setAttribute('aria-label', c.done + ' of ' + c.total + ' done');
        margin.appendChild(progress);
      }
    }
    if (note.pinned) {
      var pin = document.createElement('span');
      pin.className = 'note-pin';
      pin.setAttribute('role', 'img');
      pin.setAttribute('aria-label', 'Pinned');
      margin.appendChild(pin);
    }

    var body = document.createElement('div');
    body.className = 'note-body';
    if (hasPhotos(note)) body.appendChild(photosElement(note));
    if (hasAudio(note)) body.appendChild(voiceElement(note));

    var target;
    if (note.text || !hasMedia(note)) {
      target = document.createElement('div');
      target.className = 'note-text note-edit-target' + (checklist ? ' is-checklist' : '');
      target.tabIndex = 0;
      target.setAttribute('aria-roledescription', 'note');
      target.title = 'Tap to edit';
      if (checklist) fillChecklist(target, note);
      else appendWithTags(target, note.text);
      target.addEventListener('keydown', function (e) {
        if (e.target !== target) return; // a tick box or tag has its own keys
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(note.id); }
      });
    } else {
      target = document.createElement('button');
      target.type = 'button';
      target.className = 'note-caption-add note-edit-target';
      target.textContent = 'Add a caption';
    }
    target.addEventListener('click', function (e) {
      if (e.target.closest('.tag, .todo-box')) return;
      startEdit(note.id);
    });
    body.appendChild(target);

    art.appendChild(margin);
    art.appendChild(body);
    return art;
  }

  // Pinned notes first, then the rest, each in the order they were written.
  function pageOrder(notes) {
    return notes.filter(function (n) { return n.pinned; })
      .concat(notes.filter(function (n) { return !n.pinned; }));
  }

  function renderNotes() {
    var list = $('notes');
    list.textContent = '';
    state.els = new Map();
    var order = pageOrder(state.notes);
    var pinnedCount = order.filter(function (n) { return n.pinned; }).length;
    order.forEach(function (note, i) {
      var el = noteElement(note);
      // A short dashed rule in the blank line between the pinned notes and the rest.
      if (pinnedCount && i === pinnedCount) el.classList.add('after-pins');
      state.els.set(note.id, el);
      list.appendChild(el);
    });
    var empty = $('empty');
    if (state.notes.length) {
      empty.hidden = true;
    } else {
      empty.hidden = false;
      var today = todayKey();
      if (state.day === today) empty.textContent = 'Nothing written yet today. Type below to start the page.';
      else if (state.day > today) empty.textContent = 'Nothing planned for this day yet.';
      else empty.textContent = 'No notes on this day.';
    }
    if (player.clipId) syncPlayerUI();
  }

  function loadDay(direction) {
    var seq = ++state.loadSeq;
    state.followToday = state.day === todayKey();
    renderHeader();
    var notes;
    return DB.notesForDay(state.day).then(function (list) {
      notes = list;
      var ids = [];
      notes.forEach(function (n) { DB.mediaIdsOf(n).forEach(function (id) { ids.push(id); }); });
      return DB.getMedia(ids);
    }).then(function (media) {
      if (seq !== state.loadSeq) return;
      resetThumbUrls();
      stopPlayback();
      state.notes = notes;
      state.media = media;
      renderNotes();
      refreshLookBack();
      refreshPlanned();
      if (direction) {
        turnPage(direction);
        window.scrollTo(0, 0);
      }
    });
  }

  function turnPage(direction) {
    if (reduceMotion.matches) return;
    var sheet = $('sheet-turn');
    sheet.classList.remove('enter-next', 'enter-prev');
    void sheet.offsetWidth; // restart the animation
    sheet.classList.add(direction > 0 ? 'enter-next' : 'enter-prev');
  }

  function goTo(day, direction) {
    if (!isDayKey(day)) return Promise.resolve();
    return commitEdit().then(function () {
      if (day === state.day) return;
      var dir = direction || (day > state.day ? 1 : -1);
      state.day = day;
      return loadDay(dir);
    });
  }

  function step(n) {
    return goTo(addDays(state.day, n), n);
  }

  function scrollToEnd() {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  function flashNote(id) {
    var el = state.els.get(id);
    if (el && !reduceMotion.matches) el.classList.add('is-flash');
  }

  // Scrolls a note into view and marks it briefly, as if with a highlighter.
  function revealNote(id) {
    var el = state.els.get(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('is-found');
    void el.offsetWidth; // restart the animation
    el.classList.add('is-found');
    var target = el.querySelector('.note-edit-target');
    if (target) target.focus({ preventScroll: true });
  }

  /* ---------------- Quick capture ---------------- */

  function autosizeCapture() {
    var el = $('capture-text');
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 2) + 'px';
  }

  // With nothing typed, the microphone takes the Add button's place (like a messaging app).
  function updateAddButton() {
    var empty = !$('capture-text').value.trim();
    $('capture-add').disabled = empty;
    var mic = empty && voiceAvailable() && !state.storageBroken;
    $('capture-voice').hidden = !mic;
    $('capture-add').hidden = mic;
  }

  function saveDraftSoon() {
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(saveDraftNow, 400);
  }

  function saveDraftNow() {
    clearTimeout(state.draftTimer);
    var text = $('capture-text').value;
    return DB.setMeta('draft', text.trim() ? text : '').catch(function () {});
  }

  function restoreDraft() {
    return DB.getMeta('draft').then(function (text) {
      if (text && !$('capture-text').value) {
        $('capture-text').value = text;
        autosizeCapture();
        updateAddButton();
      }
    }).catch(function () {});
  }

  function setCapture(text) {
    $('capture-text').value = text;
    autosizeCapture();
    updateAddButton();
  }

  function cleanText(text) {
    return Lines.tidy(String(text).replace(/^\s*\n/, '').replace(/\s+$/, '')).replace(/\s+$/, '');
  }

  function addNote() {
    var input = $('capture-text');
    var original = input.value;
    var text = cleanText(original);
    if (!text.trim()) return Promise.resolve();
    var now = Date.now();
    var note = { id: newId(), day: state.day, createdAt: now, updatedAt: now, type: 'text', text: text };
    // Clear straight away so anything typed next isn't wiped when the save finishes.
    setCapture('');
    return DB.putNote(note).then(function () {
      saveDraftNow();
      if (note.day === state.day) {
        state.notes.push(note);
        renderNotes();
        flashNote(note.id);
        scrollToEnd();
      }
      requestPersist();
      refreshNudge();
    }).catch(function () {
      if (!input.value) setCapture(original);
      toast('Couldn’t save that note. Your text is back in the box.');
    });
  }

  /* ---------------- Photo notes ---------------- */

  function pickPhotos() {
    if (state.addingPhotos) return;
    commitEdit().then(function () { $('photo-input').click(); });
  }

  // Turns the chosen photos into one note. Any text in the note box becomes its caption.
  function addPhotos(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length || state.addingPhotos) return Promise.resolve();
    state.addingPhotos = true;
    $('capture-photo').disabled = true;
    toast(files.length === 1 ? 'Adding photo…' : 'Adding ' + files.length + ' photos…');

    var day = state.day;
    var now = Date.now();
    var noteId = newId();
    var caption = cleanText($('capture-text').value);
    var records = [];
    var failed = 0;

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return Photos.processFile(file).then(function (r) {
          records.push({
            id: newId(), noteId: noteId, blob: r.blob, thumb: r.thumb, type: 'image/jpeg',
            width: r.width, height: r.height, bytes: r.blob.size, createdAt: now
          });
        }, function () { failed += 1; });
      });
    });

    return chain.then(function () {
      if (!records.length) {
        toast(failed > 1 ? 'Couldn’t read those photos. Try different ones.' : 'Couldn’t read that photo. Try a different one.');
        return;
      }
      var note = {
        id: noteId, day: day, createdAt: now, updatedAt: now, type: 'photo', text: caption,
        photos: records.map(function (r) { return { id: r.id, w: r.width, h: r.height }; })
      };
      return DB.addNoteWithMedia(note, records).then(function () {
        if (caption && cleanText($('capture-text').value) === caption) {
          setCapture('');
          saveDraftNow();
        }
        records.forEach(function (r) { state.media.set(r.id, r); });
        if (note.day === state.day) {
          state.notes.push(note);
          renderNotes();
          flashNote(note.id);
          scrollToEnd();
        }
        if (failed) toast(plural(failed, 'photo', 'photos') + ' couldn’t be read and ' + (failed === 1 ? 'was' : 'were') + ' left out.');
        else hideToast();
        requestPersist();
        refreshNudge();
      });
    }).catch(function () {
      toast('Couldn’t save the photo. Try again.');
    }).then(function () {
      state.addingPhotos = false;
      $('capture-photo').disabled = false;
    });
  }

  /* ---------------- Voice notes ---------------- */

  var MAX_RECORDING_S = 60 * 60; // an hour, then it saves by itself
  var RATES = [1, 1.5, 2];
  var player = { audio: null, clipId: null, noteId: null, url: null, rate: 1, seekTo: null, dragging: null };

  var VOICE_ICONS = {
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    pause: '<path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor"/>'
  };

  function clipDuration(clip) {
    var a = player.audio;
    if (player.clipId === clip.id && a && isFinite(a.duration) && a.duration > 0) return a.duration;
    return clip.dur || 0;
  }

  function rateLabel(r) { return String(r).replace('.5', '½') + '×'; }

  function voiceElement(note) {
    var wrap = document.createElement('div');
    wrap.className = 'note-voice';
    audioOf(note).forEach(function (clip) {
      var row = document.createElement('div');
      row.className = 'voice';
      row.setAttribute('data-clip', clip.id);
      var have = state.media.has(clip.id);

      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'voice-play';
      play.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + VOICE_ICONS.play + '</svg>';
      play.setAttribute('aria-label', 'Play voice note, ' + Voice.formatDuration(clip.dur));

      var seek = document.createElement('input');
      seek.type = 'range';
      seek.className = 'voice-seek';
      seek.min = '0';
      seek.max = String(Math.max(0.1, clip.dur || 0));
      seek.step = '0.1';
      seek.value = '0';
      seek.setAttribute('aria-label', 'Position in voice note');
      seek.setAttribute('aria-valuetext', '0:00 of ' + Voice.formatDuration(clip.dur));

      var time = document.createElement('span');
      time.className = 'voice-time';
      time.textContent = Voice.formatDuration(clip.dur);

      var rate = document.createElement('button');
      rate.type = 'button';
      rate.className = 'voice-rate';
      rate.textContent = rateLabel(player.rate);
      rate.setAttribute('aria-label', 'Playback speed ' + player.rate + ' times');

      if (!have) {
        row.classList.add('is-missing');
        play.disabled = true;
        seek.disabled = true;
        rate.disabled = true;
        time.textContent = 'Recording missing';
      } else {
        play.addEventListener('click', function () { playClip(note.id, clip.id); });
        seek.addEventListener('input', function () {
          player.dragging = clip.id;
          time.textContent = Voice.formatDuration(+seek.value) + ' / ' + Voice.formatDuration(clipDuration(clip));
        });
        seek.addEventListener('change', function () {
          player.dragging = null;
          seekClip(note.id, clip.id, +seek.value);
        });
        rate.addEventListener('click', cycleRate);
      }

      row.appendChild(play);
      row.appendChild(seek);
      row.appendChild(time);
      row.appendChild(rate);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function findClip(clipId) {
    for (var i = 0; i < state.notes.length; i++) {
      var list = audioOf(state.notes[i]);
      for (var j = 0; j < list.length; j++) if (list[j].id === clipId) return list[j];
    }
    return null;
  }

  // Puts a recording into the shared player (without playing it).
  function loadClip(noteId, clipId) {
    if (player.clipId === clipId && player.audio) return player.audio;
    stopPlayback();
    var m = state.media.get(clipId);
    if (!m || !m.blob) return null;
    var a = new Audio();
    a.preload = 'auto';
    player.audio = a;
    player.clipId = clipId;
    player.noteId = noteId;
    player.url = URL.createObjectURL(m.blob);
    ['play', 'pause', 'timeupdate', 'durationchange'].forEach(function (ev) { a.addEventListener(ev, syncPlayerUI); });
    a.addEventListener('loadedmetadata', function () {
      if (player.audio !== a) return;
      if (player.seekTo != null) {
        try { a.currentTime = player.seekTo; } catch (e) { /* not seekable yet */ }
        player.seekTo = null;
      }
      syncPlayerUI();
    });
    a.addEventListener('ended', function () {
      if (player.audio !== a) return;
      try { a.currentTime = 0; } catch (e) { /* fine */ }
      syncPlayerUI();
    });
    a.addEventListener('error', function () {
      if (player.audio !== a) return;
      stopPlayback();
      toast('Couldn’t play this recording on this iPhone.');
    });
    a.src = player.url;
    a.playbackRate = player.rate;
    return a;
  }

  function playClip(noteId, clipId) {
    var a = player.clipId === clipId ? player.audio : null;
    if (a && !a.paused) { a.pause(); return; }
    a = a || loadClip(noteId, clipId);
    if (!a) return;
    a.playbackRate = player.rate;
    var p = a.play();
    if (p && p.catch) {
      p.catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (player.audio === a) stopPlayback();
        toast('Couldn’t play this recording.');
      });
    }
    syncPlayerUI();
  }

  function seekClip(noteId, clipId, seconds) {
    var a = loadClip(noteId, clipId);
    if (!a) return;
    if (a.readyState >= 1) {
      try { a.currentTime = seconds; } catch (e) { /* ignore */ }
    } else {
      player.seekTo = seconds;
    }
    syncPlayerUI();
  }

  function cycleRate() {
    var i = RATES.indexOf(player.rate);
    player.rate = RATES[(i + 1) % RATES.length];
    if (player.audio) player.audio.playbackRate = player.rate;
    syncPlayerUI();
  }

  function stopPlayback() {
    var a = player.audio;
    player.audio = null;
    player.clipId = null;
    player.noteId = null;
    player.seekTo = null;
    if (a) {
      try { a.pause(); } catch (e) { /* fine */ }
      a.removeAttribute('src');
      try { a.load(); } catch (e) { /* fine */ }
    }
    if (player.url) URL.revokeObjectURL(player.url);
    player.url = null;
    syncPlayerUI();
  }

  // Brings every voice row on the page in line with the player.
  function syncPlayerUI() {
    var rows = document.querySelectorAll('#notes .voice');
    Array.prototype.forEach.call(rows, function (row) {
      var id = row.getAttribute('data-clip');
      var clip = findClip(id);
      if (!clip || row.classList.contains('is-missing')) return;
      var play = row.querySelector('.voice-play');
      var seek = row.querySelector('.voice-seek');
      var time = row.querySelector('.voice-time');
      var rate = row.querySelector('.voice-rate');
      var active = player.clipId === id && player.audio;
      var playing = !!(active && !player.audio.paused && !player.audio.ended);
      var dur = clipDuration(clip);
      var cur = active ? (player.seekTo != null ? player.seekTo : player.audio.currentTime || 0) : 0;
      row.classList.toggle('is-playing', playing);
      row.classList.toggle('is-active', !!active);
      play.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + (playing ? VOICE_ICONS.pause : VOICE_ICONS.play) + '</svg>';
      play.setAttribute('aria-label', (playing ? 'Pause' : 'Play') + ' voice note, ' + Voice.formatDuration(dur));
      seek.max = String(Math.max(0.1, dur));
      if (player.dragging !== id) {
        seek.value = String(Math.min(cur, dur));
        time.textContent = active && (cur > 0 || playing)
          ? Voice.formatDuration(cur) + ' / ' + Voice.formatDuration(dur)
          : Voice.formatDuration(dur);
      }
      seek.style.setProperty('--p', dur ? Math.min(100, (cur / dur) * 100).toFixed(2) + '%' : '0%');
      seek.setAttribute('aria-valuetext', Voice.formatDuration(cur) + ' of ' + Voice.formatDuration(dur));
      rate.textContent = rateLabel(player.rate);
      rate.setAttribute('aria-label', 'Playback speed ' + player.rate + ' times');
    });
  }

  function audioExtension(type) {
    if (/mp4|aac|m4a/.test(type)) return 'm4a';
    if (/webm/.test(type)) return 'webm';
    if (/ogg/.test(type)) return 'ogg';
    return 'audio';
  }

  // Opens the share sheet with the recording (e.g. Save to Files). Only ever on a tap.
  function shareRecording(id) {
    var note = findNote(id);
    var clip = audioOf(note)[0];
    var m = clip && state.media.get(clip.id);
    if (!m || !m.blob) { toast('This recording isn’t on this iPhone.'); return; }
    var d = new Date(note.createdAt);
    var type = m.type || m.blob.type || 'audio/mp4';
    var name = 'daybook-voice-' + note.day + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.' + audioExtension(type);
    var file = new File([m.blob], name, { type: type });
    if (canShareFile(file)) {
      navigator.share({ files: [file] }).catch(function (err) {
        if (!err || err.name !== 'AbortError') downloadFile(file);
      });
    } else {
      downloadFile(file);
    }
  }

  /* Recording */

  function voiceAvailable() { return !!(Voice && Voice.supported()); }

  var RECORD_ERRORS = {
    denied: 'Daybook isn’t allowed to use the microphone. To allow it, open the Settings app, find Daybook or Safari, and turn on Microphone. Then try again.',
    'no-mic': 'No microphone was found.',
    unsupported: 'Recording isn’t available on this device.',
    failed: 'The microphone couldn’t be started. Try again.'
  };

  function buildMeter() {
    var meter = $('recorder-meter');
    if (meter.childNodes.length) return;
    for (var i = 0; i < 32; i++) {
      var bar = document.createElement('span');
      meter.appendChild(bar);
    }
  }

  function setRecorderView(mode) {
    var dlg = $('recorder');
    dlg.classList.toggle('is-live', mode === 'live');
    $('recorder-stop').disabled = mode !== 'live';
  }

  function openRecorder() {
    if (state.recorder || !voiceAvailable()) return;
    var dlg = $('recorder');
    stopPlayback();
    buildMeter();
    Array.prototype.forEach.call($('recorder-meter').childNodes, function (b) { b.style.transform = 'scaleY(0.06)'; });
    $('recorder-time').textContent = '0:00';
    $('recorder-status').textContent = 'Starting the microphone…';
    setError('recorder-error');
    setRecorderView('waiting');
    var rec = { handle: null, day: state.day, startedAt: Date.now(), timer: null, levels: [], wake: null, done: false };
    state.recorder = rec;
    if (!dlg.open) dlg.showModal();
    $('recorder-cancel').focus();

    // Ask straight away, while still inside the tap.
    Voice.start().then(function (handle) {
      if (state.recorder !== rec) { handle.cancel(); return; }
      rec.handle = handle;
      rec.startedAt = Date.now();
      handle.onend = function (result) {
        if (state.recorder === rec) finishRecording(rec, result, 'The recording was interrupted. What was recorded has been kept.');
      };
      $('recorder-status').textContent = 'Recording';
      setRecorderView('live');
      $('recorder-stop').focus();
      keepAwake(rec);
      rec.timer = setInterval(function () { tickRecorder(rec); }, 90);
    }).catch(function (err) {
      if (state.recorder !== rec) return;
      $('recorder-status').textContent = 'Not recording';
      setError('recorder-error', RECORD_ERRORS[err && err.code] || RECORD_ERRORS.failed);
      state.recorder = null;
    });
  }

  function keepAwake(rec) {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (lock) {
          if (state.recorder === rec) rec.wake = lock;
          else lock.release().catch(function () {});
        }).catch(function () {});
      }
    } catch (e) { /* the screen may lock; recording then stops and is kept */ }
  }

  function tickRecorder(rec) {
    if (!rec.handle || state.recorder !== rec) return;
    var t = rec.handle.elapsed();
    $('recorder-time').textContent = Voice.formatDuration(t);
    rec.levels.push(rec.handle.level());
    if (rec.levels.length > 32) rec.levels.shift();
    var bars = $('recorder-meter').childNodes;
    var offset = bars.length - rec.levels.length;
    for (var i = 0; i < bars.length; i++) {
      var v = i >= offset ? rec.levels[i - offset] : 0;
      bars[i].style.transform = 'scaleY(' + Math.max(0.06, v).toFixed(3) + ')';
    }
    if (t >= MAX_RECORDING_S) stopRecorder('That’s an hour, so the recording stopped and was saved.');
  }

  function stopRecorder(message) {
    var rec = state.recorder;
    if (!rec || !rec.handle || rec.done) return Promise.resolve();
    $('recorder-status').textContent = 'Saving…';
    setRecorderView('waiting');
    return rec.handle.stop().then(function (result) { return finishRecording(rec, result, message); });
  }

  function cancelRecorder() {
    var rec = state.recorder;
    if (!rec) { $('recorder').close(); return; }
    if (rec.handle && rec.handle.elapsed() > 5 && !window.confirm('Throw away this recording?')) return;
    endRecorder(rec);
    if (rec.handle) rec.handle.cancel();
    $('recorder').close();
  }

  function endRecorder(rec) {
    rec.done = true;
    clearInterval(rec.timer);
    if (rec.wake) rec.wake.release().catch(function () {});
    rec.wake = null;
    if (state.recorder === rec) state.recorder = null;
  }

  function finishRecording(rec, result, message) {
    if (rec.done) return Promise.resolve();
    endRecorder(rec);
    var dlg = $('recorder');
    if (dlg.open) dlg.close();
    if (!result || !result.blob || !result.blob.size) {
      toast('Nothing was recorded. Try again, holding the iPhone a little closer.');
      return Promise.resolve();
    }
    var noteId = newId();
    var clipId = newId();
    var now = Date.now();
    var dur = Math.round(result.duration * 10) / 10;
    var record = {
      id: clipId, noteId: noteId, kind: 'audio', blob: result.blob, type: result.type,
      duration: dur, bytes: result.blob.size, createdAt: now
    };
    var note = {
      id: noteId, day: rec.day, createdAt: rec.startedAt, updatedAt: now, type: 'voice', text: '',
      audio: [{ id: clipId, dur: dur, mime: result.type }]
    };
    return DB.addNoteWithMedia(note, [record]).then(function () {
      state.media.set(clipId, record);
      if (note.day === state.day) {
        state.notes.push(note);
        state.notes.sort(function (a, b) { return a.createdAt - b.createdAt; });
        renderNotes();
        flashNote(note.id);
        var el = state.els.get(note.id);
        if (el) el.scrollIntoView({ block: 'nearest' });
      }
      toast(message || 'Voice note saved (' + Voice.formatDuration(dur) + ')');
      requestPersist();
      refreshNudge();
    }).catch(function () {
      toast('Couldn’t save the recording. The iPhone may be short of space.');
    });
  }

  function bindRecorder() {
    var dlg = $('recorder');
    $('capture-voice').addEventListener('click', function () {
      commitEdit().then(openRecorder);
    });
    $('recorder-stop').addEventListener('click', function () { stopRecorder(); });
    $('recorder-cancel').addEventListener('click', cancelRecorder);
    // Escape (or a swipe-down gesture) mustn't throw a recording away by accident.
    dlg.addEventListener('cancel', function (e) {
      e.preventDefault();
      if (!state.recorder) dlg.close();
    });
    dlg.addEventListener('close', function () {
      var rec = state.recorder;
      if (rec && !rec.handle) endRecorder(rec); // closed while still asking for the microphone
    });
  }

  /* ---------------- Editing ---------------- */

  function findNote(id) {
    for (var i = 0; i < state.notes.length; i++) if (state.notes[i].id === id) return state.notes[i];
    return null;
  }

  function sizeEditor(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(1, Math.ceil(ta.scrollHeight / LINE)) * LINE + 'px';
  }

  function startEdit(id) {
    if (state.editing && state.editing.id === id) return;
    commitEdit().then(function () {
      var note = findNote(id);
      var art = state.els.get(id);
      if (!note || !art) return;
      var target = art.querySelector('.note-edit-target');
      if (!target) return;

      var wrap = document.createElement('div');
      var ta = document.createElement('textarea');
      ta.className = 'note-editor';
      ta.value = note.text;
      ta.rows = 1;
      ta.setAttribute('aria-label', hasMedia(note) ? 'Caption' : 'Edit note');
      if (hasMedia(note)) ta.placeholder = 'Caption';

      var meta = document.createElement('p');
      meta.className = 'edit-meta';
      var written = 'Written ' + fmtStamp.format(note.createdAt);
      meta.textContent = note.updatedAt - note.createdAt > 60000
        ? written + ', edited ' + fmtStamp.format(note.updatedAt)
        : written;

      var actions = document.createElement('div');
      actions.className = 'edit-actions';
      actions.appendChild(iconButton(ICONS.trash, 'Delete note', 'edit-icon btn-danger', function () { deleteNote(id); }));
      var todoBtn = iconButton(ICONS.todo, 'Make this line a to-do', 'edit-icon edit-todo', function () { toggleTodoLine(ta); });
      keepFocus(todoBtn);
      actions.appendChild(todoBtn);
      var pinBtn = iconButton(ICONS.pin, note.pinned ? 'Unpin' : 'Pin to the top of the day', 'edit-icon edit-pin', function () { togglePin(id); });
      pinBtn.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
      actions.appendChild(pinBtn);
      if (hasAudio(note)) {
        actions.appendChild(iconButton(ICONS.share, 'Save or share the recording', 'edit-icon edit-share', function () { shareRecording(id); }));
      }
      var spacer = document.createElement('span');
      spacer.className = 'spacer';
      actions.appendChild(spacer);
      actions.appendChild(button('Cancel', 'btn btn-quiet', cancelEdit));
      actions.appendChild(button('Save', 'btn btn-primary', function () { commitEdit(); }));

      wrap.appendChild(ta);
      wrap.appendChild(meta);
      wrap.appendChild(actions);
      target.parentNode.replaceChild(wrap, target);

      state.editing = { id: id, before: Object.assign({}, note), textarea: ta };
      document.body.classList.add('is-editing');

      ta.addEventListener('input', function () { sizeEditor(ta); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); return; }
        listKeydown(e);
      });
      sizeEditor(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  var ICONS = {
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 10.5v6M13.5 10.5v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    todo: '<rect x="4.5" y="4.5" width="15" height="15" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.3 12.2l2.6 2.6 5-5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    share: '<path d="M12 3.5v11M8 7.5l4-4 4 4M7 11H5.5v9h13v-9H17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    pin: '<circle cx="12" cy="8.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 13v7.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
  };

  function iconButton(svg, label, className, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn ' + className;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + svg + '</svg>';
    b.addEventListener('click', onClick);
    return b;
  }

  function button(label, className, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function closeEditor() {
    state.editing = null;
    document.body.classList.remove('is-editing');
    renderNotes();
  }

  function cancelEdit() {
    if (!state.editing) return;
    closeEditor();
  }

  // Saves the open edit, if any. Resolves once it's safely stored.
  function commitEdit() {
    var ed = state.editing;
    if (!ed) return Promise.resolve();
    var note = findNote(ed.id);
    var text = cleanText(ed.textarea.value);
    if (!note) { closeEditor(); return Promise.resolve(); }
    if (!text.trim()) {
      if (hasMedia(note)) {
        text = ''; // a photo or voice note can do without a caption
      } else {
        state.editing = null;
        document.body.classList.remove('is-editing');
        return deleteNote(ed.id);
      }
    }
    if (text === note.text) { closeEditor(); return Promise.resolve(); }
    var before = ed.before;
    var updated = Object.assign({}, note, { text: text, updatedAt: Date.now() });
    return DB.putNote(updated).then(function () {
      replaceNoteInState(updated);
      closeEditor();
      toast(hasMedia(note) ? 'Caption updated' : 'Note updated', function () {
        return DB.putNote(before).then(function () { replaceNoteInState(before); renderNotes(); });
      });
    }).catch(function () {
      toast('Couldn’t save that change. Try again.');
    });
  }

  function replaceNoteInState(note) {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === note.id) { state.notes[i] = note; return; }
    }
  }

  function deleteNote(id, message) {
    var note = findNote(id);
    if (!note) return Promise.resolve();
    var copy = Object.assign({}, note);
    if (player.noteId === id) stopPlayback();
    return DB.deleteNote(note).then(function () {
      state.notes = state.notes.filter(function (n) { return n.id !== id; });
      state.editing = null;
      document.body.classList.remove('is-editing');
      renderNotes();
      refreshNudge();
      toast(message || 'Note deleted', function () {
        return DB.restoreNote(copy).then(function () {
          if (copy.day === state.day) return loadDay();
        }).then(refreshNudge);
      });
    }).catch(function () {
      toast('Couldn’t delete that note. Try again.');
    });
  }

  /* ---------------- To-dos and pins ---------------- */

  // Redraws one note in place, keeping the rest of the page (and its scroll position) as it is.
  function redrawNote(note) {
    var old = state.els.get(note.id);
    if (!old) { renderNotes(); return; }
    var el = noteElement(note);
    if (old.classList.contains('after-pins')) el.classList.add('after-pins');
    old.parentNode.replaceChild(el, old);
    state.els.set(note.id, el);
    return el;
  }

  function toggleTodo(id, line) {
    var run = state.editing ? commitEdit() : Promise.resolve();
    return run.then(function () {
      var note = findNote(id);
      if (!note) return;
      var text = Lines.toggle(note.text, line);
      if (text === note.text) return;
      var updated = Object.assign({}, note, { text: text, updatedAt: Date.now() });
      replaceNoteInState(updated);
      var el = redrawNote(updated);
      var box = el && el.querySelectorAll('.todo-box')[todoPosition(updated.text, line)];
      if (box) box.focus({ preventScroll: true });
      var before = Lines.counts(note.text);
      var after = Lines.counts(text);
      if (after.total > 1 && after.done === after.total && before.done < before.total) toast('All done. Nicely ticked off.');
      return DB.putNote(updated).catch(function () {
        replaceNoteInState(note);
        redrawNote(note);
        toast('Couldn’t save that tick. Try again.');
      });
    });
  }

  // Which tick box (0, 1, ...) belongs to a given line of the text.
  function todoPosition(text, line) {
    var n = 0;
    var parsed = Lines.parse(text);
    for (var i = 0; i < line && i < parsed.length; i++) if (parsed[i].todo) n += 1;
    return n;
  }

  // Pins a note to the top of its day, or unpins it. Saves any edit to its text first.
  function togglePin(id) {
    var ed = state.editing && state.editing.id === id ? state.editing : null;
    var note = findNote(id);
    if (!note) return Promise.resolve();
    var text = ed ? cleanText(ed.textarea.value) : note.text;
    if (ed && !text.trim() && !hasMedia(note)) text = note.text; // don't lose a note by pinning it empty
    var updated = Object.assign({}, note, { text: text, updatedAt: Date.now() });
    if (note.pinned) delete updated.pinned;
    else updated.pinned = true;
    // Undo only takes the pin back; a text change saved along with it stays.
    var before = Object.assign({}, updated);
    if (note.pinned) before.pinned = true;
    else delete before.pinned;
    return DB.putNote(updated).then(function () {
      replaceNoteInState(updated);
      state.editing = null;
      document.body.classList.remove('is-editing');
      renderNotes();
      var el = state.els.get(id);
      if (el && updated.pinned) el.scrollIntoView({ block: 'nearest' });
      flashNote(id);
      toast(updated.pinned ? 'Pinned to the top of the day' : 'Unpinned', function () {
        before.updatedAt = Date.now();
        return DB.putNote(before).then(function () { replaceNoteInState(before); renderNotes(); });
      });
    }).catch(function () {
      toast('Couldn’t save that change. Try again.');
    });
  }

  function openTagSearch(tag) {
    commitEdit().then(function () {
      $('search-input').value = '#' + tag;
      if (isSearchOpen()) { renderSearch(); $('search-input').blur(); }
      else openSearch(false);
    });
  }

  // The to-do button and Return in the note box and the editor.
  function applyEdit(ta, r) {
    ta.value = r.value;
    ta.setSelectionRange(r.cursor, r.cursor);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function toggleTodoLine(ta) {
    applyEdit(ta, Lines.toggleMarker(ta.value, ta.selectionStart));
    ta.focus();
  }

  function listKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    var ta = e.target;
    var r = Lines.enterAt(ta.value, ta.selectionStart, ta.selectionEnd);
    if (!r) return;
    e.preventDefault();
    applyEdit(ta, r);
  }

  // A button that works on a text box without taking the keyboard away from it.
  function keepFocus(btn) {
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  }

  /* ---------------- Toast with undo ---------------- */

  function toast(text, undoFn) {
    var el = $('toast');
    $('toast-text').textContent = text;
    $('toast-undo').hidden = !undoFn;
    state.undo = undoFn || null;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, undoFn ? 6000 : 3500);
  }

  function hideToast() {
    $('toast').hidden = true;
    state.undo = null;
  }

  /* ---------------- Full-screen photo viewer ---------------- */

  function viewerNote() { return findNote(viewer.noteId); }

  function openViewer(noteId, index) {
    commitEdit().then(function () {
      if (!findNote(noteId)) return;
      viewer.noteId = noteId;
      var dlg = $('viewer');
      if (!dlg.open) dlg.showModal();
      showPhoto(index);
      $('viewer-close').focus();
    });
  }

  function closeViewer() {
    var dlg = $('viewer');
    if (dlg.open) dlg.close();
  }

  function clearViewer() {
    if (viewer.url) URL.revokeObjectURL(viewer.url);
    viewer.url = null;
    viewer.noteId = null;
    viewer.zoom = 1;
    $('viewer-img').removeAttribute('src');
  }

  function showPhoto(index) {
    var note = viewerNote();
    var photos = photosOf(note);
    if (!photos.length) { closeViewer(); return; }
    index = Math.max(0, Math.min(photos.length - 1, index));
    viewer.index = index;
    var p = photos[index];
    var m = state.media.get(p.id);
    if (viewer.url) URL.revokeObjectURL(viewer.url);
    viewer.url = m ? URL.createObjectURL(m.blob) : null;
    viewer.ratio = (p.w && p.h) ? p.w / p.h : 4 / 3;
    var img = $('viewer-img');
    img.alt = note.text ? note.text : 'Photo';
    if (viewer.url) img.src = viewer.url; else img.removeAttribute('src');

    $('viewer-count').textContent = photos.length > 1 ? (index + 1) + ' of ' + photos.length : '';
    var many = photos.length > 1;
    $('viewer-prev').hidden = !many;
    $('viewer-next').hidden = !many;
    $('viewer-prev').disabled = index === 0;
    $('viewer-next').disabled = index === photos.length - 1;
    $('viewer-caption').textContent = note.text || '';
    $('viewer-when').textContent = fmtStamp.format(note.createdAt);
    $('viewer-share').disabled = !m;
    // A button that just became disabled (e.g. Next on the last photo) loses focus; keep it in the viewer.
    var active = document.activeElement;
    if (!active || active === document.body || active.disabled) {
      var other = index === 0 ? $('viewer-next') : $('viewer-prev');
      (many && !other.disabled ? other : $('viewer-close')).focus();
    }
    viewer.zoom = 1;
    layoutViewer();
  }

  function layoutViewer() {
    var stage = $('viewer-stage');
    var sw = stage.clientWidth;
    var sh = stage.clientHeight;
    if (!sw || !sh) return;
    var w = sw;
    var h = sw / viewer.ratio;
    if (h > sh) { h = sh; w = sh * viewer.ratio; }
    viewer.fitW = w;
    viewer.fitH = h;
    applyZoom();
  }

  function applyZoom() {
    var img = $('viewer-img');
    img.style.width = Math.round(viewer.fitW * viewer.zoom) + 'px';
    img.style.height = Math.round(viewer.fitH * viewer.zoom) + 'px';
    var zoomed = viewer.zoom > 1.01;
    $('viewer-stage').classList.toggle('is-zoomed', zoomed);
    $('viewer-stage').parentNode.classList.toggle('is-zoomed', zoomed);
  }

  // Zooms while keeping the point (cx, cy), in stage coordinates, under the finger.
  function zoomTo(z, cx, cy) {
    var stage = $('viewer-stage');
    var img = $('viewer-img');
    z = Math.max(1, Math.min(4, z));
    var oldW = img.offsetWidth || 1;
    var oldH = img.offsetHeight || 1;
    var fx = (stage.scrollLeft + cx - img.offsetLeft) / oldW;
    var fy = (stage.scrollTop + cy - img.offsetTop) / oldH;
    viewer.zoom = z;
    applyZoom();
    stage.scrollLeft = fx * img.offsetWidth + img.offsetLeft - cx;
    stage.scrollTop = fy * img.offsetHeight + img.offsetTop - cy;
  }

  function toggleZoomAt(clientX, clientY) {
    var r = $('viewer-stage').getBoundingClientRect();
    zoomTo(viewer.zoom > 1.01 ? 1 : 2.5, clientX - r.left, clientY - r.top);
  }

  function bindViewer() {
    var dlg = $('viewer');
    var stage = $('viewer-stage');
    dlg.addEventListener('close', clearViewer);
    $('viewer-close').addEventListener('click', closeViewer);
    $('viewer-prev').addEventListener('click', function () { showPhoto(viewer.index - 1); });
    $('viewer-next').addEventListener('click', function () { showPhoto(viewer.index + 1); });
    $('viewer-share').addEventListener('click', shareViewerPhoto);
    $('viewer-delete').addEventListener('click', deleteViewerPhoto);
    // On the document, not the dialog, so the keys still work if focus has dropped to the page.
    document.addEventListener('keydown', function (e) {
      if (!dlg.open || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); showPhoto(viewer.index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); showPhoto(viewer.index + 1); }
    });
    stage.addEventListener('dblclick', function (e) { toggleZoomAt(e.clientX, e.clientY); });

    // Touch: pinch to zoom, double-tap to zoom, swipe to the next photo.
    var t = { mode: null };
    var lastTap = { time: 0, x: 0, y: 0 };
    function distance(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        t = { mode: 'pinch', d: distance(e.touches[0], e.touches[1]), z: viewer.zoom };
      } else if (e.touches.length === 1 && t.mode !== 'pinch') {
        var p = e.touches[0];
        t = { mode: 'one', x: p.clientX, y: p.clientY, time: Date.now(), moved: false };
      }
    }, { passive: false });
    stage.addEventListener('touchmove', function (e) {
      if (t.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        var a = e.touches[0];
        var b = e.touches[1];
        var r = stage.getBoundingClientRect();
        zoomTo(t.z * distance(a, b) / (t.d || 1), (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top);
      } else if (t.mode === 'one' && e.touches.length === 1) {
        var p = e.touches[0];
        if (Math.abs(p.clientX - t.x) > 10 || Math.abs(p.clientY - t.y) > 10) t.moved = true;
      }
    }, { passive: false });
    stage.addEventListener('touchend', function (e) {
      if (t.mode === 'pinch') {
        if (e.touches.length === 0) {
          if (viewer.zoom < 1.05) { viewer.zoom = 1; applyZoom(); }
          t = { mode: null };
        }
        return;
      }
      if (t.mode !== 'one' || e.touches.length) return;
      var p = e.changedTouches[0];
      var dx = p.clientX - t.x;
      var dy = p.clientY - t.y;
      var quick = Date.now() - t.time < 600;
      if (!t.moved && quick) {
        var now = Date.now();
        if (now - lastTap.time < 320 && Math.abs(p.clientX - lastTap.x) < 40 && Math.abs(p.clientY - lastTap.y) < 40) {
          e.preventDefault();
          toggleZoomAt(p.clientX, p.clientY);
          lastTap.time = 0;
        } else {
          lastTap = { time: now, x: p.clientX, y: p.clientY };
        }
      } else if (viewer.zoom <= 1.01 && quick && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        showPhoto(viewer.index + (dx < 0 ? 1 : -1));
      } else if (viewer.zoom <= 1.01 && quick && dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) {
        closeViewer(); // swipe down to close
      }
      t = { mode: null };
    });
  }

  function canShareFile(file) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (err) { return false; }
  }

  function downloadFile(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // Opens the share sheet with the full photo (Save Image puts it in Photos). Only ever on a tap.
  function shareViewerPhoto() {
    var note = viewerNote();
    var p = photosOf(note)[viewer.index];
    var m = p && state.media.get(p.id);
    if (!m) return;
    var file = new File([m.blob], 'daybook-' + note.day + '-' + (viewer.index + 1) + '.jpg', { type: m.type || 'image/jpeg' });
    if (canShareFile(file)) {
      navigator.share({ files: [file] }).catch(function (err) {
        if (!err || err.name !== 'AbortError') downloadFile(file);
      });
    } else {
      downloadFile(file);
    }
  }

  function deleteViewerPhoto() {
    var note = viewerNote();
    var photos = photosOf(note);
    var p = photos[viewer.index];
    if (!p) return;
    closeViewer();
    var remaining = photos.filter(function (x) { return x.id !== p.id; });
    if (!remaining.length && !note.text.trim()) {
      deleteNote(note.id, 'Photo deleted');
      return;
    }
    var before = Object.assign({}, note);
    var updated = Object.assign({}, note, { photos: remaining, type: remaining.length ? 'photo' : 'text', updatedAt: Date.now() });
    DB.updateNoteAndTrash(updated, [p.id]).then(function () {
      replaceNoteInState(updated);
      renderNotes();
      toast('Photo deleted', function () {
        return DB.restoreNote(before).then(function () {
          if (before.day === state.day) return loadDay();
        });
      });
    }).catch(function () {
      toast('Couldn’t delete that photo. Try again.');
    });
  }

  /* ---------------- Search and looking back ---------------- */

  function isSearchOpen() { return !$('search').hidden; }

  // Whole days from `day` to today (positive means in the past).
  function daysAgo(day) {
    return Math.round((parseDay(todayKey()) - parseDay(day)) / DAY_MS);
  }

  function relativeDay(day) {
    var n = daysAgo(day);
    if (n === 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n === -1) return 'Tomorrow';
    if (n < 0) return 'In ' + plural(-n, 'day', 'days');
    if (n < 7) return n + ' days ago';
    if (n < 31) { var w = Math.floor(n / 7); return w === 1 ? 'A week ago' : w + ' weeks ago'; }
    var a = parseDay(day);
    var b = parseDay(todayKey());
    var months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0);
    months = Math.max(1, months);
    if (months < 12) return months === 1 ? 'A month ago' : months + ' months ago';
    var years = Math.floor(months / 12);
    return years === 1 ? 'A year ago' : years + ' years ago';
  }

  function monthBefore(key) {
    var d = parseDay(key);
    var y = d.getFullYear();
    var m = d.getMonth() - 1;
    if (m < 0) { m = 11; y -= 1; }
    var last = new Date(y, m + 1, 0).getDate();
    return dayKey(new Date(y, m, Math.min(d.getDate(), last), 12));
  }

  // The same date in another year, or null (29 February only exists in leap years).
  function sameDateIn(key, year) {
    var d = parseDay(key);
    var c = new Date(year, d.getMonth(), d.getDate(), 12);
    return c.getMonth() === d.getMonth() ? dayKey(c) : null;
  }

  /*
   * Days worth looking back at, each with its notes: this date in every earlier
   * year, and (when asked) a week ago and a month ago. Only days with notes.
   */
  function lookBackDays(includeRecent) {
    var today = todayKey();
    return DB.earliestDay().then(function (first) {
      if (!first || first >= today) return [];
      var list = [];
      if (includeRecent) {
        list.push({ day: addDays(today, -7), label: 'A week ago' });
        list.push({ day: monthBefore(today), label: 'A month ago' });
      }
      var year = parseDay(today).getFullYear();
      for (var y = year - 1; y >= +first.slice(0, 4); y--) {
        var k = sameDateIn(today, y);
        if (k) list.push({ day: k, label: year - y === 1 ? 'A year ago' : (year - y) + ' years ago', year: true });
      }
      return DB.notesForDays(list.map(function (x) { return x.day; })).then(function (found) {
        return list.filter(function (x) {
          return found.get(x.day) && found.get(x.day).length;
        }).map(function (x) {
          return { day: x.day, label: x.label, year: !!x.year, notes: found.get(x.day) };
        });
      });
    });
  }

  function excerptOf(note) {
    var text = Lines.display(String(note.text || '').trim()).split('\n')[0];
    if (text) return text;
    if (hasAudio(note)) return 'A voice note, ' + Voice.formatDuration(audioOf(note)[0].dur);
    var n = photosOf(note).length;
    return n === 1 ? 'A photo' : n + ' photos';
  }

  // The "On this day" slip on today's page, when earlier years have notes on this date.
  function refreshLookBack() {
    var slip = $('look-back');
    var today = todayKey();
    if (state.day !== today) { slip.hidden = true; return Promise.resolve(); }
    return Promise.all([DB.getMeta('lookBackHiddenDay'), lookBackDays(false)]).then(function (r) {
      if (state.day !== today) return;
      var years = r[1];
      var show = years.length > 0 && r[0] !== today;
      slip.hidden = !show;
      if (!show) return;
      var count = 0;
      years.forEach(function (g) { count += g.notes.length; });
      var names = years.map(function (g) { return g.day.slice(0, 4); }).reverse();
      $('look-back-title').textContent = 'On this day in ' + sentence(names);
      // The most recent year's first note, then how many more Look back will show.
      $('look-back-excerpt').textContent = excerptOf(years[0].notes[0]);
      $('look-back-more').textContent = count > 1 ? 'and ' + plural(count - 1, 'more note', 'more notes') : '';
      alignToRules(slip);
    }).catch(function () { slip.hidden = true; });
  }

  function openSearch(focusInput) {
    if (isSearchOpen()) return;
    closeViewer();
    closeAgenda(false);
    state.search.index = null;
    state.search.sorted = null;
    state.search.collection = null;
    $('search-status').textContent = '';
    $('search-results').textContent = '';
    $('search-tags').hidden = true;
    $('search-collections').hidden = true;
    $('collection-head').hidden = true;
    $('search').hidden = false;
    $('search').scrollTop = 0;
    $('search-clear').hidden = !$('search-input').value;
    // Focus while still inside the tap, or iOS won't bring up the keyboard.
    if (focusInput === false) $('close-search').focus();
    else $('search-input').focus();
    commitEdit().then(function () {
      return DB.allNotes();
    }).then(function (notes) {
      if (!isSearchOpen()) return;
      state.search.index = Search.buildIndex(notes);
      state.search.tags = Lines.tagIndex(notes);
      state.search.sorted = Collections.sort(notes);
      return renderSearch();
    }).catch(function () {
      setSearchStatus(['Couldn’t read your notes to search them. Close Daybook fully and open it again.']);
    });
  }

  function closeSearch(restoreFocus) {
    if (!isSearchOpen()) return;
    clearTimeout(state.search.timer);
    state.search.seq += 1;
    state.search.index = null;
    state.search.sorted = null;
    state.search.collection = null;
    $('search-input').blur();
    $('search').hidden = true;
    clearSearchThumbs();
    $('search-results').textContent = '';
    if (restoreFocus) $('open-search').focus();
  }

  function clearSearchThumbs() {
    state.search.urls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.search.urls = [];
  }

  function setSearchStatus(lines) {
    var el = $('search-status');
    el.textContent = '';
    lines.forEach(function (line) {
      var p = document.createElement('p');
      p.textContent = line;
      el.appendChild(p);
    });
  }

  function searchSoon() {
    if ($('search-input').value.trim()) state.search.collection = null;
    $('search-clear').hidden = !$('search-input').value;
    clearTimeout(state.search.timer);
    state.search.timer = setTimeout(renderSearch, 120);
  }

  function renderSearch() {
    clearTimeout(state.search.timer);
    var index = state.search.index;
    if (!index) return Promise.resolve();
    var seq = ++state.search.seq;
    var query = $('search-input').value;
    $('search-clear').hidden = !query;
    var r = Search.run(index, query);
    if (r.terms.length) state.search.collection = null;
    var inCollection = !r.terms.length && !!state.search.collection;
    $('collection-head').hidden = !inCollection;
    drawTags(r.terms.length || inCollection ? [] : state.search.tags || []);
    drawCollectionGrid(!r.terms.length && !inCollection);
    if (inCollection) return renderCollection(seq);
    if (!r.terms.length) return renderLookBackView(seq);

    if (!r.notes.length) {
      setSearchStatus([
        'No notes match “' + query.trim() + '”.',
        'Search finds notes and photo captions that contain every word you type, in any order.'
      ]);
      return drawGroups([], r.terms, seq);
    }
    var days = new Set(r.notes.map(function (n) { return n.day; })).size;
    var shown = r.notes.slice(0, MAX_RESULTS);
    if (shown.length < r.notes.length) {
      setSearchStatus(['The newest ' + shown.length + ' of ' + r.notes.length + ' matching notes are shown. Add another word to narrow it down.']);
    } else {
      setSearchStatus([plural(r.notes.length, 'note', 'notes') + ' on ' + plural(days, 'day', 'days')]);
    }
    return drawGroups(Search.groupByDay(shown), r.terms, seq);
  }

  function renderLookBackView(seq) {
    return lookBackDays(true).then(function (groups) {
      if (seq !== state.search.seq) return;
      setSearchStatus(['Type to search, or open a collection.']);
      return drawGroups(groups, [], seq);
    });
  }

  // Every #tag used in any note, as chips above the looking-back list.
  function drawTags(list) {
    var box = $('search-tags');
    var chips = $('search-tag-list');
    chips.textContent = '';
    box.hidden = !list.length;
    list.slice(0, 40).forEach(function (t) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-pill';
      chip.textContent = '#' + t.tag;
      var n = document.createElement('span');
      n.className = 'tag-count';
      n.textContent = String(t.count);
      chip.appendChild(n);
      chip.setAttribute('aria-label', '#' + t.tag + ', ' + plural(t.count, 'note', 'notes'));
      chip.addEventListener('click', function () { openTagSearch(t.tag); });
      chips.appendChild(chip);
    });
  }

  function appendMarked(el, text, ranges) {
    var at = 0;
    ranges.forEach(function (r) {
      if (r[0] > at) el.appendChild(document.createTextNode(text.slice(at, r[0])));
      var mark = document.createElement('mark');
      mark.textContent = text.slice(r[0], r[1]);
      el.appendChild(mark);
      at = r[1];
    });
    if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
  }

  function resultItem(note, terms, thumbs, kind) {
    var li = document.createElement('li');
    var found = kind ? Collections.find(kind, Lines.display(note.text)) : [];
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'result';

    var time = document.createElement('time');
    time.className = 'result-time';
    time.dateTime = new Date(note.createdAt).toISOString();
    time.textContent = fmtTime.format(note.createdAt);

    var text = document.createElement('span');
    text.className = 'result-text';
    if (String(note.text || '').trim()) {
      var shown = Lines.display(note.text);
      var sn = found.length
        ? Search.snippetAt(shown, found.map(function (f) { return [f.start, f.end]; }))
        : Search.snippet(shown, terms);
      if (sn.cutStart) text.appendChild(document.createTextNode('…'));
      appendMarked(text, sn.text, sn.ranges);
    } else {
      text.classList.add('is-quiet');
      text.textContent = excerptOf(note);
    }
    b.appendChild(time);
    b.appendChild(text);

    var photo = photosOf(note)[0];
    if (photo) {
      b.classList.add('has-thumb');
      var img = document.createElement('img');
      img.className = 'result-thumb';
      img.alt = '';
      img.width = 48;
      img.height = 48;
      img.decoding = 'async';
      b.appendChild(img);
      thumbs.push({ img: img, id: photo.id });
    }
    b.addEventListener('click', function () { openResult(note.day, note.id); });
    li.appendChild(b);
    var actions = actionLinks(kind, found);
    if (actions) { li.appendChild(actions); li.className = 'has-actions'; }
    return li;
  }

  function drawGroups(groups, terms, seq, kind) {
    var out = $('search-results');
    clearSearchThumbs();
    out.textContent = '';
    var thumbs = [];
    groups.forEach(function (g) {
      var section = document.createElement('section');
      section.className = 'result-day';
      var h = document.createElement('h3');
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'result-day-head';
      var date = document.createElement('span');
      date.className = 'result-date';
      date.textContent = fmtDayLong.format(parseDay(g.day));
      var ago = document.createElement('span');
      ago.className = 'result-ago';
      ago.textContent = g.label || relativeDay(g.day);
      head.appendChild(date);
      head.appendChild(ago);
      head.addEventListener('click', function () { openResult(g.day, null); });
      h.appendChild(head);
      section.appendChild(h);
      var list = document.createElement('ol');
      list.className = 'result-list';
      g.notes.forEach(function (note) { list.appendChild(resultItem(note, terms, thumbs, kind)); });
      section.appendChild(list);
      out.appendChild(section);
    });
    if (!thumbs.length) return Promise.resolve();
    return DB.getMedia(thumbs.map(function (t) { return t.id; })).then(function (media) {
      if (seq !== state.search.seq || !isSearchOpen()) return;
      thumbs.forEach(function (t) {
        var m = media.get(t.id);
        if (!m || !m.thumb) { t.img.classList.add('is-missing'); return; }
        var url = URL.createObjectURL(m.thumb);
        state.search.urls.push(url);
        t.img.src = url;
      });
    }).catch(function () {});
  }

  /* ---------------- Smart collections ---------------- */

  var ACTION_VERB = { links: 'Open', emails: 'Email', phones: 'Call', places: 'Maps' };

  // Taps for what a collection found: open a link, call, email, look up in Apple Maps.
  // These are ordinary links the person chooses to tap; Daybook itself sends nothing.
  function actionLinks(kind, found) {
    if (!ACTION_VERB[kind] || !found.length) return null;
    var row = document.createElement('div');
    row.className = 'result-actions';
    var seen = new Set();
    found.forEach(function (f) {
      if (!f.href || seen.has(f.href) || seen.size >= 3) return;
      seen.add(f.href);
      var a = document.createElement('a');
      a.className = 'action-chip';
      a.href = f.href;
      if (kind === 'links' || kind === 'places') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      var verb = document.createElement('span');
      verb.className = 'action-verb';
      verb.textContent = ACTION_VERB[kind];
      var what = document.createElement('span');
      what.className = 'action-what';
      what.textContent = kind === 'links' ? f.value.replace(/^https?:\/\//i, '').replace(/^www\./i, '') : f.value;
      a.appendChild(verb);
      a.appendChild(what);
      a.setAttribute('aria-label', ACTION_VERB[kind] + ' ' + f.value);
      row.appendChild(a);
    });
    return row;
  }

  function collectionInfo(kind) {
    for (var i = 0; i < Collections.kinds.length; i++) if (Collections.kinds[i].kind === kind) return Collections.kinds[i];
    return null;
  }

  // The contents page: every collection with how many notes are in it.
  function drawCollectionGrid(show) {
    var box = $('search-collections');
    var grid = $('collection-grid');
    var sorted = state.search.sorted;
    box.hidden = !show || !sorted;
    if (box.hidden) return;
    grid.textContent = '';
    Collections.kinds.forEach(function (k) {
      var n = (sorted.get(k.kind) || []).length;
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'collection-tile collection-' + k.kind;
      b.disabled = n === 0;
      var name = document.createElement('span');
      name.className = 'collection-name';
      name.textContent = k.label;
      var count = document.createElement('span');
      count.className = 'collection-count';
      count.textContent = n ? String(n) : '–';
      var hint = document.createElement('span');
      hint.className = 'collection-hint';
      hint.textContent = n ? k.hint : 'None yet';
      b.appendChild(name);
      b.appendChild(count);
      b.appendChild(hint);
      b.setAttribute('aria-label', k.label + ', ' + (n ? plural(n, 'note', 'notes') : 'none yet'));
      b.addEventListener('click', function () { openCollection(k.kind); });
      li.appendChild(b);
      grid.appendChild(li);
    });
  }

  function openCollection(kind) {
    state.search.collection = kind;
    $('search-input').value = '';
    $('search-clear').hidden = true;
    $('search-input').blur();
    $('search').scrollTop = 0;
    renderSearch();
    $('collection-title').focus();
  }

  function closeCollection() {
    state.search.collection = null;
    $('search').scrollTop = 0;
    renderSearch();
    $('collection-back').blur();
  }

  var COLLECTION_EMPTY = {
    todos: 'Every box is ticked. Nice.'
  };

  function renderCollection(seq) {
    var kind = state.search.collection;
    var info = collectionInfo(kind);
    var notes = (state.search.sorted && state.search.sorted.get(kind)) || [];
    $('collection-title').textContent = info ? info.label : '';
    if (!notes.length) {
      setSearchStatus([COLLECTION_EMPTY[kind] || 'Nothing here any more.']);
      return drawGroups([], [], seq);
    }
    var days = new Set(notes.map(function (n) { return n.day; })).size;
    var shown = notes.slice(0, MAX_RESULTS);
    var line = plural(notes.length, 'note', 'notes') + ' on ' + plural(days, 'day', 'days');
    if (kind === 'todos') {
      var open = 0;
      notes.forEach(function (n) { open += Lines.counts(n.text).total - Lines.counts(n.text).done; });
      line = plural(open, 'box', 'boxes') + ' to tick in ' + plural(notes.length, 'note', 'notes');
    }
    setSearchStatus(shown.length < notes.length
      ? [line + '. The newest ' + shown.length + ' are shown.']
      : [line]);
    return drawGroups(Search.groupByDay(shown), [], seq, kind);
  }

  // Opens a day from the results, scrolled to the note that was tapped.
  function openResult(day, id) {
    closeSearch(false);
    goTo(day).then(function () {
      if (id) revealNote(id);
      else window.scrollTo(0, 0);
    });
  }

  function bindSearch() {
    var input = $('search-input');
    $('open-search').addEventListener('click', function () { openSearch(true); });
    $('close-search').addEventListener('click', function () { closeSearch(true); });
    input.addEventListener('input', searchSoon);
    input.addEventListener('keydown', function (e) {
      // Search runs as you type; the keyboard's Search key just tucks the keyboard away.
      if (e.key === 'Enter') { e.preventDefault(); renderSearch(); input.blur(); }
    });
    $('collection-back').addEventListener('click', closeCollection);
    $('search-clear').addEventListener('click', function () {
      input.value = '';
      renderSearch();
      input.focus();
    });
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (state.search.collection && !$('search-input').value.trim()) closeCollection();
        else closeSearch(true);
      }
    });
    $('look-back-open').addEventListener('click', function () {
      $('search-input').value = '';
      openSearch(false);
    });
    $('look-back-hide').addEventListener('click', function () {
      $('look-back').hidden = true;
      DB.setMeta('lookBackHiddenDay', todayKey()).catch(function () {});
    });
  }

  /* ---------------- Agenda: dates found in notes ---------------- */

  // Any change to the notes means the agenda must be worked out again.
  function watchWrites() {
    ['putNote', 'addNoteWithMedia', 'deleteNote', 'updateNoteAndTrash', 'restoreNote', 'applyMerge'].forEach(function (name) {
      var original = DB[name];
      if (typeof original !== 'function') return;
      DB[name] = function () {
        state.agenda.stamp += 1;
        return original.apply(DB, arguments).then(function (r) {
          state.agenda.stamp += 1;
          return r;
        }, function (err) {
          state.agenda.stamp += 1;
          throw err;
        });
      };
    });
  }

  function agendaItems() {
    var a = state.agenda;
    if (a.items && a.builtAt === a.stamp) return Promise.resolve(a.items);
    var stamp = a.stamp;
    return DB.allNotes().then(function (notes) {
      var items = Agenda.build(notes);
      if (stamp === a.stamp) { a.items = items; a.builtAt = stamp; }
      return items;
    });
  }

  function isAgendaOpen() { return !$('agenda').hidden; }

  function nowTime() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function timeLabel(hhmm) {
    var d = new Date(2000, 0, 1, +hhmm.slice(0, 2), +hhmm.slice(3, 5));
    return fmtTime.format(d);
  }

  function agendaDayLabel(day) {
    var n = -daysAgo(day);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n < 0) return relativeDay(day);
    if (n < 7) return 'In ' + n + ' days';
    if (n < 14) return 'Next week';
    if (n < 60) return 'In ' + Math.round(n / 7) + ' weeks';
    var months = Math.round(n / 30.4);
    if (months < 12) return 'In ' + months + ' months';
    return n < 548 ? 'In a year' : 'In ' + Math.round(n / 365) + ' years';
  }

  // One line of the agenda: the time in the margin, the words with the date marked.
  function agendaRow(item, showFrom) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'result agenda-item';
    var today = todayKey();
    if (item.date < today || (item.date === today && item.time && item.time < nowTime())) b.classList.add('is-past');

    var time = document.createElement('span');
    time.className = 'result-time agenda-time';
    time.textContent = item.time ? timeLabel(item.time) : 'all day';
    if (!item.time) time.classList.add('is-allday');

    var text = document.createElement('span');
    text.className = 'result-text';
    appendMarked(text, item.text, item.marks);
    b.appendChild(time);
    b.appendChild(text);

    if (showFrom && item.noteDay !== item.date) {
      var from = document.createElement('span');
      from.className = 'agenda-from';
      from.textContent = 'Written ' + fmtDayShort.format(parseDay(item.noteDay));
      b.appendChild(from);
    }
    b.setAttribute('aria-label', (item.time ? timeLabel(item.time) + ', ' : 'All day, ') + item.text +
      (item.noteDay !== item.date ? ', written ' + fmtShort.format(parseDay(item.noteDay)) : ''));
    b.addEventListener('click', function () { openAgendaItem(item); });
    li.appendChild(b);
    return li;
  }

  function openAgenda() {
    if (isAgendaOpen()) return;
    closeViewer();
    closeSearch(false);
    state.agenda.earlier = false;
    $('agenda-list').textContent = '';
    $('agenda-status').textContent = '';
    $('agenda').hidden = false;
    $('agenda').scrollTop = 0;
    $('close-agenda').focus();
    commitEdit().then(renderAgenda).catch(function () {
      $('agenda-status').textContent = 'Couldn’t read your notes. Close Daybook fully and open it again.';
    });
  }

  function closeAgenda(restoreFocus) {
    if (!isAgendaOpen()) return;
    state.agenda.seq += 1;
    $('agenda').hidden = true;
    $('agenda-list').textContent = '';
    if (restoreFocus) $('open-agenda').focus();
  }

  var AGENDA_MAX = 200;
  var AGENDA_EARLIER_DAYS = 14;

  function renderAgenda() {
    var seq = ++state.agenda.seq;
    return agendaItems().then(function (items) {
      if (seq !== state.agenda.seq || !isAgendaOpen()) return;
      var today = todayKey();
      var from = state.agenda.earlier ? addDays(today, -AGENDA_EARLIER_DAYS) : today;
      var shown = items.filter(function (it) { return it.date >= from; });
      var upcoming = shown.filter(function (it) { return it.date >= today; }).length;
      var cut = shown.length > AGENDA_MAX;
      shown = shown.slice(0, AGENDA_MAX);

      var status = $('agenda-status');
      status.textContent = '';
      var p = document.createElement('p');
      if (!items.length) {
        p.textContent = 'Nothing yet. Write a day or a time in any note, like “dentist Fri 3pm” or “Mum’s birthday 12 Dec”, and it shows up here.';
      } else if (!upcoming) {
        p.textContent = 'Nothing coming up.';
      } else {
        var week = shown.filter(function (it) { return it.date >= today && it.date < addDays(today, 7); }).length;
        p.textContent = week
          ? plural(week, 'thing', 'things') + ' in the next 7 days' + (upcoming > week ? ', ' + (upcoming - week) + ' later' : '')
          : 'Nothing in the next 7 days, ' + upcoming + ' later';
        if (cut) p.textContent += '. The first ' + AGENDA_MAX + ' are shown.';
      }
      status.appendChild(p);

      var out = $('agenda-list');
      out.textContent = '';
      var groups = [];
      shown.forEach(function (it) {
        var g = groups[groups.length - 1];
        if (!g || g.day !== it.date) { g = { day: it.date, items: [] }; groups.push(g); }
        g.items.push(it);
      });
      groups.forEach(function (g) {
        var section = document.createElement('section');
        section.className = 'result-day agenda-day' + (g.day === today ? ' is-today' : '') + (g.day < today ? ' is-earlier' : '');
        var h = document.createElement('h3');
        var head = document.createElement('button');
        head.type = 'button';
        head.className = 'result-day-head';
        var date = document.createElement('span');
        date.className = 'result-date';
        date.textContent = (g.day.slice(0, 4) === today.slice(0, 4) ? fmtDayAgenda : fmtDayLong).format(parseDay(g.day));
        var ago = document.createElement('span');
        ago.className = 'result-ago';
        ago.textContent = agendaDayLabel(g.day);
        head.appendChild(date);
        head.appendChild(ago);
        head.setAttribute('aria-label', 'Open ' + fmtDayLong.format(parseDay(g.day)));
        head.addEventListener('click', function () { closeAgenda(false); goTo(g.day).then(function () { window.scrollTo(0, 0); }); });
        h.appendChild(head);
        section.appendChild(h);
        var list = document.createElement('ol');
        list.className = 'result-list';
        g.items.forEach(function (it) { list.appendChild(agendaRow(it, true)); });
        section.appendChild(list);
        out.appendChild(section);
      });

      var more = $('agenda-earlier');
      more.hidden = !items.some(function (it) { return it.date < today && it.date >= addDays(today, -AGENDA_EARLIER_DAYS); }) && !state.agenda.earlier;
      more.textContent = state.agenda.earlier ? 'Hide the last two weeks' : 'Show the last two weeks';
      more.setAttribute('aria-expanded', state.agenda.earlier ? 'true' : 'false');
    });
  }

  function openAgendaItem(item) {
    closeAgenda(false);
    goTo(item.noteDay).then(function () { revealNote(item.noteId); });
  }

  // "Planned for this day": dates in notes written on other days that point at this page.
  function refreshPlanned() {
    var slip = $('planned');
    var day = state.day;
    var seq = ++state.agenda.plannedSeq;
    return agendaItems().then(function (items) {
      if (seq !== state.agenda.plannedSeq || state.day !== day) return;
      var here = items.filter(function (it) { return it.date === day && it.noteDay !== day; });
      // One line per note is plenty here.
      var seen = new Set();
      here = here.filter(function (it) { if (seen.has(it.noteId)) return false; seen.add(it.noteId); return true; });
      slip.hidden = !here.length;
      if (!here.length) return;
      $('planned-title').textContent = day === todayKey() ? 'Planned for today' : 'Planned for this day';
      var list = $('planned-list');
      list.textContent = '';
      here.slice(0, 3).forEach(function (it) {
        var li = agendaRow(it, false);
        li.firstChild.classList.remove('result', 'agenda-item');
        li.firstChild.classList.add('planned-item');
        var from = document.createElement('span');
        from.className = 'agenda-from';
        from.textContent = 'from ' + fmtDayShort.format(parseDay(it.noteDay));
        li.firstChild.appendChild(from);
        list.appendChild(li);
      });
      var rest = here.length - 3;
      $('planned-more').hidden = rest <= 0;
      $('planned-more').textContent = rest > 0 ? 'and ' + rest + ' more in Coming up' : '';
      alignToRules(slip);
    }).catch(function () { slip.hidden = true; });
  }

  function bindAgenda() {
    $('open-agenda').addEventListener('click', openAgenda);
    $('close-agenda').addEventListener('click', function () { closeAgenda(true); });
    $('agenda-earlier').addEventListener('click', function () {
      state.agenda.earlier = !state.agenda.earlier;
      renderAgenda();
    });
    $('agenda').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeAgenda(true); }
    });
    $('planned-more').addEventListener('click', openAgenda);
  }

  /* ---------------- Swipe between days ---------------- */

  function bindSwipe() {
    var start = null;
    document.addEventListener('touchstart', function (e) {
      if (state.editing || e.touches.length !== 1) { start = null; return; }
      if (e.target.closest('.capture, dialog, .settings, .search, textarea, input, .nudge')) { start = null; return; }
      var t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, time: Date.now() };
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!start) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - start.x;
      var dy = t.clientY - start.y;
      var quick = Date.now() - start.time < 800;
      start = null;
      if (quick && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('touchcancel', function () { start = null; }, { passive: true });
  }

  /* ---------------- Keyboard (on-screen keyboard and hardware keys) ---------------- */

  function trackOnScreenKeyboard() {
    var vv = window.visualViewport;
    if (!vv) return;
    function update() {
      var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (kb < 60) kb = 0;
      document.documentElement.style.setProperty('--kb', Math.round(kb) + 'px');
      document.body.classList.toggle('kb-open', kb > 0);
    }
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (document.querySelector('dialog[open]') || !$('settings').hidden || isSearchOpen() || isAgendaOpen()) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 't') { e.preventDefault(); goTo(todayKey()); }
      else if (e.key === '/') { e.preventDefault(); openSearch(true); }
      else if (e.key === 'a') { e.preventDefault(); openAgenda(); }
    });
  }

  /* ---------------- Storage ---------------- */

  function requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persisted().then(function (yes) {
      return yes || navigator.storage.persist();
    }).catch(function () { return false; });
  }

  /* ---------------- Backup reminder ---------------- */

  function refreshNudge() {
    return Promise.all([
      DB.countNotes(), DB.getMeta('lastBackupAt'), DB.getMeta('nudgeSnoozedUntil')
    ]).then(function (r) {
      var count = r[0], last = r[1], snooze = r[2];
      var now = Date.now();
      var text = '';
      if (count > 0 && !last) {
        text = 'Your notes exist only on this iPhone. Make a backup so they’re safe if the app or phone is lost.';
      } else if (count > 0 && now - last > BACKUP_EVERY_DAYS * DAY_MS) {
        var days = Math.floor((now - last) / DAY_MS);
        text = 'Your last backup was ' + days + ' days ago. Make a fresh one to keep recent notes safe.';
      }
      var nudge = $('backup-nudge');
      var show = !!text && !(snooze && snooze > now);
      nudge.hidden = !show;
      if (show) {
        $('backup-nudge-text').textContent = text;
        alignToRules(nudge);
      }
    }).catch(function () {});
  }

  // Keep the notes below sitting on the ruled lines.
  function alignToRules(el) {
    if (el.hidden) return;
    el.style.marginBottom = '0px';
    var h = el.getBoundingClientRect().height;
    var extra = Math.ceil(h / LINE) * LINE - h;
    el.style.marginBottom = (extra + LINE) + 'px';
  }

  /* ---------------- Settings ---------------- */

  function openSettings() {
    commitEdit().then(function () {
      $('settings').hidden = false;
      $('close-settings').focus();
      refreshSettings();
    });
  }

  function closeSettings() {
    $('settings').hidden = true;
    $('open-settings').focus();
  }

  function refreshSettings() {
    $('fact-version').textContent = APP_VERSION;
    DB.countNotes().then(function (n) { $('fact-notes').textContent = String(n); }).catch(function () {});
    DB.countMediaKinds().then(function (n) {
      $('fact-photos').textContent = String(n.photos);
      $('fact-voice').textContent = String(n.audio);
    }).catch(function () {});
    DB.getMeta('lastBackupAt').then(function (last) {
      $('last-backup').textContent = last ? 'Last backup: ' + fmtStamp.format(last) : 'You haven’t made a backup yet.';
    }).catch(function () {});
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        $('fact-space').textContent = formatBytes(est.usage || 0);
      }).catch(function () { $('fact-space').textContent = 'Unknown'; });
    } else {
      $('fact-space').textContent = 'Unknown';
    }
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) {
        $('fact-persist').textContent = p ? 'Yes' : 'Not confirmed';
      }).catch(function () { $('fact-persist').textContent = 'Unknown'; });
    } else {
      $('fact-persist').textContent = 'Unknown';
    }
  }

  /* ---------------- Dialog helpers ---------------- */

  function showStep(dialog, name) {
    Array.prototype.forEach.call(dialog.querySelectorAll('[data-step]'), function (el) {
      el.hidden = el.getAttribute('data-step') !== name;
    });
  }

  function setError(id, text) {
    var el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
  }

  // "3 photos and 2 voice recordings" for a list of media records.
  function mediaParts(list) {
    var audio = list.filter(DB.isAudio).length;
    var photos = list.length - audio;
    var parts = [];
    if (photos) parts.push(plural(photos, 'photo', 'photos'));
    if (audio) parts.push(plural(audio, 'voice recording', 'voice recordings'));
    return parts;
  }

  function contentsPhrase(notes, media) {
    return sentence([plural(notes, 'note', 'notes')].concat(mediaParts(media || [])));
  }

  /* ---------------- Back up ---------------- */

  function openBackup() {
    var dlg = $('backup-dialog');
    state.backupFile = null;
    $('backup-pass').value = '';
    $('backup-pass2').value = '';
    setError('backup-error');
    setError('backup-save-error');
    showStep(dlg, 'password');
    dlg.showModal();
    $('backup-pass').focus();
  }

  function encryptBackup(e) {
    e.preventDefault();
    var p1 = $('backup-pass').value;
    var p2 = $('backup-pass2').value;
    if (p1.length < 8) return setError('backup-error', 'Use at least 8 characters.');
    if (p1 !== p2) return setError('backup-error', 'The two passwords don’t match.');
    setError('backup-error');
    $('backup-pass').value = '';
    $('backup-pass2').value = '';
    var dlg = $('backup-dialog');
    showStep(dlg, 'working');

    DB.exportAll().then(function (all) {
      var what = contentsPhrase(all.notes.length, all.media);
      $('backup-working').textContent = 'Encrypting ' + what + '…';
      var data = {
        format: 'daybook-backup',
        appVersion: APP_VERSION,
        schemaVersion: DB.SCHEMA_VERSION,
        exportedAt: Date.now(),
        notes: all.notes,
        media: all.media
      };
      return Backup.encrypt(data, p1).then(function (bytes) {
        var name = 'daybook-' + todayKey() + '.daybook';
        state.backupFile = new File([bytes], name, { type: 'application/octet-stream' });
        $('backup-ready-text').textContent = 'Your backup of ' + what + ' is ready (' + formatBytes(bytes.byteLength) + ').';
        showStep(dlg, 'ready');
        $('backup-save').focus();
      });
    }).catch(function () {
      showStep(dlg, 'password');
      setError('backup-error', 'Couldn’t create the backup. Try again.');
    });
  }

  // Called directly from a tap so iOS allows the share sheet.
  function saveBackupFile() {
    var file = state.backupFile;
    if (!file) return;
    setError('backup-save-error');
    if (canShareFile(file)) {
      navigator.share({ files: [file] }).then(function () {
        markBackedUp('Backup saved. Keep it somewhere you trust, and remember the password.');
      }).catch(function (err) {
        if (err && err.name === 'AbortError') {
          setError('backup-save-error', 'Not saved yet. Tap Save backup file to try again.');
        } else {
          downloadFile(file);
          markBackedUp('Backup downloaded as ' + file.name + '. Move it somewhere you trust, and remember the password.');
        }
      });
    } else {
      downloadFile(file);
      markBackedUp('Backup downloaded as ' + file.name + '. Move it somewhere you trust, and remember the password.');
    }
  }

  function markBackedUp(message) {
    state.backupFile = null;
    $('backup-done-text').textContent = message;
    showStep($('backup-dialog'), 'done');
    DB.setMeta('lastBackupAt', Date.now()).then(function () {
      refreshNudge();
      if (!$('settings').hidden) refreshSettings();
    });
  }

  /* ---------------- Restore ---------------- */

  function openRestore() {
    var dlg = $('restore-dialog');
    state.restoreBytes = null;
    state.restorePlan = null;
    $('restore-file').value = '';
    $('restore-pass').value = '';
    $('restore-filename').hidden = true;
    $('restore-open').disabled = true;
    setError('restore-error');
    showStep(dlg, 'choose');
    dlg.showModal();
    $('restore-pick').focus();
  }

  function updateRestoreButton() {
    $('restore-open').disabled = !(state.restoreBytes && $('restore-pass').value);
  }

  function pickedRestoreFile() {
    var file = $('restore-file').files[0];
    state.restoreBytes = null;
    setError('restore-error');
    if (!file) { updateRestoreButton(); return; }
    $('restore-filename').hidden = false;
    $('restore-filename').textContent = 'Chosen: ' + file.name + ' (' + formatBytes(file.size) + ')';
    file.arrayBuffer().then(function (buf) {
      state.restoreBytes = new Uint8Array(buf);
      updateRestoreButton();
      $('restore-pass').focus();
    }).catch(function () {
      setError('restore-error', 'Couldn’t read that file. Try choosing it again.');
    });
  }

  function validNote(n) {
    if (!(n && typeof n.id === 'string' && n.id.length > 0 && n.id.length < 200 &&
      isDayKey(n.day) && typeof n.text === 'string' &&
      typeof n.createdAt === 'number' && typeof n.updatedAt === 'number')) return false;
    if (n.photos !== undefined && !(Array.isArray(n.photos) && n.photos.every(function (p) {
      return p && typeof p.id === 'string' && typeof p.w === 'number' && typeof p.h === 'number';
    }))) return false;
    if (n.audio !== undefined && !(Array.isArray(n.audio) && n.audio.every(function (a) {
      return a && typeof a.id === 'string' && typeof a.dur === 'number';
    }))) return false;
    return true;
  }

  function validMedia(m) {
    if (!(m && typeof m.id === 'string' && typeof m.noteId === 'string' && m.blob instanceof Blob)) return false;
    if (DB.isAudio(m)) return typeof m.duration === 'number';
    return m.thumb instanceof Blob && typeof m.width === 'number' && typeof m.height === 'number';
  }

  var RESTORE_ERRORS = {
    'not-backup': 'That file isn’t a Daybook backup.',
    'wrong-password': 'That password doesn’t open this backup. Check it and try again.',
    'newer': 'This backup was made by a newer version of Daybook. Close and reopen Daybook to update it, then try again.',
    'corrupt': 'This backup file is damaged and can’t be read.'
  };

  function openBackupFile(e) {
    e.preventDefault();
    if (!state.restoreBytes) return;
    var dlg = $('restore-dialog');
    var pass = $('restore-pass').value;
    $('restore-pass').value = '';
    updateRestoreButton();
    showStep(dlg, 'working');
    Backup.decrypt(state.restoreBytes, pass).then(function (data) {
      if (!data || data.format !== 'daybook-backup' || !Array.isArray(data.notes)) {
        var err = new Error('not a backup'); err.code = 'not-backup'; throw err;
      }
      if (data.schemaVersion > DB.SCHEMA_VERSION) {
        var err2 = new Error('newer'); err2.code = 'newer'; throw err2;
      }
      var notes = data.notes.filter(validNote);
      var media = (Array.isArray(data.media) ? data.media : []).filter(validMedia);
      return DB.planMerge(notes, media).then(function (plan) {
        state.restorePlan = plan;
        var made = data.exportedAt ? 'This backup was made ' + fmtStamp.format(data.exportedAt) + ' and holds ' : 'This backup holds ';
        var text = made + contentsPhrase(plan.total, media) + '. ';
        var changes = plan.add.length + plan.update.length + plan.mediaAdd.length;
        if (!changes) {
          text += 'Everything in it is already on this iPhone, so there’s nothing to restore.';
        } else {
          var adds = [];
          if (plan.add.length) adds.push(plural(plan.add.length, 'note', 'notes'));
          adds = adds.concat(mediaParts(plan.mediaAdd));
          var actions = [];
          if (adds.length) actions.push('add ' + sentence(adds));
          if (plan.update.length) actions.push('replace ' + plural(plan.update.length, 'note', 'notes') + ' with the backup’s newer copy');
          text += 'Restoring will ' + sentence(actions) + '. ';
          if (plan.same) text += plural(plan.same, 'note is', 'notes are') + ' already here. ';
          text += 'Nothing on this iPhone will be deleted.';
        }
        $('restore-summary').textContent = text;
        $('restore-confirm').hidden = !changes;
        showStep(dlg, 'summary');
      });
    }).catch(function (err) {
      showStep(dlg, 'choose');
      setError('restore-error', RESTORE_ERRORS[err && err.code] || 'Couldn’t open that backup.');
      $('restore-pass').focus();
    });
  }

  function confirmRestore() {
    var plan = state.restorePlan;
    if (!plan) return;
    var dlg = $('restore-dialog');
    showStep(dlg, 'working');
    DB.applyMerge(plan).then(function (n) {
      state.restorePlan = null;
      state.restoreBytes = null;
      var parts = [];
      if (n.notes) parts.push(plural(n.notes, 'note', 'notes'));
      parts = parts.concat(mediaParts(plan.mediaAdd));
      $('restore-done-text').textContent = 'Restored ' + sentence(parts) + '.';
      showStep(dlg, 'done');
      loadDay();
      refreshNudge();
      if (!$('settings').hidden) refreshSettings();
    }).catch(function () {
      showStep(dlg, 'choose');
      setError('restore-error', 'Couldn’t write the notes. Nothing was changed. Try again.');
    });
  }

  function bindDialogs() {
    ['backup-dialog', 'restore-dialog'].forEach(function (id) {
      var dlg = $(id);
      dlg.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) dlg.close();
      });
      dlg.addEventListener('close', function () {
        state.backupFile = null;
        state.restoreBytes = null;
        state.restorePlan = null;
        $('backup-pass').value = '';
        $('backup-pass2').value = '';
        $('restore-pass').value = '';
      });
    });
    $('backup-form').addEventListener('submit', encryptBackup);
    $('backup-save').addEventListener('click', saveBackupFile);
    $('restore-pick').addEventListener('click', function () { $('restore-file').click(); });
    $('restore-file').addEventListener('change', pickedRestoreFile);
    $('restore-pass').addEventListener('input', updateRestoreButton);
    $('restore-form').addEventListener('submit', openBackupFile);
    $('restore-confirm').addEventListener('click', confirmRestore);
  }

  /* ---------------- Updates (service worker) ---------------- */

  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (state.reloadRequested) window.location.reload();
    });
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
      state.swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
    }).catch(function () {});
  }

  function checkForUpdate() {
    if (state.swReg) state.swReg.update().catch(function () {});
  }

  function offerUpdate(worker) {
    state.waitingWorker = worker;
    $('update-banner').hidden = false;
  }

  // Only ever reloads when the person taps the banner, after saving any open edit and draft.
  function applyUpdate() {
    commitEdit().then(saveDraftNow).then(function () {
      state.reloadRequested = true;
      if (state.waitingWorker) state.waitingWorker.postMessage({ type: 'skip-waiting' });
      setTimeout(function () { window.location.reload(); }, 2500);
    });
  }

  /* ---------------- Start ---------------- */

  function bindApp() {
    $('prev-day').addEventListener('click', function () { step(-1); });
    $('next-day').addEventListener('click', function () { step(1); });
    $('go-today').addEventListener('click', function () {
      goTo(todayKey()).then(scrollToEnd);
    });
    var picker = $('date-picker');
    picker.addEventListener('change', function () { if (picker.value) goTo(picker.value); });
    picker.addEventListener('click', function () {
      try { if (picker.showPicker) picker.showPicker(); } catch (err) { /* the native control handles it */ }
    });

    var input = $('capture-text');
    input.addEventListener('input', function () { autosizeCapture(); updateAddButton(); saveDraftSoon(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(); return; }
      listKeydown(e);
    });
    keepFocus($('capture-todo'));
    $('capture-todo').addEventListener('click', function () { toggleTodoLine(input); });
    $('capture').addEventListener('submit', function (e) { e.preventDefault(); addNote(); });
    // Keep the keyboard up when tapping Add.
    $('capture-add').addEventListener('mousedown', function (e) { e.preventDefault(); });

    $('capture-photo').addEventListener('click', pickPhotos);
    $('photo-input').addEventListener('change', function () {
      var files = $('photo-input').files;
      var list = Array.prototype.slice.call(files || []);
      $('photo-input').value = ''; // lets the same photo be picked again later
      addPhotos(list);
    });

    $('toast-undo').addEventListener('click', function () {
      var fn = state.undo;
      hideToast();
      if (fn) commitEdit().then(fn);
    });

    $('nudge-backup').addEventListener('click', openBackup);
    $('nudge-later').addEventListener('click', function () {
      DB.setMeta('nudgeSnoozedUntil', Date.now() + DAY_MS).then(refreshNudge);
    });

    $('open-settings').addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', closeSettings);
    $('settings').addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSettings(); });
    $('settings-backup').addEventListener('click', openBackup);
    $('settings-restore').addEventListener('click', openRestore);
    $('update-button').addEventListener('click', applyUpdate);

    bindDialogs();
    bindSearch();
    bindAgenda();
    bindViewer();
    bindRecorder();
    bindSwipe();
    bindKeys();
    trackOnScreenKeyboard();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        checkForUpdate();
        if (state.followToday && state.day !== todayKey() && !state.editing && !viewer.noteId) goTo(todayKey());
        refreshNudge();
        if (isAgendaOpen()) renderAgenda();
      } else {
        saveDraftNow();
        // iOS stops the microphone in the background, so finish and keep what was recorded.
        if (state.recorder && state.recorder.handle) stopRecorder('Daybook went into the background, so the recording stopped and was saved.');
      }
    });
    setInterval(function () {
      if (state.followToday && state.day !== todayKey() && !state.editing && !viewer.noteId) goTo(todayKey());
    }, 60000);
    window.addEventListener('resize', function () {
      alignToRules($('backup-nudge'));
      alignToRules($('look-back'));
      alignToRules($('planned'));
      if (viewer.noteId) layoutViewer();
    });

    DB.onVersionChange = function () { $('update-banner').hidden = false; };
    watchWrites();
  }

  function showStorageError() {
    var empty = $('empty');
    empty.hidden = false;
    empty.textContent = 'Daybook couldn’t open its storage on this iPhone, so notes can’t be saved right now. Close Daybook fully and open it again.';
    state.storageBroken = true;
    $('capture-add').disabled = true;
    $('capture-photo').disabled = true;
    updateAddButton();
  }

  function start() {
    if (!isStandalone()) {
      $('install').hidden = false;
      return;
    }
    $('app').hidden = false;
    state.day = todayKey();
    renderHeader();
    bindApp();
    updateAddButton();
    setupServiceWorker();
    DB.open().then(function () {
      return loadDay();
    }).then(function () {
      scrollToEnd();
      restoreDraft();
      refreshNudge();
      requestPersist();
      // Clear out photos deleted more than 10 minutes ago (long past their Undo).
      DB.sweepTrashedMedia(TRASH_KEEP_MS).catch(function () {});
    }).catch(showStorageError);
  }

  window.Daybook = { version: APP_VERSION };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

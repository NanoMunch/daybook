/*
 * Daybook app. Everything here runs on the phone; notes never leave it.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.1.0';
  var DB = window.DaybookDB;
  var Backup = window.DaybookBackup;
  var Photos = window.DaybookPhotos;
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
    addingPhotos: false
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

  function noteElement(note) {
    var art = document.createElement('article');
    art.className = 'note';

    var time = document.createElement('time');
    time.className = 'note-time';
    time.dateTime = new Date(note.createdAt).toISOString();
    time.textContent = fmtTime.format(note.createdAt);

    var body = document.createElement('div');
    body.className = 'note-body';
    if (hasPhotos(note)) body.appendChild(photosElement(note));

    var target;
    if (note.text || !hasPhotos(note)) {
      target = document.createElement('div');
      target.className = 'note-text note-edit-target';
      target.tabIndex = 0;
      target.setAttribute('role', 'button');
      target.textContent = note.text;
      target.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(note.id); }
      });
    } else {
      target = document.createElement('button');
      target.type = 'button';
      target.className = 'note-caption-add note-edit-target';
      target.textContent = 'Add a caption';
    }
    target.addEventListener('click', function () { startEdit(note.id); });
    body.appendChild(target);

    art.appendChild(time);
    art.appendChild(body);
    return art;
  }

  function renderNotes() {
    var list = $('notes');
    list.textContent = '';
    state.els = new Map();
    state.notes.forEach(function (note) {
      var el = noteElement(note);
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
  }

  function loadDay(direction) {
    var seq = ++state.loadSeq;
    state.followToday = state.day === todayKey();
    renderHeader();
    var notes;
    return DB.notesForDay(state.day).then(function (list) {
      notes = list;
      var ids = [];
      notes.forEach(function (n) { photosOf(n).forEach(function (p) { ids.push(p.id); }); });
      return DB.getMedia(ids);
    }).then(function (media) {
      if (seq !== state.loadSeq) return;
      resetThumbUrls();
      state.notes = notes;
      state.media = media;
      renderNotes();
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

  /* ---------------- Quick capture ---------------- */

  function autosizeCapture() {
    var el = $('capture-text');
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 2) + 'px';
  }

  function updateAddButton() {
    $('capture-add').disabled = !$('capture-text').value.trim();
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
    return String(text).replace(/^\s*\n/, '').replace(/\s+$/, '');
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
      ta.setAttribute('aria-label', hasPhotos(note) ? 'Caption' : 'Edit note');
      if (hasPhotos(note)) ta.placeholder = 'Caption';

      var meta = document.createElement('p');
      meta.className = 'edit-meta';
      var written = 'Written ' + fmtStamp.format(note.createdAt);
      meta.textContent = note.updatedAt - note.createdAt > 60000
        ? written + ', edited ' + fmtStamp.format(note.updatedAt)
        : written;

      var actions = document.createElement('div');
      actions.className = 'edit-actions';
      actions.appendChild(button('Delete', 'btn btn-quiet btn-danger', function () { deleteNote(id); }));
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
        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); }
      });
      sizeEditor(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
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
      if (hasPhotos(note)) {
        text = ''; // a photo note can do without a caption
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
      toast(hasPhotos(note) ? 'Caption updated' : 'Note updated', function () {
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

  /* ---------------- Swipe between days ---------------- */

  function bindSwipe() {
    var start = null;
    document.addEventListener('touchstart', function (e) {
      if (state.editing || e.touches.length !== 1) { start = null; return; }
      if (e.target.closest('.capture, dialog, .settings, textarea, input, .nudge')) { start = null; return; }
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
      if (document.querySelector('dialog[open]') || !$('settings').hidden) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 't') { e.preventDefault(); goTo(todayKey()); }
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
    DB.countMedia().then(function (n) { $('fact-photos').textContent = String(n); }).catch(function () {});
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

  function contentsPhrase(notes, photos) {
    return plural(notes, 'note', 'notes') + (photos ? ' and ' + plural(photos, 'photo', 'photos') : '');
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
      var what = contentsPhrase(all.notes.length, all.media.length);
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
    if (n.photos === undefined) return true;
    return Array.isArray(n.photos) && n.photos.every(function (p) {
      return p && typeof p.id === 'string' && typeof p.w === 'number' && typeof p.h === 'number';
    });
  }

  function validMedia(m) {
    return m && typeof m.id === 'string' && typeof m.noteId === 'string' &&
      m.blob instanceof Blob && m.thumb instanceof Blob &&
      typeof m.width === 'number' && typeof m.height === 'number';
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
        var text = made + contentsPhrase(plan.total, plan.mediaTotal) + '. ';
        var changes = plan.add.length + plan.update.length + plan.mediaAdd.length;
        if (!changes) {
          text += 'Everything in it is already on this iPhone, so there’s nothing to restore.';
        } else {
          var adds = [];
          if (plan.add.length) adds.push(plural(plan.add.length, 'note', 'notes'));
          if (plan.mediaAdd.length) adds.push(plural(plan.mediaAdd.length, 'photo', 'photos'));
          var actions = [];
          if (adds.length) actions.push('add ' + adds.join(' and '));
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
      if (n.media) parts.push(plural(n.media, 'photo', 'photos'));
      $('restore-done-text').textContent = 'Restored ' + parts.join(' and ') + '.';
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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(); }
    });
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
    bindViewer();
    bindSwipe();
    bindKeys();
    trackOnScreenKeyboard();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        checkForUpdate();
        if (state.followToday && state.day !== todayKey() && !state.editing && !viewer.noteId) goTo(todayKey());
        refreshNudge();
      } else {
        saveDraftNow();
      }
    });
    setInterval(function () {
      if (state.followToday && state.day !== todayKey() && !state.editing && !viewer.noteId) goTo(todayKey());
    }, 60000);
    window.addEventListener('resize', function () {
      alignToRules($('backup-nudge'));
      if (viewer.noteId) layoutViewer();
    });

    DB.onVersionChange = function () { $('update-banner').hidden = false; };
  }

  function showStorageError() {
    var empty = $('empty');
    empty.hidden = false;
    empty.textContent = 'Daybook couldn’t open its storage on this iPhone, so notes can’t be saved right now. Close Daybook fully and open it again.';
    $('capture-add').disabled = true;
    $('capture-photo').disabled = true;
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

/*
 * Daybook app. Everything here runs on the phone; notes never leave it.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.0.0';
  var DB = window.DaybookDB;
  var Backup = window.DaybookBackup;
  var DAY_MS = 86400000;
  var BACKUP_EVERY_DAYS = 7;

  function $(id) { return document.getElementById(id); }

  var state = {
    day: null,
    notes: [],
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
    restorePlan: null
  };

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------- Dates ---------------- */

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

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    return Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
  }

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

  function noteElement(note) {
    var art = document.createElement('article');
    art.className = 'note';

    var time = document.createElement('time');
    time.className = 'note-time';
    time.dateTime = new Date(note.createdAt).toISOString();
    time.textContent = fmtTime.format(note.createdAt);

    var body = document.createElement('div');
    body.className = 'note-text';
    body.tabIndex = 0;
    body.setAttribute('role', 'button');
    body.textContent = note.text;
    body.addEventListener('click', function () { startEdit(note.id); });
    body.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(note.id); }
    });

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
    return DB.notesForDay(state.day).then(function (notes) {
      if (seq !== state.loadSeq) return;
      state.notes = notes;
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
    input.value = '';
    autosizeCapture();
    updateAddButton();
    return DB.putNote(note).then(function () {
      saveDraftNow();
      if (note.day === state.day) {
        state.notes.push(note);
        renderNotes();
        var el = state.els.get(note.id);
        if (el && !reduceMotion.matches) el.classList.add('is-flash');
        scrollToEnd();
      }
      requestPersist();
      refreshNudge();
    }).catch(function () {
      if (!input.value) {
        input.value = original;
        autosizeCapture();
        updateAddButton();
      }
      toast('Couldn’t save that note. Your text is back in the box.');
    });
  }

  /* ---------------- Editing ---------------- */

  function findNote(id) {
    for (var i = 0; i < state.notes.length; i++) if (state.notes[i].id === id) return state.notes[i];
    return null;
  }

  function sizeEditor(ta) {
    ta.style.height = 'auto';
    var line = 28;
    ta.style.height = Math.max(1, Math.ceil(ta.scrollHeight / line)) * line + 'px';
  }

  function startEdit(id) {
    if (state.editing && state.editing.id === id) return;
    commitEdit().then(function () {
      var note = findNote(id);
      var art = state.els.get(id);
      if (!note || !art) return;
      var body = art.querySelector('.note-text');

      var wrap = document.createElement('div');
      var ta = document.createElement('textarea');
      ta.className = 'note-editor';
      ta.value = note.text;
      ta.setAttribute('aria-label', 'Edit note');
      ta.rows = 1;

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
      art.replaceChild(wrap, body);

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
      state.editing = null;
      document.body.classList.remove('is-editing');
      return deleteNote(ed.id);
    }
    if (text === note.text) { closeEditor(); return Promise.resolve(); }
    var before = ed.before;
    var updated = Object.assign({}, note, { text: text, updatedAt: Date.now() });
    return DB.putNote(updated).then(function () {
      replaceNoteInState(updated);
      closeEditor();
      toast('Note updated', function () {
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

  function deleteNote(id) {
    var note = findNote(id);
    if (!note) return Promise.resolve();
    var copy = Object.assign({}, note);
    return DB.deleteNote(id).then(function () {
      state.notes = state.notes.filter(function (n) { return n.id !== id; });
      state.editing = null;
      document.body.classList.remove('is-editing');
      renderNotes();
      refreshNudge();
      toast('Note deleted', function () {
        return DB.putNote(copy).then(function () {
          if (copy.day === state.day) return loadDay();
        }).then(refreshNudge);
      });
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
    var line = 28;
    var extra = Math.ceil(h / line) * line - h;
    el.style.marginBottom = (extra + line) + 'px';
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

    DB.allNotes().then(function (notes) {
      $('backup-working').textContent = 'Encrypting ' + notes.length + (notes.length === 1 ? ' note' : ' notes') + '…';
      var data = {
        format: 'daybook-backup',
        appVersion: APP_VERSION,
        schemaVersion: DB.SCHEMA_VERSION,
        exportedAt: Date.now(),
        notes: notes
      };
      return Backup.encrypt(data, p1).then(function (bytes) {
        var name = 'daybook-' + todayKey() + '.daybook';
        state.backupFile = new File([bytes], name, { type: 'application/octet-stream' });
        $('backup-ready-text').textContent = 'Your backup of ' + notes.length + (notes.length === 1 ? ' note' : ' notes') +
          ' is ready (' + formatBytes(bytes.byteLength) + ').';
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
    var canShareFile = false;
    try { canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (err) { canShareFile = false; }
    if (canShareFile) {
      navigator.share({ files: [file] }).then(function () {
        markBackedUp('Backup saved. Keep it somewhere you trust, and remember the password.');
      }).catch(function (err) {
        if (err && err.name === 'AbortError') {
          setError('backup-save-error', 'Not saved yet. Tap Save backup file to try again.');
        } else {
          downloadFile(file);
        }
      });
    } else {
      downloadFile(file);
    }
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
    markBackedUp('Backup downloaded as ' + file.name + '. Move it somewhere you trust, and remember the password.');
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
    return n && typeof n.id === 'string' && n.id.length > 0 && n.id.length < 200 &&
      isDayKey(n.day) && typeof n.text === 'string' &&
      typeof n.createdAt === 'number' && typeof n.updatedAt === 'number';
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
        var err = new Error('corrupt'); err.code = 'not-backup'; throw err;
      }
      if (data.schemaVersion > DB.SCHEMA_VERSION) {
        var err2 = new Error('newer'); err2.code = 'newer'; throw err2;
      }
      var notes = data.notes.filter(validNote);
      return DB.planMerge(notes).then(function (plan) {
        state.restorePlan = plan;
        var changes = plan.add.length + plan.update.length;
        var made = data.exportedAt ? 'This backup was made ' + fmtStamp.format(data.exportedAt) + ' and holds ' : 'This backup holds ';
        var text = made + plan.total + (plan.total === 1 ? ' note. ' : ' notes. ');
        if (!changes) {
          text += 'All of them are already on this iPhone, so there’s nothing to restore.';
        } else {
          var parts = [];
          if (plan.add.length) parts.push(plan.add.length + ' will be added');
          if (plan.update.length) parts.push(plan.update.length + ' will be replaced by the backup’s newer copy');
          if (plan.same) parts.push(plan.same + (plan.same === 1 ? ' is' : ' are') + ' already here');
          text += 'Of those, ' + sentence(parts) + '. Nothing on this iPhone will be deleted.';
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

  function sentence(parts) {
    if (parts.length <= 1) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  function confirmRestore() {
    var plan = state.restorePlan;
    if (!plan) return;
    var dlg = $('restore-dialog');
    showStep(dlg, 'working');
    DB.applyMerge(plan).then(function (n) {
      state.restorePlan = null;
      state.restoreBytes = null;
      $('restore-done-text').textContent = 'Restored ' + n + (n === 1 ? ' note.' : ' notes.');
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
    bindSwipe();
    bindKeys();
    trackOnScreenKeyboard();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        checkForUpdate();
        if (state.followToday && state.day !== todayKey() && !state.editing) goTo(todayKey());
        refreshNudge();
      } else {
        saveDraftNow();
      }
    });
    setInterval(function () {
      if (state.followToday && state.day !== todayKey() && !state.editing) goTo(todayKey());
    }, 60000);
    window.addEventListener('resize', function () { alignToRules($('backup-nudge')); });

    DB.onVersionChange = function () { $('update-banner').hidden = false; };
  }

  function showStorageError() {
    var empty = $('empty');
    empty.hidden = false;
    empty.textContent = 'Daybook couldn’t open its storage on this iPhone, so notes can’t be saved right now. Close Daybook fully and open it again.';
    $('capture-add').disabled = true;
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
    }).catch(showStorageError);
  }

  window.Daybook = { version: APP_VERSION };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

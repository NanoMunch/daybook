/*
 * Daybook storage: IndexedDB on this device only.
 *
 * Schema changes go through MIGRATIONS. Each entry upgrades the database by
 * one version. Rules: only add stores/indexes or migrate records in place.
 * Never delete or clear an object store, and never drop user data.
 *
 * Stores
 *   notes  { id, day 'YYYY-MM-DD', createdAt, updatedAt, type, text, photos?: [{ id, w, h }] }
 *   meta   { key, value }  small app state (last backup time, unsent draft, ...)
 *   media  { id, noteId, blob, thumb, type, width, height, bytes, createdAt, trashedAt? }   (v2)
 *
 * Deleting a photo or a photo note only marks its media with trashedAt, so Undo
 * can bring it back. Trashed media that no note refers to is removed later by
 * sweepTrashedMedia().
 */
(function (global) {
  'use strict';

  var DB_NAME = 'daybook';

  // MIGRATIONS[n] upgrades from version n to version n + 1.
  var MIGRATIONS = [
    // v1: notes and a small key/value store for app state
    function toV1(db) {
      var notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('day', 'day', { unique: false });
      notes.createIndex('updatedAt', 'updatedAt', { unique: false });
      db.createObjectStore('meta', { keyPath: 'key' });
    },
    // v2: photos (and later audio) as Blobs, kept apart from notes so day pages load fast
    function toV2(db) {
      var media = db.createObjectStore('media', { keyPath: 'id' });
      media.createIndex('noteId', 'noteId', { unique: false });
    }
  ];

  var SCHEMA_VERSION = MIGRATIONS.length;
  var dbPromise = null;

  function promisify(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
      req.onupgradeneeded = function (event) {
        var db = req.result;
        for (var v = event.oldVersion; v < SCHEMA_VERSION; v++) {
          MIGRATIONS[v](db, req.transaction);
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () {
          // A newer version of the app wants to upgrade the schema.
          db.close();
          if (global.DaybookDB.onVersionChange) global.DaybookDB.onVersionChange();
        };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
      req.onblocked = function () { /* an older copy is open; it closes itself on versionchange */ };
    });
    return dbPromise;
  }

  // Opens a transaction over one or more stores: { tx, notes, meta, media }.
  function tx(names, mode) {
    return open().then(function (db) {
      var list = Array.isArray(names) ? names : [names];
      var t = db.transaction(list, mode);
      var out = { tx: t };
      list.forEach(function (n) { out[n] = t.objectStore(n); });
      return out;
    });
  }

  function photoIdsOf(note) {
    return (note && Array.isArray(note.photos)) ? note.photos.map(function (p) { return p.id; }) : [];
  }

  /* ---------- Notes ---------- */

  function notesForDay(day) {
    return tx('notes', 'readonly').then(function (s) {
      return promisify(s.notes.index('day').getAll(IDBKeyRange.only(day)));
    }).then(function (list) {
      return list.sort(function (a, b) { return a.createdAt - b.createdAt; });
    });
  }

  function getNote(id) {
    return tx('notes', 'readonly').then(function (s) { return promisify(s.notes.get(id)); });
  }

  function putNote(note) {
    return tx('notes', 'readwrite').then(function (s) {
      s.notes.put(note);
      return txDone(s.tx);
    }).then(function () { return note; });
  }

  function allNotes() {
    return tx('notes', 'readonly').then(function (s) { return promisify(s.notes.getAll()); });
  }

  function countNotes() {
    return tx('notes', 'readonly').then(function (s) { return promisify(s.notes.count()); });
  }

  /* ---------- Media ---------- */

  // Sets or clears trashedAt on each media record, inside an open transaction.
  function markMedia(store, ids, when) {
    ids.forEach(function (id) {
      var req = store.get(id);
      req.onsuccess = function () {
        var m = req.result;
        if (!m) return;
        if (when) m.trashedAt = when;
        else delete m.trashedAt;
        store.put(m);
      };
    });
  }

  function addNoteWithMedia(note, records) {
    return tx(['notes', 'media'], 'readwrite').then(function (s) {
      records.forEach(function (r) { s.media.put(r); });
      s.notes.put(note);
      return txDone(s.tx);
    }).then(function () { return note; });
  }

  // Map of id -> media record for the given ids (missing ones are left out).
  function getMedia(ids) {
    var found = new Map();
    if (!ids.length) return Promise.resolve(found);
    return tx('media', 'readonly').then(function (s) {
      ids.forEach(function (id) {
        var req = s.media.get(id);
        req.onsuccess = function () { if (req.result) found.set(id, req.result); };
      });
      return txDone(s.tx);
    }).then(function () { return found; });
  }

  function countMedia() {
    return tx('media', 'readonly').then(function (s) {
      return new Promise(function (resolve, reject) {
        var n = 0;
        var cur = s.media.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) return resolve(n);
          if (!c.value.trashedAt) n += 1;
          c.continue();
        };
        cur.onerror = function () { reject(cur.error); };
      });
    });
  }

  // Deletes a note and marks its photos as trashed, in one step.
  function deleteNote(note) {
    return tx(['notes', 'media'], 'readwrite').then(function (s) {
      s.notes.delete(note.id);
      markMedia(s.media, photoIdsOf(note), Date.now());
      return txDone(s.tx);
    });
  }

  // Saves a note and marks some of its former photos as trashed.
  function updateNoteAndTrash(note, trashIds) {
    return tx(['notes', 'media'], 'readwrite').then(function (s) {
      s.notes.put(note);
      markMedia(s.media, trashIds, Date.now());
      return txDone(s.tx);
    });
  }

  // Puts a note back (Undo) and un-trashes all of its photos.
  function restoreNote(note) {
    return tx(['notes', 'media'], 'readwrite').then(function (s) {
      s.notes.put(note);
      markMedia(s.media, photoIdsOf(note), null);
      return txDone(s.tx);
    });
  }

  /*
   * Permanently removes media that was trashed at least minAgeMs ago and that
   * no note refers to any more. Media a note still uses is never removed.
   */
  function sweepTrashedMedia(minAgeMs) {
    var cutoff = Date.now() - (minAgeMs || 0);
    var removed = 0;
    return tx(['notes', 'media'], 'readwrite').then(function (s) {
      var notesReq = s.notes.getAll();
      notesReq.onsuccess = function () {
        var used = new Set();
        notesReq.result.forEach(function (n) { photoIdsOf(n).forEach(function (id) { used.add(id); }); });
        var cur = s.media.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) return;
          var m = c.value;
          if (m.trashedAt && m.trashedAt <= cutoff && !used.has(m.id)) {
            c.delete();
            removed += 1;
          }
          c.continue();
        };
      };
      return txDone(s.tx);
    }).then(function () { return removed; });
  }

  /* ---------- Meta ---------- */

  function getMeta(key) {
    return tx('meta', 'readonly').then(function (s) {
      return promisify(s.meta.get(key));
    }).then(function (row) { return row ? row.value : undefined; });
  }

  function setMeta(key, value) {
    return tx('meta', 'readwrite').then(function (s) {
      s.meta.put({ key: key, value: value });
      return txDone(s.tx);
    });
  }

  /* ---------- Backup and restore ---------- */

  // Everything worth backing up: all notes, and the photos those notes use.
  function exportAll() {
    return tx(['notes', 'media'], 'readonly').then(function (s) {
      return Promise.all([promisify(s.notes.getAll()), promisify(s.media.getAll())]);
    }).then(function (r) {
      var used = new Set();
      r[0].forEach(function (n) { photoIdsOf(n).forEach(function (id) { used.add(id); }); });
      var media = r[1].filter(function (m) { return !m.trashedAt && used.has(m.id); });
      return { notes: r[0], media: media };
    });
  }

  /*
   * Works out what restoring would do, without writing anything.
   * Notes match by id: a note already here is replaced only when the backup's
   * copy is newer. A photo is added when the resulting note uses it and it
   * isn't already here (or was deleted and is waiting to be cleared).
   */
  function planMerge(incomingNotes, incomingMedia) {
    incomingMedia = incomingMedia || [];
    return tx(['notes', 'media'], 'readonly').then(function (s) {
      return Promise.all([promisify(s.notes.getAll()), promisify(s.media.getAll())]);
    }).then(function (r) {
      var notesHere = new Map();
      r[0].forEach(function (n) { notesHere.set(n.id, n); });
      var mediaHere = new Map();
      r[1].forEach(function (m) { mediaHere.set(m.id, m); });

      var plan = { add: [], update: [], same: 0, total: 0, mediaAdd: [], mediaTotal: 0 };
      var result = new Map();
      var seen = new Set();
      incomingNotes.forEach(function (n) {
        if (!n || typeof n.id !== 'string' || seen.has(n.id)) return;
        seen.add(n.id);
        plan.total += 1;
        var here = notesHere.get(n.id);
        if (!here) { plan.add.push(n); result.set(n.id, n); }
        else if ((n.updatedAt || 0) > (here.updatedAt || 0)) { plan.update.push(n); result.set(n.id, n); }
        else { plan.same += 1; result.set(n.id, here); }
      });

      var seenMedia = new Set();
      incomingMedia.forEach(function (m) {
        if (!m || typeof m.id !== 'string' || seenMedia.has(m.id)) return;
        seenMedia.add(m.id);
        plan.mediaTotal += 1;
        var owner = result.get(m.noteId) || notesHere.get(m.noteId);
        if (!owner || photoIdsOf(owner).indexOf(m.id) < 0) return;
        var here = mediaHere.get(m.id);
        if (!here || here.trashedAt) plan.mediaAdd.push(m);
      });
      return plan;
    });
  }

  function applyMerge(plan) {
    return tx(['notes', 'media'], 'readwrite').then(function (s) {
      plan.mediaAdd.forEach(function (m) {
        var copy = Object.assign({}, m);
        delete copy.trashedAt;
        s.media.put(copy);
      });
      plan.add.concat(plan.update).forEach(function (n) { s.notes.put(n); });
      return txDone(s.tx);
    }).then(function () {
      return { notes: plan.add.length + plan.update.length, media: plan.mediaAdd.length };
    });
  }

  global.DaybookDB = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    open: open,
    notesForDay: notesForDay,
    getNote: getNote,
    putNote: putNote,
    allNotes: allNotes,
    countNotes: countNotes,
    addNoteWithMedia: addNoteWithMedia,
    getMedia: getMedia,
    countMedia: countMedia,
    deleteNote: deleteNote,
    updateNoteAndTrash: updateNoteAndTrash,
    restoreNote: restoreNote,
    sweepTrashedMedia: sweepTrashedMedia,
    getMeta: getMeta,
    setMeta: setMeta,
    exportAll: exportAll,
    planMerge: planMerge,
    applyMerge: applyMerge,
    onVersionChange: null
  };
})(typeof window !== 'undefined' ? window : globalThis);

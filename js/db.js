/*
 * Daybook storage: IndexedDB on this device only.
 *
 * Schema changes go through MIGRATIONS. Each entry upgrades the database by
 * one version. Rules: only add stores/indexes or migrate records in place.
 * Never delete or clear an object store, and never drop user data.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'daybook';

  // MIGRATIONS[n] upgrades from version n to version n + 1.
  var MIGRATIONS = [
    // v1: notes and a small key/value store for app state (last backup time, draft, ...)
    function toV1(db) {
      var notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('day', 'day', { unique: false });
      notes.createIndex('updatedAt', 'updatedAt', { unique: false });
      db.createObjectStore('meta', { keyPath: 'key' });
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

  function open(name) {
    if (dbPromise && !name) return dbPromise;
    var p = new Promise(function (resolve, reject) {
      var req = indexedDB.open(name || DB_NAME, SCHEMA_VERSION);
      req.onupgradeneeded = function (event) {
        var db = req.result;
        var tx = req.transaction;
        for (var v = event.oldVersion; v < SCHEMA_VERSION; v++) {
          MIGRATIONS[v](db, tx);
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
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { /* another copy is open; it will close on versionchange */ };
    });
    if (!name) dbPromise = p;
    return p;
  }

  function store(storeName, mode) {
    return open().then(function (db) {
      var tx = db.transaction(storeName, mode);
      return { tx: tx, store: tx.objectStore(storeName) };
    });
  }

  function notesForDay(day) {
    return store('notes', 'readonly').then(function (s) {
      return promisify(s.store.index('day').getAll(IDBKeyRange.only(day)));
    }).then(function (list) {
      return list.sort(function (a, b) { return a.createdAt - b.createdAt; });
    });
  }

  function getNote(id) {
    return store('notes', 'readonly').then(function (s) { return promisify(s.store.get(id)); });
  }

  function putNote(note) {
    return store('notes', 'readwrite').then(function (s) {
      s.store.put(note);
      return txDone(s.tx);
    }).then(function () { return note; });
  }

  function deleteNote(id) {
    return store('notes', 'readwrite').then(function (s) {
      s.store.delete(id);
      return txDone(s.tx);
    });
  }

  function allNotes() {
    return store('notes', 'readonly').then(function (s) { return promisify(s.store.getAll()); });
  }

  function countNotes() {
    return store('notes', 'readonly').then(function (s) { return promisify(s.store.count()); });
  }

  function getMeta(key) {
    return store('meta', 'readonly').then(function (s) {
      return promisify(s.store.get(key));
    }).then(function (row) { return row ? row.value : undefined; });
  }

  function setMeta(key, value) {
    return store('meta', 'readwrite').then(function (s) {
      s.store.put({ key: key, value: value });
      return txDone(s.tx);
    });
  }

  /*
   * Merge notes from a backup. Matching is by note id, so nothing is duplicated.
   * A note already here is replaced only when the backup's copy is newer.
   * plan() reports what would happen without writing anything.
   */
  function planMerge(incoming) {
    return allNotes().then(function (existing) {
      var byId = new Map();
      existing.forEach(function (n) { byId.set(n.id, n); });
      var plan = { add: [], update: [], same: 0, total: incoming.length };
      var seen = new Set();
      incoming.forEach(function (n) {
        if (!n || typeof n.id !== 'string' || seen.has(n.id)) return;
        seen.add(n.id);
        var here = byId.get(n.id);
        if (!here) plan.add.push(n);
        else if ((n.updatedAt || 0) > (here.updatedAt || 0)) plan.update.push(n);
        else plan.same += 1;
      });
      return plan;
    });
  }

  function applyMerge(plan) {
    return store('notes', 'readwrite').then(function (s) {
      plan.add.concat(plan.update).forEach(function (n) { s.store.put(n); });
      return txDone(s.tx);
    }).then(function () { return plan.add.length + plan.update.length; });
  }

  global.DaybookDB = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    open: open,
    notesForDay: notesForDay,
    getNote: getNote,
    putNote: putNote,
    deleteNote: deleteNote,
    allNotes: allNotes,
    countNotes: countNotes,
    getMeta: getMeta,
    setMeta: setMeta,
    planMerge: planMerge,
    applyMerge: applyMerge,
    onVersionChange: null
  };
})(typeof window !== 'undefined' ? window : globalThis);

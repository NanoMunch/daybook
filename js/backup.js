/*
 * Daybook encrypted backups. Runs entirely on the device with Web Crypto.
 *
 * File layout (.daybook):
 *   bytes 0-3   "DYBK"
 *   byte  4     format version (1)
 *   bytes 5-8   PBKDF2 iterations, big-endian uint32
 *   bytes 9-24  salt (16 random bytes)
 *   bytes 25-36 AES-GCM IV (12 random bytes)
 *   bytes 37-   AES-256-GCM ciphertext; the 37 header bytes are authenticated too
 *
 * Plaintext layout:
 *   uint32 JSON length, UTF-8 JSON, then the raw bytes of every Blob in order.
 *   Blobs (photos, audio) inside the data are replaced in the JSON by
 *   {"$blob": index} and listed in "blobs" with their type and size.
 *
 * The password is never stored. Without it the file can't be opened.
 */
(function (global) {
  'use strict';

  var MAGIC = [0x44, 0x59, 0x42, 0x4B]; // "DYBK"
  var FORMAT = 1;
  var ITERATIONS = 600000;
  var HEADER_LEN = 4 + 1 + 4 + 16 + 12;
  var subtle = global.crypto && global.crypto.subtle;

  function BackupError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function isBlob(v) {
    return typeof Blob !== 'undefined' && v instanceof Blob;
  }

  // Replace Blobs with references, collecting them in order.
  function strip(value, blobs) {
    if (isBlob(value)) {
      blobs.push(value);
      return { $blob: blobs.length - 1 };
    }
    if (Array.isArray(value)) return value.map(function (v) { return strip(v, blobs); });
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = strip(value[k], blobs); });
      return out;
    }
    return value;
  }

  function restore(value, blobs) {
    if (Array.isArray(value)) return value.map(function (v) { return restore(v, blobs); });
    if (value && typeof value === 'object') {
      var keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === '$blob' && typeof value.$blob === 'number') {
        var b = blobs[value.$blob];
        if (!b) throw BackupError('corrupt', 'Backup is missing a file');
        return b;
      }
      var out = {};
      keys.forEach(function (k) { out[k] = restore(value[k], blobs); });
      return out;
    }
    return value;
  }

  function pack(data) {
    var blobs = [];
    var body = strip(data, blobs);
    return Promise.all(blobs.map(function (b) { return b.arrayBuffer(); })).then(function (buffers) {
      var manifest = blobs.map(function (b, i) { return { type: b.type || '', size: buffers[i].byteLength }; });
      var json = new TextEncoder().encode(JSON.stringify({ data: body, blobs: manifest }));
      var total = 4 + json.byteLength;
      buffers.forEach(function (buf) { total += buf.byteLength; });
      var out = new Uint8Array(total);
      new DataView(out.buffer).setUint32(0, json.byteLength, false);
      out.set(json, 4);
      var offset = 4 + json.byteLength;
      buffers.forEach(function (buf) { out.set(new Uint8Array(buf), offset); offset += buf.byteLength; });
      return out;
    });
  }

  function unpack(bytes) {
    if (bytes.byteLength < 4) throw BackupError('corrupt', 'Backup is damaged');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var jsonLen = view.getUint32(0, false);
    if (4 + jsonLen > bytes.byteLength) throw BackupError('corrupt', 'Backup is damaged');
    var parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLen)));
    } catch (e) {
      throw BackupError('corrupt', 'Backup is damaged');
    }
    var offset = 4 + jsonLen;
    var blobs = (parsed.blobs || []).map(function (m) {
      var end = offset + m.size;
      if (end > bytes.byteLength) throw BackupError('corrupt', 'Backup is damaged');
      var blob = new Blob([bytes.slice(offset, end)], { type: m.type || '' });
      offset = end;
      return blob;
    });
    return restore(parsed.data, blobs);
  }

  function deriveKey(password, salt, iterations) {
    var pw = new TextEncoder().encode(String(password).normalize('NFC'));
    return subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  function encrypt(data, password, options) {
    var iterations = (options && options.iterations) || ITERATIONS;
    if (iterations < ITERATIONS && !(options && options.allowWeakForTests)) {
      return Promise.reject(BackupError('weak', 'Too few iterations'));
    }
    var salt = global.crypto.getRandomValues(new Uint8Array(16));
    var iv = global.crypto.getRandomValues(new Uint8Array(12));
    var header = new Uint8Array(HEADER_LEN);
    header.set(MAGIC, 0);
    header[4] = FORMAT;
    new DataView(header.buffer).setUint32(5, iterations, false);
    header.set(salt, 9);
    header.set(iv, 25);
    return Promise.all([pack(data), deriveKey(password, salt, iterations)]).then(function (r) {
      return subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: header }, r[1], r[0]);
    }).then(function (cipher) {
      var out = new Uint8Array(HEADER_LEN + cipher.byteLength);
      out.set(header, 0);
      out.set(new Uint8Array(cipher), HEADER_LEN);
      return out;
    });
  }

  function readHeader(bytes) {
    if (!bytes || bytes.byteLength < HEADER_LEN + 16) throw BackupError('not-backup', 'Not a Daybook backup');
    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw BackupError('not-backup', 'Not a Daybook backup');
    }
    if (bytes[4] > FORMAT) throw BackupError('newer', 'Made by a newer version of Daybook');
    var iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, false);
    if (iterations < 1 || iterations > 50000000) throw BackupError('not-backup', 'Not a Daybook backup');
    return {
      iterations: iterations,
      salt: bytes.slice(9, 25),
      iv: bytes.slice(25, 37),
      header: bytes.slice(0, HEADER_LEN)
    };
  }

  function decrypt(input, password) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var h;
    try { h = readHeader(bytes); } catch (e) { return Promise.reject(e); }
    return deriveKey(password, h.salt, h.iterations).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: h.iv, additionalData: h.header }, key, bytes.slice(HEADER_LEN))
        .catch(function () { throw BackupError('wrong-password', 'Wrong password, or the file is damaged'); });
    }).then(function (plain) {
      return unpack(new Uint8Array(plain));
    });
  }

  var api = {
    FORMAT: FORMAT,
    ITERATIONS: ITERATIONS,
    encrypt: encrypt,
    decrypt: decrypt,
    pack: pack,
    unpack: unpack
  };
  global.DaybookBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

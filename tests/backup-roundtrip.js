// Encrypted backup round trip. Run: node tests/backup-roundtrip.js
'use strict';
const assert = require('assert');
const path = require('path');
const Backup = require(path.join(__dirname, '..', 'js', 'backup.js'));

async function blobBytes(b) { return Buffer.from(await b.arrayBuffer()); }

(async () => {
  const photo = new Blob([new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])], { type: 'image/jpeg' });
  const audio = new Blob([new Uint8Array(70000).map((_, i) => i % 256)], { type: 'audio/mp4' });
  const data = {
    format: 'daybook-backup',
    appVersion: 'test',
    schemaVersion: 1,
    exportedAt: 1760000000000,
    notes: [
      { id: 'a', day: '2026-10-17', createdAt: 1, updatedAt: 2, type: 'text', text: 'Hello\nworld, emoji 🌿 and “quotes”' },
      { id: 'b', day: '2026-10-16', createdAt: 3, updatedAt: 3, type: 'text', text: '' },
      { id: 'c', day: '2026-10-15', createdAt: 4, updatedAt: 4, type: 'photo', text: 'cap', photo: photo, nested: { audio: audio } }
    ]
  };
  const password = 'correct horse battery';

  const t0 = Date.now();
  const bytes = await Backup.encrypt(data, password);
  const encMs = Date.now() - t0;

  // Header checks
  assert.strictEqual(Buffer.from(bytes.slice(0, 4)).toString('ascii'), 'DYBK');
  assert.strictEqual(bytes[4], 1);
  const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(5, false);
  assert.ok(iterations >= 600000, 'iterations >= 600000');
  // Plaintext must not appear in the file
  assert.ok(!Buffer.from(bytes).includes(Buffer.from('Hello')), 'note text is not visible in the file');

  const back = await Backup.decrypt(bytes, password);
  assert.deepStrictEqual(back.notes[0], data.notes[0]);
  assert.deepStrictEqual(back.notes[1], data.notes[1]);
  assert.strictEqual(back.notes[2].photo.type, 'image/jpeg');
  assert.deepStrictEqual(await blobBytes(back.notes[2].photo), await blobBytes(photo));
  assert.strictEqual(back.notes[2].nested.audio.type, 'audio/mp4');
  assert.deepStrictEqual(await blobBytes(back.notes[2].nested.audio), await blobBytes(audio));
  const { notes: _a, ...restBack } = back;
  const { notes: _b, ...restData } = data;
  assert.deepStrictEqual(restBack, restData);

  // Same input encrypts differently each time (random salt + IV)
  const bytes2 = await Backup.encrypt(data, password);
  assert.ok(!Buffer.from(bytes).equals(Buffer.from(bytes2)), 'salt/iv are random');

  // Wrong password
  await assert.rejects(Backup.decrypt(bytes, 'wrong password'), (e) => e.code === 'wrong-password');
  // Password normalisation: NFC and NFD forms of the same text open the same backup
  const nfc = await Backup.encrypt({ notes: [] }, 'café-pass');
  await Backup.decrypt(nfc, 'café-pass');
  // Tampered header (iterations) and tampered body
  const tampered = bytes.slice(); tampered[10] ^= 1;
  await assert.rejects(Backup.decrypt(tampered, password), (e) => e.code === 'wrong-password');
  const tampered2 = bytes.slice(); tampered2[tampered2.length - 5] ^= 1;
  await assert.rejects(Backup.decrypt(tampered2, password), (e) => e.code === 'wrong-password');
  // Not a backup
  await assert.rejects(Backup.decrypt(new Uint8Array(100), password), (e) => e.code === 'not-backup');
  // Newer format
  const newer = bytes.slice(); newer[4] = 9;
  await assert.rejects(Backup.decrypt(newer, password), (e) => e.code === 'newer');
  // Weak iterations refused
  await assert.rejects(Backup.encrypt(data, password, { iterations: 1000 }), (e) => e.code === 'weak');

  console.log('backup round trip: OK (encrypt ' + encMs + ' ms, ' + bytes.byteLength + ' bytes)');
})().catch((e) => { console.error('backup round trip: FAILED', e); process.exit(1); });

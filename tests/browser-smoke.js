// Headless browser test. Serve the folder that CONTAINS daybook/ on a local port, then:
//   BASE=http://localhost:8765/daybook/ OUT=/tmp/out node tests/browser-smoke.js
// Optional: SERVE_DIR=<path to the served daybook folder> lets the test bump sw.js to check the update banner.
// Optional: FIXTURES=<dir from tests/make-fixtures.js> runs the photo tests.
// Optional: OLD_BASE=<URL of the previous release on the same origin> runs the upgrade (migration) test.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = process.env.BASE || 'http://localhost:8765/daybook/';
const OUT = process.env.OUT || path.join(__dirname, '..', '.test-output');
const SERVE_DIR = process.env.SERVE_DIR || '';
const FIXTURES = process.env.FIXTURES || '';
const OLD_BASE = process.env.OLD_BASE || '';
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'BUILDLOG.json'), 'utf8')).version;
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true };

async function makeBackup(page, password) {
  await page.click('#open-settings');
  await page.click('#settings-backup');
  await page.fill('#backup-pass', password);
  await page.fill('#backup-pass2', password);
  await page.click('#backup-encrypt');
  await page.waitForSelector('#backup-dialog [data-step="ready"]:not([hidden])', { timeout: 30000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-save')]);
  const file = path.join(OUT, Date.now() + '-' + download.suggestedFilename());
  await download.saveAs(file);
  await page.click('#backup-dialog [data-step="done"] [data-close]');
  await page.click('#close-settings');
  return file;
}

async function openRestoreSummary(page, file, password) {
  await page.click('#open-settings');
  await page.click('#settings-restore');
  await page.setInputFiles('#restore-file', file);
  await page.fill('#restore-pass', password);
  await page.click('#restore-open');
  await page.waitForSelector('#restore-dialog [data-step="summary"]:not([hidden])', { timeout: 30000 });
  return page.textContent('#restore-summary');
}

async function finishRestore(page, confirm) {
  if (confirm) {
    await page.click('#restore-confirm');
    await page.waitForSelector('#restore-dialog [data-step="done"]:not([hidden])');
    await page.click('#restore-dialog [data-step="done"] [data-close]');
  } else {
    await page.click('#restore-dialog [data-step="summary"] [data-close]');
  }
  await page.click('#close-settings');
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail && !cond ? ' :: ' + detail : ''));
}

const STANDALONE = () => {
  Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
};

function dayKey(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
  };

  // 1. Safari-tab view shows the install screen
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    check('install screen shown outside home-screen app', await page.isVisible('#install') && !(await page.isVisible('#app')));
    await page.screenshot({ path: path.join(OUT, 'install.png'), fullPage: true });
    await ctx.close();
  }

  // 2. Home-screen app
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, acceptDownloads: true });
    await ctx.addInitScript(STANDALONE);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.waitForSelector('#app:not([hidden])');
    const today = dayKey(new Date());

    if (scheme === 'dark') {
      // Seed a few notes for a visual check only
      for (const t of ['Coffee with Sam at the corner place. He recommended a book about bridges.', 'Call the plumber about the kitchen tap\nand ask about Thursday', 'Idea: a shelf above the desk for the plants']) {
        await page.fill('#capture-text', t);
        await page.click('#capture-add');
      }
      await page.waitForFunction(() => document.querySelectorAll('.note').length === 3, null, { timeout: 5000 }).catch(() => {});
      check('rapid back-to-back notes all saved', (await page.$$('.note')).length === 3);
      await page.screenshot({ path: path.join(OUT, 'day-dark.png') });
      await ctx.close();
      continue;
    }

    await page.evaluate(() => navigator.serviceWorker.ready);
    check('service worker active', await page.evaluate(() => !!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then((r) => !!r.active)));
    check('empty state on a new day', (await page.textContent('#empty')).includes('Nothing written yet today'));
    check('date heading shows today', (await page.textContent('#fulldate')).startsWith('Today'));

    // Add notes
    await page.fill('#capture-text', 'First note\nwith a second line');
    await page.click('#capture-add');
    await page.fill('#capture-text', 'Second note');
    await page.press('#capture-text', 'Control+Enter');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    const texts = await page.$$eval('.note-text', (els) => els.map((e) => e.textContent));
    check('notes added in order', texts[0] === 'First note\nwith a second line' && texts[1] === 'Second note', JSON.stringify(texts));
    check('note shows a time in the margin', /\d/.test(await page.textContent('.note-time')));
    check('capture box cleared after adding', (await page.inputValue('#capture-text')) === '');
    check('backup reminder appears once there are notes', await page.isVisible('#backup-nudge'));

    // Ruled-line alignment: every note starts on a 28px line
    const aligned = await page.$$eval('.note', (els) => {
      const page = document.getElementById('page').getBoundingClientRect().top;
      return els.every((e) => Math.abs(((e.getBoundingClientRect().top - page) % 28)) < 0.6);
    });
    check('notes sit on the ruled lines', aligned);

    // Draft survives a reload, notes persist
    await page.fill('#capture-text', 'unsent draft');
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    check('notes persist after reload (IndexedDB)', true);
    check('unsent draft restored after reload', (await page.inputValue('#capture-text')) === 'unsent draft');
    await page.fill('#capture-text', '');

    // Edit + undo
    await page.click('.note:nth-child(1) .note-text');
    await page.waitForSelector('.note-editor');
    check('capture bar hidden while editing', !(await page.isVisible('#capture')));
    await page.fill('.note-editor', 'First note, edited');
    await page.click('.edit-actions .btn-primary');
    await page.waitForFunction(() => document.querySelector('.note-text').textContent === 'First note, edited');
    check('edit saved', true);
    check('undo offered after edit', (await page.textContent('#toast-text')) === 'Note updated' && await page.isVisible('#toast-undo'));
    await page.click('#toast-undo');
    await page.waitForFunction(() => document.querySelector('.note-text').textContent.startsWith('First note\n'));
    check('undo restores the earlier text', true);

    // Delete + undo
    await page.click('.note:nth-child(2) .note-text');
    await page.click('.edit-actions .btn-danger');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 1);
    check('delete removes the note', true);
    await page.click('#toast-undo');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    check('undo brings a deleted note back', true);

    // Day navigation
    await page.click('#prev-day');
    await page.waitForFunction(() => document.getElementById('fulldate').textContent.startsWith('Yesterday'));
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 0);
    check('previous-day arrow', (await page.textContent('#empty')).includes('No notes on this day'));
    check('back-to-today shown on another day', await page.isVisible('#go-today'));
    await page.fill('#capture-text', 'Note on yesterday');
    await page.click('#capture-add');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 1);
    await page.click('#go-today');
    await page.waitForFunction(() => document.getElementById('fulldate').textContent.startsWith('Today') && document.querySelectorAll('.note').length === 2);
    check('back to today', true);
    await page.click('#next-day');
    await page.waitForFunction(() => document.getElementById('fulldate').textContent.startsWith('Tomorrow'));
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 0);
    check('next-day arrow, future page', (await page.textContent('#empty')).includes('Nothing planned'));
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.getElementById('fulldate').textContent.startsWith('Today'));
    check('arrow key flips back', true);

    // Swipe (synthetic touch events)
    const swipe = async (fromX, toX) => page.evaluate(([a, b]) => {
      const target = document.getElementById('page');
      const mk = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: 400 });
      document.getElementById('page').dispatchEvent(new TouchEvent('touchstart', { touches: [mk(a)], changedTouches: [mk(a)], bubbles: true }));
      document.getElementById('page').dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(b)], bubbles: true }));
    }, [fromX, toX]);
    await swipe(80, 300);
    await page.waitForFunction(() => document.getElementById('fulldate').textContent.startsWith('Yesterday'));
    check('swipe right goes to the previous day', true);
    await swipe(300, 80);
    await page.waitForFunction(() => document.getElementById('fulldate').textContent.startsWith('Today'));
    check('swipe left goes to the next day', true);

    // Date picker
    await page.evaluate(() => { const p = document.getElementById('date-picker'); p.value = '2025-12-25'; p.dispatchEvent(new Event('change')); });
    await page.waitForFunction(() => document.getElementById('weekday').textContent === 'Thursday');
    check('date picker jumps to a chosen day', (await page.textContent('#fulldate')).includes('2025'));
    await page.click('#go-today');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    await page.screenshot({ path: path.join(OUT, 'day-light.png') });

    // Settings
    await page.click('#open-settings');
    await page.waitForSelector('#settings:not([hidden])');
    await page.waitForFunction(() => document.getElementById('fact-notes').textContent === '3');
    check('settings show note count and version', (await page.textContent('#fact-version')) === VERSION);
    check('settings show space used', /KB|bytes|MB/.test(await page.textContent('#fact-space')), await page.textContent('#fact-space'));
    check('settings show persistent-storage status', (await page.textContent('#fact-persist')).length > 1);
    await page.screenshot({ path: path.join(OUT, 'settings.png') });

    // Back up (download fallback in headless Chromium; iPhone uses the share sheet)
    await page.click('#settings-backup');
    await page.fill('#backup-pass', 'abc');
    await page.fill('#backup-pass2', 'abc');
    await page.click('#backup-encrypt');
    check('short password rejected', (await page.textContent('#backup-error')).includes('8 characters'));
    await page.fill('#backup-pass', 'tide-pool-lantern');
    await page.fill('#backup-pass2', 'tide-pool-lantern-x');
    await page.click('#backup-encrypt');
    check('mismatched passwords rejected', (await page.textContent('#backup-error')).includes('match'));
    await page.fill('#backup-pass', 'tide-pool-lantern');
    await page.fill('#backup-pass2', 'tide-pool-lantern');
    await page.click('#backup-encrypt');
    await page.waitForSelector('[data-step="ready"]:not([hidden])', { timeout: 20000 });
    await page.screenshot({ path: path.join(OUT, 'backup-ready.png') });
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-save')]);
    const backupPath = path.join(OUT, download.suggestedFilename());
    await download.saveAs(backupPath);
    check('backup file saved with .daybook name', /^daybook-\d{4}-\d{2}-\d{2}\.daybook$/.test(download.suggestedFilename()), download.suggestedFilename());
    const raw = fs.readFileSync(backupPath);
    check('backup file is encrypted (header present, no note text visible)', raw.slice(0, 4).toString() === 'DYBK' && !raw.includes(Buffer.from('Second note')));
    await page.waitForSelector('#backup-dialog [data-step="done"]:not([hidden])');
    await page.click('#backup-dialog [data-step="done"] [data-close]');
    await page.waitForFunction(() => document.getElementById('last-backup').textContent.startsWith('Last backup'));
    check('last backup time recorded', true);
    await page.click('#close-settings');
    check('backup reminder hidden after backing up', await page.isHidden('#backup-nudge'));

    // Delete a note, then restore it from the backup
    await page.click('.note:nth-child(2) .note-text');
    await page.click('.edit-actions .btn-danger');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 1);
    await page.click('#open-settings');
    await page.click('#settings-restore');
    await page.setInputFiles('#restore-file', backupPath);
    await page.fill('#restore-pass', 'not-the-password');
    await page.click('#restore-open');
    await page.waitForSelector('#restore-error:not([hidden])', { timeout: 20000 });
    check('wrong password refused on restore', (await page.textContent('#restore-error')).includes('doesn’t open'));
    await page.fill('#restore-pass', 'tide-pool-lantern');
    await page.click('#restore-open');
    await page.waitForSelector('[data-step="summary"]:not([hidden])', { timeout: 20000 });
    const summary = await page.textContent('#restore-summary');
    check('restore summary before writing', summary.includes('holds 3 notes.') && summary.includes('Restoring will add 1 note.') && summary.includes('2 notes are already here'), summary);
    check('nothing written before confirming', (await page.$$('.note')).length === 1);
    await page.screenshot({ path: path.join(OUT, 'restore-summary.png') });
    await page.click('#restore-confirm');
    await page.waitForSelector('#restore-dialog [data-step="done"]:not([hidden])');
    await page.click('#restore-dialog [data-step="done"] [data-close]');
    await page.click('#close-settings');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    check('restore merged the missing note back', true);
    // Restoring the same file again adds nothing (no duplicates)
    const count = await page.evaluate(() => window.DaybookDB.countNotes());
    check('no duplicates after restore', count === 3, String(count));

    // CSP blocks outside connections
    const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => false, () => true));
    check('CSP blocks fetch to an outside address', blocked);
    const outsideImg = await page.evaluate(() => new Promise((res) => { const i = new Image(); i.onload = () => res(false); i.onerror = () => res(true); i.src = 'https://example.com/x.png'; }));
    check('CSP blocks outside images', outsideImg);

    // Offline
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    check('works offline after first load', true);
    await ctx.setOffline(false);

    // Update banner: bump the served sw.js, ask for an update, tap the banner
    if (SERVE_DIR) {
      const swPath = path.join(SERVE_DIR, 'sw.js');
      const original = fs.readFileSync(swPath, 'utf8');
      fs.writeFileSync(swPath, original.replace(/VERSION = '[^']+'/, "VERSION = '9.9.9-test'"));
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await page.waitForSelector('#update-banner:not([hidden])', { timeout: 15000 });
      check('update banner appears for a new version', true);
      await page.waitForTimeout(1500);
      check('no automatic reload while the banner waits', (await page.$$('.note')).length === 2 && await page.isVisible('#update-banner'));
      await page.screenshot({ path: path.join(OUT, 'update-banner.png') });
      await Promise.all([page.waitForNavigation(), page.click('#update-button')]);
      await page.waitForSelector('#app:not([hidden])');
      const active = await page.evaluate(() => caches.keys());
      check('tapping the banner reloads into the new version', active.includes('daybook-code-9.9.9-test') && !active.includes('daybook-code-' + VERSION), JSON.stringify(active));
      fs.writeFileSync(swPath, original);
    }

    const csp = await page.evaluate(() => window.__csp);
    check('no CSP violations from the app itself', csp.every((v) => v.includes('example.com')), JSON.stringify(csp));
    await ctx.close();
  }

  // 3. Upgrade from the previous release: notes written there survive the schema migration
  if (OLD_BASE) {
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript(STANDALONE);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(OLD_BASE);
    await page.waitForSelector('#app:not([hidden])');
    for (const t of ['Written in the old version', 'Second old note']) {
      await page.fill('#capture-text', t);
      await page.click('#capture-add');
    }
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    const oldVersion = await page.evaluate(() => window.Daybook && window.Daybook.version);
    const oldBackup = await makeBackup(page, 'old-version-pass');
    check('previous release (' + oldVersion + ') wrote notes and a backup', fs.statSync(oldBackup).size > 37);

    await page.goto(BASE);
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2, null, { timeout: 10000 }).catch(() => {});
    const texts = await page.$$eval('.note-text', (els) => els.map((e) => e.textContent));
    check('notes from the previous release survive the upgrade', texts.join('|') === 'Written in the old version|Second old note', JSON.stringify(texts));
    const schema = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('daybook');
      r.onsuccess = () => { const db = r.result; res({ v: db.version, stores: Array.from(db.objectStoreNames) }); db.close(); };
    }));
    check('database upgraded to schema 2 with a media store', schema.v === 2 && schema.stores.includes('media') && schema.stores.includes('notes') && schema.stores.includes('meta'), JSON.stringify(schema));
    const meta = await page.evaluate(() => window.DaybookDB.getMeta('lastBackupAt'));
    check('app state (last backup time) kept through the upgrade', typeof meta === 'number');

    if (FIXTURES) {
      await page.setInputFiles('#photo-input', path.join(FIXTURES, 'rotated.jpg'));
      await page.waitForFunction(() => document.querySelectorAll('.note-photo img').length === 1, null, { timeout: 20000 });
      check('photo notes work on an upgraded database', true);
    }
    const sum1 = await openRestoreSummary(page, oldBackup, 'old-version-pass');
    check('backup from the previous release opens in the new one', sum1.includes('holds 2 notes.') && sum1.includes('already on this iPhone'), sum1);
    await finishRestore(page, false);
    await page.click('.note:nth-child(1) .note-text');
    await page.click('.edit-actions .btn-danger');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === (document.querySelectorAll('.note-photo').length ? 2 : 1));
    const sum2 = await openRestoreSummary(page, oldBackup, 'old-version-pass');
    await finishRestore(page, true);
    const restored = await page.$$eval('.note-text', (els) => els.map((e) => e.textContent));
    check('old backup restores a deleted note in the new version', restored.includes('Written in the old version') && sum2.includes('Restoring will add 1 note.'), sum2 + ' ' + JSON.stringify(restored));
    await ctx.close();
  }

  // 4. Photo notes
  if (FIXTURES) {
    const fx = (f) => path.join(FIXTURES, f);
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript(STANDALONE);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => navigator.serviceWorker.ready);
    const photoCount = () => page.$$eval('.note-photo img', (els) => els.length);
    const noteCount = () => page.$$eval('.note', (els) => els.length);

    // A 12 MP photo with location data, with a caption typed first
    await page.fill('#capture-text', 'Receipt for the new lamp');
    await page.setInputFiles('#photo-input', fx('camera.jpg'));
    await page.waitForFunction(() => document.querySelectorAll('.note-photo img').length === 1, null, { timeout: 30000 });
    check('photo note added from a picked photo', (await noteCount()) === 1);
    check('text in the note box becomes the caption', (await page.textContent('.note .note-text')) === 'Receipt for the new lamp');
    check('note box cleared after adding the photo', (await page.inputValue('#capture-text')) === '');
    const stored = await page.evaluate(async () => {
      const n = (await window.DaybookDB.allNotes())[0];
      const m = (await window.DaybookDB.getMedia([n.photos[0].id])).get(n.photos[0].id);
      const full = new Uint8Array(await m.blob.arrayBuffer());
      const ascii = (u) => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return s; };
      const head = ascii(full.subarray(0, Math.min(full.length, 4096)));
      const thumb = await createImageBitmap(m.thumb);
      return {
        w: m.width, h: m.height, noteW: n.photos[0].w, noteH: n.photos[0].h, type: m.blob.type, bytes: full.length,
        exif: head.includes('Exif'), marker: ascii(full).includes('SECRET-EXIF-MARKER'),
        tw: thumb.width, th: thumb.height, noteType: n.type
      };
    });
    const originalSize = fs.statSync(fx('camera.jpg')).size;
    check('photo shrunk on the phone to 2048 px on the long edge', stored.w === 2048 && stored.h === 1536 && stored.noteW === 2048, JSON.stringify(stored));
    check('photo saved as a smaller JPEG', stored.type === 'image/jpeg' && stored.bytes < originalSize / 2, stored.bytes + ' vs ' + originalSize);
    check('hidden photo details (EXIF incl. location) removed', !stored.exif && !stored.marker, JSON.stringify(stored));
    check('thumbnail made at 600 px', Math.max(stored.tw, stored.th) === 600, stored.tw + 'x' + stored.th);
    check('note marked as a photo note', stored.noteType === 'photo');

    // Camera rotation flag respected
    await page.setInputFiles('#photo-input', fx('rotated.jpg'));
    await page.waitForFunction(() => document.querySelectorAll('.note-photo img').length === 2, null, { timeout: 20000 });
    const rot = await page.evaluate(async () => {
      const notes = (await window.DaybookDB.allNotes()).sort((a, b) => a.createdAt - b.createdAt);
      const p = notes[notes.length - 1].photos[0];
      return { w: p.w, h: p.h };
    });
    check('sideways camera photo shown upright (rotation applied)', rot.w === 300 && rot.h === 400, JSON.stringify(rot));
    check('photo without caption offers "Add a caption"', (await page.textContent('.note:nth-child(2) .note-caption-add')) === 'Add a caption');

    // Several at once, including a transparent PNG
    await page.setInputFiles('#photo-input', [fx('transparent.png'), fx('rotated.jpg')]);
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 3, null, { timeout: 20000 });
    check('several photos picked together make one note', (await page.$$eval('.note:nth-child(3) .note-photo img', (e) => e.length)) === 2);
    const corner = await page.evaluate(async () => {
      const notes = (await window.DaybookDB.allNotes()).sort((a, b) => a.createdAt - b.createdAt);
      const id = notes[2].photos[0].id;
      const m = (await window.DaybookDB.getMedia([id])).get(id);
      const bmp = await createImageBitmap(m.blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(2, 2, 1, 1).data);
    });
    check('transparent areas become white, not black', corner[0] > 240 && corner[1] > 240 && corner[2] > 240, JSON.stringify(corner));

    // Unreadable files
    await page.setInputFiles('#photo-input', fx('broken.jpg'));
    await page.waitForFunction(() => document.getElementById('toast-text').textContent.includes('Couldn’t read that photo'), null, { timeout: 10000 });
    check('unreadable file explained, nothing added', (await noteCount()) === 3);
    await page.setInputFiles('#photo-input', [fx('broken.jpg'), fx('rotated.jpg')]);
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 4, null, { timeout: 20000 });
    check('a bad file in a batch is left out, the rest are kept', (await page.textContent('#toast-text')).includes('1 photo couldn’t be read'));

    // Ruled-line alignment with photos
    const aligned = await page.$$eval('.note', (els) => {
      const top = document.getElementById('page').getBoundingClientRect().top;
      return els.map((e) => Math.round((e.getBoundingClientRect().top - top) * 10) / 10);
    });
    check('photo notes keep the next note on the ruled lines', aligned.every((y) => Math.abs(y % 28) < 0.6 || Math.abs(y % 28) > 27.4), JSON.stringify(aligned));

    // Captions
    await page.click('.note:nth-child(2) .note-caption-add');
    await page.waitForSelector('.note-editor');
    check('caption editor opens with a Caption placeholder', (await page.getAttribute('.note-editor', 'placeholder')) === 'Caption');
    await page.fill('.note-editor', 'Tree outside the library');
    await page.click('.edit-actions .btn-primary');
    await page.waitForFunction(() => document.querySelector('.note:nth-child(2) .note-text') && document.querySelector('.note:nth-child(2) .note-text').textContent === 'Tree outside the library');
    check('caption added to a photo note', true);
    await page.click('.note:nth-child(1) .note-text');
    await page.fill('.note-editor', '');
    await page.click('.edit-actions .btn-primary');
    await page.waitForFunction(() => document.querySelector('.note:nth-child(1) .note-caption-add'));
    check('clearing a caption keeps the photo note', (await noteCount()) === 4 && (await photoCount()) === 5);
    await page.screenshot({ path: path.join(OUT, 'photos-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(OUT, 'photos-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });

    // Full-screen viewer
    await page.click('.note:nth-child(3) .note-photo >> nth=0');
    await page.waitForSelector('#viewer[open]');
    await page.waitForFunction(() => document.getElementById('viewer-img').complete && document.getElementById('viewer-img').naturalWidth > 0);
    check('tapping a photo opens it full screen', (await page.textContent('#viewer-count')) === '1 of 2');
    const fitted = await page.evaluate(() => {
      const s = document.getElementById('viewer-stage').getBoundingClientRect();
      const i = document.getElementById('viewer-img').getBoundingClientRect();
      return i.width <= s.width + 1 && i.height <= s.height + 1 && i.width > 100;
    });
    check('full-screen photo fits the screen', fitted);
    await page.screenshot({ path: path.join(OUT, 'viewer.png') });
    await page.click('#viewer-next');
    check('next photo in the note', (await page.textContent('#viewer-count')) === '2 of 2' && await page.isDisabled('#viewer-next'));
    await page.keyboard.press('ArrowLeft');
    check('arrow key goes back a photo', (await page.textContent('#viewer-count')) === '1 of 2');
    const swipeStage = (fromX, toX) => page.evaluate(([a, b]) => {
      const target = document.getElementById('viewer-stage');
      const mk = (x) => new Touch({ identifier: 7, target, clientX: x, clientY: 400 });
      target.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(a)], changedTouches: [mk(a)], bubbles: true, cancelable: true }));
      target.dispatchEvent(new TouchEvent('touchmove', { touches: [mk((a + b) / 2)], changedTouches: [mk((a + b) / 2)], bubbles: true, cancelable: true }));
      target.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(b)], bubbles: true, cancelable: true }));
    }, [fromX, toX]);
    await swipeStage(300, 80);
    check('swipe moves to the next photo', (await page.textContent('#viewer-count')) === '2 of 2');
    check('page day unchanged by swiping inside the viewer', (await page.textContent('#fulldate')).startsWith('Today'));
    const box = await page.$eval('#viewer-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.dblclick(box.x, box.y);
    check('double-tap zooms in', await page.$eval('#viewer-stage', (e) => e.classList.contains('is-zoomed')));
    const pinchOut = await page.evaluate(() => {
      const target = document.getElementById('viewer-stage');
      const t = (id, x) => new Touch({ identifier: id, target, clientX: x, clientY: 400 });
      target.dispatchEvent(new TouchEvent('touchstart', { touches: [t(1, 150), t(2, 250)], changedTouches: [t(1, 150), t(2, 250)], bubbles: true, cancelable: true }));
      target.dispatchEvent(new TouchEvent('touchmove', { touches: [t(1, 190), t(2, 210)], changedTouches: [t(1, 190), t(2, 210)], bubbles: true, cancelable: true }));
      target.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(1, 190), t(2, 210)], bubbles: true, cancelable: true }));
      return document.getElementById('viewer-stage').classList.contains('is-zoomed');
    });
    check('pinch zooms back out', pinchOut === false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('viewer').open);
    check('Escape closes the viewer', true);

    // Save / share from the viewer (download fallback in this browser)
    await page.click('.note:nth-child(2) .note-photo');
    await page.waitForSelector('#viewer[open]');
    const [saved] = await Promise.all([page.waitForEvent('download'), page.click('#viewer-share')]);
    const savedPath = path.join(OUT, saved.suggestedFilename());
    await saved.saveAs(savedPath);
    const savedBuf = fs.readFileSync(savedPath);
    check('Save hands over the full photo as a JPEG', savedBuf[0] === 0xFF && savedBuf[1] === 0xD8 && /^daybook-\d{4}-\d{2}-\d{2}-1\.jpg$/.test(saved.suggestedFilename()), saved.suggestedFilename());
    await page.click('#viewer-close');

    // Delete one photo from a note, then undo
    await page.click('.note:nth-child(3) .note-photo >> nth=1');
    await page.waitForSelector('#viewer[open]');
    await page.click('#viewer-delete');
    await page.waitForFunction(() => !document.getElementById('viewer').open && document.querySelectorAll('.note:nth-child(3) .note-photo').length === 1);
    check('delete removes just that photo', (await page.textContent('#toast-text')) === 'Photo deleted');
    const trashed = await page.evaluate(async () => {
      const notes = (await window.DaybookDB.allNotes()).sort((a, b) => a.createdAt - b.createdAt);
      return notes[2].photos.length;
    });
    await page.click('#toast-undo');
    await page.waitForFunction(() => document.querySelectorAll('.note:nth-child(3) .note-photo img').length === 2);
    check('undo puts the photo back', trashed === 1);
    check('photo count unchanged after undo', (await page.evaluate(() => window.DaybookDB.countMedia())) === 5);

    // Delete a whole photo note, undo, delete again, then clear it out
    await page.click('.note:nth-child(4) .note-caption-add');
    await page.click('.edit-actions .btn-danger');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 3);
    check('deleted photo note no longer counted', (await page.evaluate(() => window.DaybookDB.countMedia())) === 4);
    await page.click('#toast-undo');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 4 && document.querySelectorAll('.note:nth-child(4) .note-photo img').length === 1);
    check('undo brings a deleted photo note back with its photo', (await page.evaluate(() => window.DaybookDB.countMedia())) === 5);
    const safety = await page.evaluate(async () => {
      // Even if a photo a note still uses were wrongly marked deleted, clearing out must keep it.
      const notes = (await window.DaybookDB.allNotes()).sort((a, b) => a.createdAt - b.createdAt);
      const n = notes[0];
      await window.DaybookDB.updateNoteAndTrash(n, [n.photos[0].id]);
      const removed = await window.DaybookDB.sweepTrashedMedia(0);
      const still = (await window.DaybookDB.getMedia([n.photos[0].id])).size;
      await window.DaybookDB.restoreNote(n);
      return { removed, still };
    });
    check('clearing out never removes a photo a note still uses', safety.removed === 0 && safety.still === 1, JSON.stringify(safety));
    await page.click('.note:nth-child(4) .note-caption-add');
    await page.click('.edit-actions .btn-danger');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 3);
    const kept = await page.evaluate(() => window.DaybookDB.sweepTrashedMedia(10 * 60 * 1000));
    const cleared = await page.evaluate(() => window.DaybookDB.sweepTrashedMedia(0));
    check('recently deleted photos kept for undo, older ones cleared', kept === 0 && cleared === 1, kept + '/' + cleared);

    // Settings count
    await page.click('#open-settings');
    await page.waitForFunction(() => document.getElementById('fact-photos').textContent === '4');
    check('settings show the number of photos', true);
    await page.click('#close-settings');

    // Backup with photos, lose a photo note, restore it
    const before = await page.evaluate(async () => {
      const notes = (await window.DaybookDB.allNotes()).sort((a, b) => a.createdAt - b.createdAt);
      const id = notes[0].photos[0].id;
      const m = (await window.DaybookDB.getMedia([id])).get(id);
      return { id, bytes: m.blob.size, thumb: m.thumb.size };
    });
    const backupFile = await makeBackup(page, 'photo-backup-pass');
    const raw = fs.readFileSync(backupFile);
    check('backup with photos is encrypted (no readable photo data or captions)', raw.slice(0, 4).toString() === 'DYBK' && !raw.includes(Buffer.from('JFIF')) && !raw.includes(Buffer.from('Tree outside')));
    await page.click('.note:nth-child(1) .note-caption-add');
    await page.click('.edit-actions .btn-danger');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    await page.evaluate(() => window.DaybookDB.sweepTrashedMedia(0));
    const summary = await openRestoreSummary(page, backupFile, 'photo-backup-pass');
    check('restore summary counts photos', summary.includes('holds 3 notes and 4 photos.') && summary.includes('Restoring will add 1 note and 1 photo.'), summary);
    await finishRestore(page, true);
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 3 && document.querySelectorAll('.note-photo img').length === 4);
    const after = await page.evaluate(async (id) => {
      const m = (await window.DaybookDB.getMedia([id])).get(id);
      return m ? { bytes: m.blob.size, thumb: m.thumb.size, trashed: !!m.trashedAt } : null;
    }, before.id);
    check('restored photo is identical to the original', after && after.bytes === before.bytes && after.thumb === before.thumb && !after.trashed, JSON.stringify([before, after]));
    const again = await openRestoreSummary(page, backupFile, 'photo-backup-pass');
    await finishRestore(page, false);
    check('restoring the same backup again adds nothing', again.includes('nothing to restore') && (await page.evaluate(() => window.DaybookDB.countMedia())) === 4, again);

    // Photos work offline
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.note-photo img').length === 4);
    const loaded = await page.$$eval('.note-photo img', (els) => Promise.all(els.map((i) => i.decode().then(() => i.naturalWidth > 0, () => false))));
    check('photos show offline', loaded.every(Boolean), JSON.stringify(loaded));
    await ctx.setOffline(false);

    const csp = await page.evaluate(() => window.__csp);
    check('no CSP violations with photos', csp.length === 0, JSON.stringify(csp));
    await ctx.close();
  }

  // 5. Search, looking back and On this day
  {
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript(STANDALONE);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.waitForSelector('#app:not([hidden])');
    check('no On this day slip without earlier years', await page.isHidden('#look-back'));
    await page.fill('#capture-text', 'Bought coffee beans');
    await page.click('#capture-add');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 1);

    const seeded = await page.evaluate(async () => {
      const pad = (n) => String(n).padStart(2, '0');
      const key = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const at = (daysBack, yearsBack, h) => { const d = new Date(); d.setHours(h, 15, 0, 0); d.setFullYear(d.getFullYear() - yearsBack); d.setDate(d.getDate() - daysBack); return d; };
      const mk = async (d, text) => { const n = { id: crypto.randomUUID(), day: key(d), createdAt: d.getTime(), updatedAt: d.getTime(), type: 'text', text }; await window.DaybookDB.putNote(n); return n; };
      await mk(at(7, 0, 9), 'Called the plumber about the kitchen tap');
      await mk(at(3, 0, 8), '<img src=x onerror="window.__xss=1"> ask the plumber again');
      await mk(at(40, 0, 20), 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation. Saw a giraffe at the zoo.');
      await mk(at(0, 1, 18), 'Sunset over the bay with Zoë');
      await mk(at(0, 2, 9), 'First day at the new job');
      const c = document.createElement('canvas'); c.width = 120; c.height = 90;
      const g = c.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 120, 90);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      const d = at(2, 0, 10); const noteId = crypto.randomUUID(); const mid = crypto.randomUUID();
      await window.DaybookDB.addNoteWithMedia(
        { id: noteId, day: key(d), createdAt: d.getTime(), updatedAt: d.getTime(), type: 'photo', text: 'Receipt for the garden hose', photos: [{ id: mid, w: 120, h: 90 }] },
        [{ id: mid, noteId, blob, thumb: blob, type: 'image/jpeg', width: 120, height: 90, bytes: blob.size, createdAt: d.getTime() }]);
      const y = new Date().getFullYear();
      return { y1: String(y - 1), y2: String(y - 2) };
    });
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#look-back:not([hidden])', { timeout: 5000 }).catch(() => {});
    const slipTitle = await page.textContent('#look-back-title');
    check('On this day slip shows earlier years on today\'s page', await page.isVisible('#look-back') && slipTitle === 'On this day in ' + seeded.y2 + ' and ' + seeded.y1, slipTitle);
    check('slip quotes the most recent year\'s note and counts the rest', (await page.textContent('#look-back-excerpt')) === 'Sunset over the bay with Zoë' && (await page.textContent('#look-back-more')) === 'and 1 more note');
    const alignedWithSlip = await page.$$eval('.note', (els) => {
      const top = document.getElementById('page').getBoundingClientRect().top;
      return els.every((e) => { const y = (e.getBoundingClientRect().top - top) % 28; return y < 0.6 || y > 27.4; });
    });
    check('notes stay on the ruled lines below the slip', alignedWithSlip);
    await page.screenshot({ path: path.join(OUT, 'on-this-day.png') });

    // Open search: empty box shows looking back
    await page.click('#open-search');
    await page.waitForSelector('#search:not([hidden])');
    check('search opens with the cursor in the search box', await page.evaluate(() => document.activeElement.id === 'search-input'));
    await page.waitForFunction(() => document.querySelectorAll('.result-day').length > 0);
    const agoLabels = await page.$$eval('.result-ago', (els) => els.map((e) => e.textContent));
    check('empty search shows a week ago and this date in earlier years', JSON.stringify(agoLabels) === '["A week ago","A year ago","2 years ago"]', JSON.stringify(agoLabels));
    check('empty search explains what search covers', (await page.textContent('#search-status')).includes('Type to search every note'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'search-lookback.png') });

    const typeQuery = async (q) => {
      await page.fill('#search-input', q);
      await page.waitForFunction((q) => document.getElementById('search-input').value === q && document.getElementById('search-status').textContent.length > 0, q);
      await page.waitForTimeout(250);
    };
    await typeQuery('zoe');
    check('accent-insensitive search with the original spelling highlighted', (await page.$$eval('mark', (m) => m.map((e) => e.textContent))).join() === 'Zoë');
    await typeQuery('kitchen plumber');
    check('every word must match, in any order', (await page.textContent('#search-status')) === '1 note on 1 day' && (await page.$$('.result')).length === 1, await page.textContent('#search-status'));
    await typeQuery('plumber');
    const order = await page.$$eval('.result-ago', (els) => els.map((e) => e.textContent));
    check('results grouped by day, newest first', JSON.stringify(order) === '["3 days ago","A week ago"]', JSON.stringify(order));
    const safe = await page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('.result-text img').length, text: document.querySelector('.result-text').textContent }));
    check('note text shown as text, never run as code', safe.xss === undefined && safe.imgs === 0 && safe.text.startsWith('<img'), JSON.stringify(safe));
    const ruled = await page.evaluate(() => {
      const top = document.querySelector('.search-sheet').getBoundingClientRect().top;
      return Array.from(document.querySelectorAll('.result-day-head, .result')).every((e) => { const y = (e.getBoundingClientRect().top - top) % 28; return y < 0.6 || y > 27.4; });
    });
    check('results sit on the ruled lines', ruled);
    await page.screenshot({ path: path.join(OUT, 'search-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(OUT, 'search-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });

    await typeQuery('receipt');
    await page.waitForFunction(() => { const i = document.querySelector('.result-thumb'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).catch(() => {});
    check('photo captions are searched and show a thumbnail', await page.evaluate(() => { const i = document.querySelector('.result-thumb'); return !!i && i.src.startsWith('blob:') && i.naturalWidth > 0; }));
    await typeQuery('giraffe');
    const long = await page.textContent('.result-text');
    check('long notes are trimmed to show the match', long.startsWith('…') && long.includes('giraffe') && !long.includes('Lorem'), long);
    await typeQuery('zzzz');
    check('no matches explained', (await page.textContent('#search-status')).startsWith('No notes match “zzzz”.'));
    await page.click('#search-clear');
    await page.waitForFunction(() => document.getElementById('search-input').value === '' && document.querySelectorAll('.result-day').length === 3);
    check('clear button empties the box and shows looking back again', true);

    // Swiping inside search leaves the day alone
    await page.evaluate(() => {
      const target = document.querySelector('.search-sheet');
      const mk = (x) => new Touch({ identifier: 3, target, clientX: x, clientY: 400 });
      target.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(300)], changedTouches: [mk(300)], bubbles: true }));
      target.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(60)], bubbles: true }));
    });
    await page.waitForTimeout(300);
    check('swiping in search doesn’t change the day', (await page.textContent('#fulldate')).startsWith('Today'));

    // Open a result
    await typeQuery('kitchen plumber');
    await page.click('.result');
    await page.waitForSelector('#search', { state: 'hidden' });
    await page.waitForFunction(() => !!document.querySelector('.note.is-found'), null, { timeout: 5000 }).catch(() => {});
    check('tapping a result opens that day at the note', !(await page.textContent('#fulldate')).startsWith('Today') &&
      (await page.$eval('.note.is-found .note-text', (e) => e.textContent).catch(() => '')) === 'Called the plumber about the kitchen tap');
    check('On this day slip only on today\'s page', await page.isHidden('#look-back'));
    await page.screenshot({ path: path.join(OUT, 'found-note.png') });
    await page.keyboard.press('/');
    await page.waitForSelector('#search:not([hidden])');
    check('the / key opens search, keeping the last search', (await page.inputValue('#search-input')) === 'kitchen plumber');
    await page.waitForFunction(() => document.querySelectorAll('.result').length === 1);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#search', { state: 'hidden' });
    check('Escape closes search', await page.evaluate(() => document.activeElement.id === 'open-search'));

    // Day heading opens the day; Look back from the slip; Hide the slip
    await page.click('#go-today');
    await page.waitForSelector('#look-back:not([hidden])');
    await page.click('#look-back-open');
    await page.waitForSelector('#search:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.result-day').length === 3);
    check('Look back opens the looking-back list with an empty box', (await page.inputValue('#search-input')) === '');
    await page.click('.result-day-head >> nth=2');
    await page.waitForSelector('#search', { state: 'hidden' });
    await page.waitForFunction((y) => document.getElementById('fulldate').textContent.includes(y), seeded.y2);
    await page.waitForFunction(() => { const n = document.querySelector('.note-text'); return n && n.textContent === 'First day at the new job'; }, null, { timeout: 5000 }).catch(() => {});
    check('tapping a day heading opens that day', (await page.textContent('.note-text')) === 'First day at the new job');
    await page.click('#go-today');
    await page.waitForSelector('#look-back:not([hidden])');
    await page.click('#look-back-hide');
    check('Hide puts the slip away', await page.isHidden('#look-back'));
    await page.waitForFunction(() => window.DaybookDB.getMeta('lookBackHiddenDay').then((v) => !!v));
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 1);
    await page.waitForTimeout(400);
    check('a hidden slip stays hidden for the rest of today', await page.isHidden('#look-back'));

    // Search works offline
    await page.evaluate(() => navigator.serviceWorker.ready);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.click('#open-search');
    await page.fill('#search-input', 'job');
    await page.waitForFunction(() => document.querySelectorAll('.result').length === 1, null, { timeout: 5000 }).catch(() => {});
    check('search works offline', (await page.$$('.result')).length === 1);
    await ctx.setOffline(false);

    const csp = await page.evaluate(() => window.__csp);
    check('no CSP violations in search', csp.length === 0, JSON.stringify(csp));
    await ctx.close();
  }

  // 6. To-dos, pins and hashtags
  {
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript(STANDALONE);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.waitForSelector('#app:not([hidden])');
    const noteCount = () => page.$$eval('.note', (els) => els.length);
    const dbNotes = () => page.evaluate(async () => (await window.DaybookDB.allNotes()).sort((a, b) => a.createdAt - b.createdAt));

    // Build a checklist with the to-do button and Return
    await page.click('#capture-text');
    await page.click('#capture-todo');
    check('to-do button starts a box in the note box', (await page.inputValue('#capture-text')) === '[ ] ');
    check('note box keeps focus after the to-do button', await page.evaluate(() => document.activeElement.id === 'capture-text'));
    await page.keyboard.type('Milk');
    await page.keyboard.press('Enter');
    check('Return starts the next to-do', (await page.inputValue('#capture-text')) === '[ ] Milk\n[ ] ');
    await page.keyboard.type('Eggs #shopping');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Bread');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    check('Return on an empty to-do ends the list', (await page.inputValue('#capture-text')) === '[ ] Milk\n[ ] Eggs #shopping\n[ ] Bread\n');
    await page.keyboard.type('From the corner shop');
    await page.click('#capture-add');
    await page.waitForFunction(() => document.querySelectorAll('.todo-box').length === 3);
    check('checklist note shows tick boxes', (await page.$$eval('.todo-text', (e) => e.map((x) => x.textContent))).join('|') === 'Milk|Eggs #shopping|Bread');
    check('plain line in a checklist stays text', (await page.textContent('.note-text .line')) === 'From the corner shop');
    check('progress shown in the margin', (await page.textContent('.note-progress')) === '0 of 3');

    await page.click('.todo-box >> nth=0');
    await page.waitForFunction(() => document.querySelector('.todo-box').getAttribute('aria-checked') === 'true');
    check('ticking a box doesn’t open the editor', await page.isHidden('.note-editor').catch(() => true) && !(await page.$('.note-editor')));
    check('ticked item crossed through, progress updated', await page.$eval('.todo', (e) => e.classList.contains('is-done')) && (await page.textContent('.note-progress')) === '1 of 3');
    await page.waitForFunction(() => window.DaybookDB.allNotes().then((n) => n[0].text.startsWith('[x] Milk')));
    check('tick saved to the note text', (await dbNotes())[0].text === '[x] Milk\n[ ] Eggs #shopping\n[ ] Bread\nFrom the corner shop');
    await page.click('.todo-box >> nth=1');
    await page.click('.todo-box >> nth=2');
    await page.waitForFunction(() => document.getElementById('toast-text').textContent.startsWith('All done'));
    check('ticking the last box says all done', (await page.textContent('.note-progress')) === '3 of 3');
    await page.click('.todo-box >> nth=2');
    await page.waitForFunction(() => document.querySelectorAll('.todo-box[aria-checked="true"]').length === 2);
    check('a box can be unticked', true);

    // Tag chips, other notes, ruled lines
    await page.fill('#capture-text', 'Fixed the #garden gate with #Sam. Not a tag: C# or #42');
    await page.click('#capture-add');
    await page.fill('#capture-text', '[ ] <img src=x onerror="window.__xss2=1"> sort the #garden shed');
    await page.click('#capture-add');
    await page.fill('#capture-text', 'Plain note at the end');
    await page.click('#capture-add');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 4);
    check('hashtags become chips (and only real ones)', (await page.$$eval('.note:nth-child(2) .tag', (e) => e.map((x) => x.textContent))).join() === '#garden,#Sam');
    check('chip text keeps the note readable', (await page.textContent('.note:nth-child(2) .note-text')) === 'Fixed the #garden gate with #Sam. Not a tag: C# or #42');
    check('note text in to-dos shown as text, never run as code', await page.evaluate(() => window.__xss2 === undefined && !document.querySelector('.todo-text img')));
    const aligned = await page.$$eval('.note', (els) => {
      const top = document.getElementById('page').getBoundingClientRect().top;
      return els.map((e) => Math.round((e.getBoundingClientRect().top - top) * 10) / 10);
    });
    check('to-dos and tags keep notes on the ruled lines', aligned.every((y) => Math.abs(y % 28) < 0.6 || Math.abs(y % 28) > 27.4), JSON.stringify(aligned));
    const rows = await page.$$eval('.note:nth-child(1) .todo, .note:nth-child(1) .line', (els) => els.map((e) => e.getBoundingClientRect().height));
    check('each checklist line is one ruled line tall', rows.every((h) => Math.abs(h - 28) < 0.6), JSON.stringify(rows));
    await page.screenshot({ path: path.join(OUT, 'todos-light.png') });

    // Tapping a tag opens search for it
    await page.click('.note:nth-child(2) .tag >> nth=0');
    await page.waitForSelector('#search:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.result').length > 0);
    check('tapping a tag searches for it', (await page.inputValue('#search-input')) === '#garden' && (await page.$$('.result')).length === 2 && !(await page.$('.note-editor')));
    check('search results draw to-do boxes', (await page.$$eval('.result-text', (e) => e.map((x) => x.textContent))).some((t) => t.startsWith('☐ ')));
    await page.click('#search-clear');
    await page.waitForSelector('#search-tags:not([hidden])');
    const tagList = await page.$$eval('.tag-pill', (e) => e.map((x) => x.textContent));
    check('empty search lists every tag, most used first', JSON.stringify(tagList) === '["#garden2","#Sam1","#shopping1"]', JSON.stringify(tagList));
    await page.screenshot({ path: path.join(OUT, 'search-tags.png') });
    await page.click('.tag-pill >> nth=1');
    await page.waitForFunction(() => document.getElementById('search-input').value === '#Sam' && document.querySelectorAll('.result').length === 1);
    check('tapping a listed tag searches for it', await page.isHidden('#search-tags'));
    await page.click('#close-search');

    // Pin a note to the top of the day
    await page.click('.note:nth-child(4) .note-text');
    await page.waitForSelector('.note-editor');
    check('editor offers a pin button', (await page.getAttribute('.edit-pin', 'aria-pressed')) === 'false');
    await page.click('.edit-pin');
    await page.waitForFunction(() => document.querySelector('.note:nth-child(1) .note-text') && document.querySelector('.note:nth-child(1) .note-text').textContent === 'Plain note at the end');
    check('pinned note moves to the top with a pin', await page.isVisible('.note:nth-child(1) .note-pin') && (await page.textContent('#toast-text')) === 'Pinned to the top of the day');
    check('a dashed rule separates pinned notes from the rest', await page.$eval('.note:nth-child(2)', (e) => e.classList.contains('after-pins')));
    check('editor closed after pinning', !(await page.$('.note-editor')));
    const pinned = (await dbNotes()).filter((n) => n.pinned).map((n) => n.text);
    check('pin saved', JSON.stringify(pinned) === '["Plain note at the end"]', JSON.stringify(pinned));
    const alignedPins = await page.$$eval('.note', (els) => {
      const top = document.getElementById('page').getBoundingClientRect().top;
      return els.every((e) => { const y = (e.getBoundingClientRect().top - top) % 28; return y < 0.6 || y > 27.4; });
    });
    check('pinned notes keep the ruled lines', alignedPins);
    await page.screenshot({ path: path.join(OUT, 'pinned-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(OUT, 'pinned-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.click('#toast-undo');
    await page.waitForFunction(() => document.querySelector('.note:nth-child(4) .note-text').textContent === 'Plain note at the end' && !document.querySelector('.note-pin'));
    check('undo takes the pin back', !(await dbNotes()).some((n) => n.pinned));

    // Pin while editing keeps the edit; the editor's to-do button
    await page.click('.note:nth-child(2) .note-text');
    await page.waitForSelector('.note-editor');
    await page.fill('.note-editor', 'Garden gate fixed #garden');
    await page.click('.edit-pin');
    await page.waitForFunction(() => document.querySelector('.note:nth-child(1) .note-text').textContent === 'Garden gate fixed #garden');
    check('pinning while editing saves the edit too', (await dbNotes()).find((n) => n.pinned).text === 'Garden gate fixed #garden');
    await page.click('.note:nth-child(4) .note-text');
    await page.waitForSelector('.note-editor');
    await page.click('.edit-todo');
    check('editor to-do button turns the line into a to-do', (await page.inputValue('.note-editor')) === '[ ] Plain note at the end');
    await page.click('.edit-actions .btn-primary');
    await page.waitForFunction(() => document.querySelectorAll('.note:nth-child(4) .todo-box').length === 1);
    check('saved line becomes a tick box', true);
    await page.screenshot({ path: path.join(OUT, 'editor-tools.png') });

    // Survives reload; backups keep pins and ticks
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 4);
    check('pins and ticks kept after reload', await page.isVisible('.note:nth-child(1) .note-pin') && (await page.$$('.todo-box[aria-checked="true"]')).length === 2);
    const backupFile = await makeBackup(page, 'todo-pin-backup');
    const pinnedId = (await dbNotes()).find((n) => n.pinned).id;
    await page.evaluate(async (id) => { const n = await window.DaybookDB.getNote(id); await window.DaybookDB.deleteNote(n); }, pinnedId);
    await page.evaluate(async () => {
      const n = (await window.DaybookDB.allNotes()).find((x) => x.text.startsWith('[x] Milk'));
      await window.DaybookDB.deleteNote(n);
    });
    const summary = await openRestoreSummary(page, backupFile, 'todo-pin-backup');
    await finishRestore(page, true);
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 4);
    const back = await dbNotes();
    check('restore brings back pins and ticked boxes', summary.includes('Restoring will add 2 notes.') && back.find((n) => n.id === pinnedId).pinned === true &&
      back.some((n) => n.text === '[x] Milk\n[x] Eggs #shopping\n[ ] Bread\nFrom the corner shop'), summary);

    const csp = await page.evaluate(() => window.__csp);
    check('no CSP violations with to-dos, pins and tags', csp.length === 0, JSON.stringify(csp));
    await ctx.close();
  }

  const appErrors = errors.filter((e) => !e.includes('example.com') && !e.includes('Content Security Policy') && !e.includes('net::ERR_INTERNET_DISCONNECTED'));
  check('no console errors', appErrors.length === 0, JSON.stringify(appErrors));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

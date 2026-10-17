// Headless browser test. Serve the folder that CONTAINS daybook/ on a local port, then:
//   BASE=http://localhost:8765/daybook/ OUT=/tmp/out node tests/browser-smoke.js
// Optional: SERVE_DIR=<path to the served daybook folder> lets the test bump sw.js to check the update banner.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = process.env.BASE || 'http://localhost:8765/daybook/';
const OUT = process.env.OUT || path.join(__dirname, '..', '.test-output');
const SERVE_DIR = process.env.SERVE_DIR || '';
fs.mkdirSync(OUT, { recursive: true });

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
    check('settings show note count and version', (await page.textContent('#fact-version')) === '1.0.0');
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
    check('restore summary before writing', summary.includes('3 notes') && summary.includes('Of those, 1 will be added and 2 are already here'), summary);
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
      check('tapping the banner reloads into the new version', active.includes('daybook-code-9.9.9-test') && !active.includes('daybook-code-1.0.0'), JSON.stringify(active));
      fs.writeFileSync(swPath, original);
    }

    const csp = await page.evaluate(() => window.__csp);
    check('no CSP violations from the app itself', csp.every((v) => v.includes('example.com')), JSON.stringify(csp));
    await ctx.close();
  }

  const appErrors = errors.filter((e) => !e.includes('example.com') && !e.includes('Content Security Policy') && !e.includes('net::ERR_INTERNET_DISCONNECTED'));
  check('no console errors', appErrors.length === 0, JSON.stringify(appErrors));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

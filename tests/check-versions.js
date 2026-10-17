// Checks the version is the same everywhere. Run: node tests/check-versions.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const log = JSON.parse(read('BUILDLOG.json'));
const app = read('js/app.js').match(/APP_VERSION = '([^']+)'/)[1];
const sw = read('sw.js').match(/VERSION = '([^']+)'/)[1];
const schema = (read('js/db.js').match(/function toV\d+/g) || []).length;
const ok = log.version === app && app === sw && log.schemaVersion === schema;
console.log(`BUILDLOG ${log.version}, app.js ${app}, sw.js ${sw}, schema BUILDLOG ${log.schemaVersion} / db.js ${schema}: ${ok ? 'OK' : 'MISMATCH'}`);
// Every file the service worker caches must exist.
const files = read('sw.js').match(/var FILES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
const missing = files.filter((f) => f !== './' && !fs.existsSync(path.join(root, f)));
if (missing.length) console.log('Missing cached files: ' + missing.join(', '));
process.exit(ok && !missing.length ? 0 : 1);

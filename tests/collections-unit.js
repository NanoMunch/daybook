// Unit checks for js/collections.js. Run: node tests/collections-unit.js
'use strict';
require('../js/collections.js');
const C = globalThis.DaybookCollections;

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
}
const vals = (kind, text) => C.find(kind, text).map((f) => f.value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function expect(kind, text, want) {
  const got = vals(kind, text);
  check(kind + ': ' + JSON.stringify(text), same(got, want), got);
}

// Links
expect('links', 'Read https://example.com/a?b=1, then sleep.', ['https://example.com/a?b=1']);
expect('links', 'see www.abc.net.au.', ['www.abc.net.au']);
expect('links', 'Booked on airbnb.com/rooms/123 (great view)', ['airbnb.com/rooms/123']);
expect('links', '(see en.wikipedia.org/wiki/Foo_(bar))', ['en.wikipedia.org/wiki/Foo_(bar)']);
expect('links', 'email sam@example.com about it', []);
expect('links', 'version 1.2 and e.g. this, i.e. that', []);
expect('links', 'Mr.Smith arrived at 3.30', []);
check('links: href adds https', C.find('links', 'go to github.com/x')[0].href === 'https://github.com/x');
check('links: href keeps http', C.find('links', 'http://old.site.org')[0].href === 'http://old.site.org/');
check('links: offsets point at the text', (() => { const t = 'x https://a.com y'; const f = C.find('links', t)[0]; return t.slice(f.start, f.end) === 'https://a.com'; })());

// Emails
expect('emails', 'Write to Sam.Lee+news@mail.example.com.au today', ['Sam.Lee+news@mail.example.com.au']);
expect('emails', 'no @ here, @handle', []);
check('emails: mailto href', C.find('emails', 'a@b.co')[0].href === 'mailto:a@b.co');

// Phones
expect('phones', 'Call Jo on 0412 345 678 tomorrow', ['0412 345 678']);
expect('phones', 'Plumber (03) 9876 5432.', ['(03) 9876 5432']);
expect('phones', 'office +61 3 9876 5432', ['+61 3 9876 5432']);
expect('phones', '1300 655 506 or 13 22 21', ['1300 655 506', '13 22 21']);
expect('phones', 'call 0412-345-678 2 times', ['0412-345-678']);
expect('phones', 'US friend +1 415 555 0100', ['+1 415 555 0100']);
expect('phones', 'Ran 10000 steps on 2026-10-26, order #0412345678', []);
expect('phones', 'Invoice 20261026 total $1234 5678', []);
expect('phones', 'meet 26/10/2026 at 10:30', []);
check('phones: tel href is digits', C.find('phones', 'ring (03) 9876 5432')[0].href === 'tel:0398765432');
check('phones: tel href keeps +', C.find('phones', '+61 412 345 678')[0].href === 'tel:+61412345678');

// Money
expect('money', 'Lunch $14.50 and coffee $4', ['$14.50', '$4']);
expect('money', 'Rent A$2,100 a month; US$ 30 for the app', ['A$2,100', 'US$ 30']);
expect('money', 'Paid 20 bucks, owe 15 dollars, €12, £3.99, AUD 40', ['20 bucks', '15 dollars', '€12', '£3.99', 'AUD 40']);
expect('money', 'Saved $5k this year', ['$5k']);
expect('money', 'Ran 5 km, bought 3 apples, 50% off', []);

// Places
expect('places', 'Dinner at 12 Smith St, Fitzroy VIC 3065 at 7', ['12 Smith St, Fitzroy VIC 3065']);
expect('places', 'New flat: 3/45 Lygon Street, Carlton', ['3/45 Lygon Street, Carlton']);
expect('places', 'Unit 2, 8 Little Collins St.', ['Unit 2, 8 Little Collins St']);
expect('places', 'meet at 101 collins st after work', ['101 collins st']);
expect('places', 'Parcel is at the post office in Brunswick VIC 3056', ['Brunswick VIC 3056']);
expect('places', 'I had 3 coffees and walked 2 blocks down the street', []);
expect('places', 'met 3 people at smith st', []);
expect('places', 'Bought 2 Big Macs', []);
check('places: Apple Maps href', C.find('places', '12 Smith St')[0].href === 'https://maps.apple.com/?q=12%20Smith%20St');

// Ideas
expect('ideas', 'Idea: a jar for spare buttons', ['Idea']);
expect('ideas', 'groceries\nwhat if the shed had a skylight', ['what if']);
expect('ideas', 'Would be cool if the bike had a basket #ideas', ['Would be cool if', '#ideas']);
expect('ideas', 'Maybe we could paint the fence', ['Maybe we could']);
expect('ideas', 'Someday I’ll learn the cello', ['Someday I’ll']);
expect('ideas', 'I have no ideas about lunch. What a day.', []);
expect('ideas', 'Ideally we leave at 9', []);

// To-dos
expect('todos', '[ ] milk\n[x] bread\n  [ ] eggs\nplain', ['milk', 'eggs']);
expect('todos', '☐ milk\n☑ bread', ['milk']);
expect('todos', '[x] all done', []);

// has() and sort()
const notes = [
  { id: 'a', day: '2026-10-20', createdAt: 1, text: 'see example.com' },
  { id: 'b', day: '2026-10-22', createdAt: 2, text: '', photos: [{ id: 'p' }] },
  { id: 'c', day: '2026-10-22', createdAt: 1, text: 'call 0412 345 678', pinned: true },
  { id: 'd', day: '2026-10-21', createdAt: 1, text: '', audio: [{ id: 'v' }] },
  { id: 'e', day: '2026-10-21', createdAt: 2, text: '[ ] pay $40 to sam@x.com' }
];
const sorted = C.sort(notes);
const ids = (k) => sorted.get(k).map((n) => n.id).join();
check('sort: links', ids('links') === 'a', ids('links'));
check('sort: photos', ids('photos') === 'b', ids('photos'));
check('sort: voice', ids('voice') === 'd', ids('voice'));
check('sort: pinned', ids('pinned') === 'c', ids('pinned'));
check('sort: phones', ids('phones') === 'c', ids('phones'));
check('sort: one note in several collections', ids('todos') === 'e' && ids('money') === 'e' && ids('emails') === 'e');
check('sort: newest day first, page order within a day', C.sort(notes.map((n) => Object.assign({}, n, { pinned: true }))).get('pinned').map((n) => n.id).join() === 'c,b,d,e,a');
check('every kind has a label', C.kinds.every((k) => k.label && k.hint && sorted.has(k.kind)));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

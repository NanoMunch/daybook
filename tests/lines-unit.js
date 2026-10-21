// Unit tests for to-do lines and hashtags. Run: node tests/lines-unit.js
'use strict';
require('../js/lines.js');
const L = globalThis.DaybookLines;
let failed = 0;
let total = 0;
function eq(name, got, want) {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
}

// Parsing
const list = 'Shopping\n[ ] milk\n[x] eggs\n[]bread\n  [X] indented\n[link] not a box';
eq('isChecklist', L.isChecklist(list), true);
eq('plain text is not a checklist', L.isChecklist('Call [Sam] about [x-ray]'), false);
eq('parse kinds', L.parse(list).map((p) => [p.todo, p.done, p.body]), [
  [false, false, 'Shopping'], [true, false, 'milk'], [true, true, 'eggs'], [true, false, 'bread'], [true, true, 'indented'], [false, false, '[link] not a box']]);
eq('counts', L.counts(list), { done: 2, total: 4 });

// Toggle
eq('tick an item', L.toggle(list, 1).split('\n')[1], '[x] milk');
eq('untick an item', L.toggle(list, 2).split('\n')[2], '[ ] eggs');
eq('tick keeps indentation', L.toggle(list, 4).split('\n')[4], '  [ ] indented');
eq('tick leaves other lines alone', L.toggle(list, 1).split('\n').filter((l, i) => i !== 1), list.split('\n').filter((l, i) => i !== 1));
eq('toggle on a plain line changes nothing', L.toggle(list, 0), list);
eq('toggle past the end changes nothing', L.toggle(list, 99), list);

// The to-do button
eq('button on empty box', L.toggleMarker('', 0), { value: '[ ] ', cursor: 4 });
eq('button on a typed line', L.toggleMarker('buy milk', 8), { value: '[ ] buy milk', cursor: 12 });
eq('button on second line', L.toggleMarker('List\nmilk', 7), { value: 'List\n[ ] milk', cursor: 11 });
eq('button removes a box', L.toggleMarker('[ ] milk', 8), { value: 'milk', cursor: 4 });
eq('button removes a box with the cursor inside it', L.toggleMarker('[x] milk', 1), { value: 'milk', cursor: 0 });

// Return inside a list
eq('return continues the list', L.enterAt('[ ] milk', 8), { value: '[ ] milk\n[ ] ', cursor: 13 });
eq('return keeps indentation', L.enterAt('  [x] milk', 10), { value: '  [x] milk\n  [ ] ', cursor: 17 });
eq('return on an empty box ends the list', L.enterAt('[ ] milk\n[ ] ', 13), { value: '[ ] milk\n', cursor: 9 });
eq('return in the middle of an item splits it', L.enterAt('[ ] milk eggs', 8), { value: '[ ] milk\n[ ]  eggs', cursor: 13 });
eq('return on a plain line is normal', L.enterAt('milk', 4), null);
eq('return at the very start of a box line is normal', L.enterAt('[ ] milk', 0), null);

// Tidy
eq('tidy drops a trailing empty box', L.tidy('[ ] milk\n[ ] '), '[ ] milk');
eq('tidy drops a lone empty box', L.tidy('[ ] '), '');
eq('tidy keeps empty boxes in the middle', L.tidy('[ ] milk\n[ ] \n[ ] eggs'), '[ ] milk\n[ ] \n[ ] eggs');

// Display
eq('display draws boxes', L.display('Shop\n[ ] milk\n[x] eggs'), 'Shop\n☐ milk\n☑ eggs');

// Hashtags
eq('tags found', L.tags('Fixed the #garden gate #DIY, then #garden again'), ['garden', 'DIY']);
eq('tags with hyphens and accents', L.tags('#trip-2027 to #Zürich.'), ['trip-2027', 'Zürich']);
eq('not tags', L.tags('C# and &#39; and site.com/#part and #1 and #42 and mid#word'), []);
eq('tag at the very start and after brackets', L.tags('#first (#second) "#third"'), ['first', 'second', 'third']);
eq('segments', L.segments('Ask #Sam re: #plumber!'), [{ text: 'Ask ' }, { text: '#Sam', tag: 'Sam' }, { text: ' re: ' }, { text: '#plumber', tag: 'plumber' }, { text: '!' }]);
eq('segments without tags', L.segments('plain'), [{ text: 'plain' }]);
eq('segments keep every character', L.segments('a #b-c- #d\n#e').map((s) => s.text).join(''), 'a #b-c- #d\n#e');
eq('tagKey folds case and accents', L.tagKey('Zürich'), 'zurich');
eq('tag index counts notes, most used first, common spelling', L.tagIndex([
  { text: '#Home and #home' }, { text: '#home' }, { text: '#work' }, { text: '#Home' }, { text: '#Home #alpha' }
]).map((t) => [t.tag, t.count]), [['Home', 4], ['alpha', 1], ['work', 1]]);

console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);

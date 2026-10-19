// Unit checks for js/search.js. Run: node tests/search-unit.js
'use strict';
require('../js/search.js');
const S = globalThis.DaybookSearch;

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
}
const marked = (text, ranges) => ranges.map((r) => text.slice(r[0], r[1]));

check('fold ignores case and accents', S.fold('Café CRÈME naïve') === 'cafe creme naive', S.fold('Café CRÈME naïve'));
check('fold treats curly quotes as straight', S.fold('don’t “x”') === 'don\'t "x"', S.fold('don’t “x”'));
check('terms split on spaces, dedupe, drop words inside longer ones', JSON.stringify(S.terms('  plum Plumber  tap TAP ')) === '["plumber","tap"]', S.terms('  plum Plumber  tap TAP '));
check('empty query has no terms', S.terms('   ').length === 0);
const samples = ['Plain ascii text', 'Café “quoted” don’t', 'Café decomposed', '🎉 Zoë ΟΔΟΣ ΣΟΦΙΑ', 'İstanbul straße ÅNGSTRÖM', ''];
const agree = samples.filter((t) => S.fold(t) !== S.foldWithMap(t).text);
check('quick fold and highlight fold always agree', agree.length === 0, agree.map((t) => [S.fold(t), S.foldWithMap(t).text]));

const idx = S.buildIndex([
  { id: 'a', day: '2026-10-18', createdAt: 2, text: 'Coffee at the Café with Sam' },
  { id: 'b', day: '2026-10-18', createdAt: 1, text: 'Call the plumber about the kitchen tap' },
  { id: 'c', day: '2026-10-20', createdAt: 5, text: 'Kitchen tap fixed!' },
  { id: 'd', day: '2025-10-20', createdAt: 9, text: 'A photo caption: sunset over the bay' },
  { id: 'e', day: '2026-10-19', createdAt: 3, text: '' }
]);
const r1 = S.run(idx, 'cafe');
check('accent-insensitive match', r1.notes.map((n) => n.id).join() === 'a', r1.notes.map((n) => n.id));
const r2 = S.run(idx, 'tap kitchen');
check('every word must match, any order; newest day first', r2.notes.map((n) => n.id).join() === 'c,b', r2.notes.map((n) => n.id));
const r3 = S.run(idx, 'kitchen zebra');
check('a word that matches nothing gives no results', r3.notes.length === 0);
const order = S.run(idx, 'the').notes.map((n) => n.id).join();
check('results ordered newest day first, then time within the day', order === 'b,a,d', order);
check('empty notes never match', !S.run(idx, 'a').notes.some((n) => n.id === 'e'));
const groups = S.groupByDay(S.run(idx, 'the').notes);
check('grouped by day', groups.length === 2 && groups[0].day === '2026-10-18' && groups[0].notes.length === 2, groups.map((g) => g.day));

const t = 'Café and CAFE and cafés';
check('highlights every match, keeping the original spelling', JSON.stringify(marked(t, S.highlightRanges(t, S.terms('cafe')))) === '["Café","CAFE","café"]', marked(t, S.highlightRanges(t, S.terms('cafe'))));
const decomposed = 'Café time';
check('highlight covers combining accents', JSON.stringify(marked(decomposed, S.highlightRanges(decomposed, ['cafe']))) === '["Café"]', marked(decomposed, S.highlightRanges(decomposed, ['cafe'])));
const emoji = '🎉 Party at Zoë’s 🎂 place';
check('highlights stay aligned after emoji', JSON.stringify(marked(emoji, S.highlightRanges(emoji, S.terms("zoe's place")))) === '["Zoë’s","place"]', marked(emoji, S.highlightRanges(emoji, S.terms("zoe's place"))));
const overlap = 'banana';
check('overlapping matches merge into one mark', JSON.stringify(S.highlightRanges(overlap, ['ana', 'nan'])) === '[[1,6]]', S.highlightRanges(overlap, ['ana', 'nan']));

const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. The quick brown fox jumps over the lazy dog.';
const sn = S.snippet(long, ['fox']);
check('long note trimmed to start near the first match', sn.cutStart && sn.text.length < long.length && sn.text.includes('fox') && /^\S/.test(sn.text), sn.text);
check('snippet starts at a word boundary', long.includes(' ' + sn.text), sn.text.slice(0, 20));
check('snippet ranges point at the match', marked(sn.text, sn.ranges).join() === 'fox', marked(sn.text, sn.ranges));
const short = S.snippet('Short fox note', ['fox']);
check('short notes shown whole', !short.cutStart && short.text === 'Short fox note' && marked(short.text, short.ranges).join() === 'fox');

const big = [];
for (let i = 0; i < 20000; i++) big.push({ id: 'n' + i, day: '2026-01-01', createdAt: i, text: 'Note number ' + i + ' about groceries, the garden and a café visit' });
const t0 = Date.now();
const bigIdx = S.buildIndex(big);
const t1 = Date.now();
const found = S.run(bigIdx, 'garden cafe 1999');
const t2 = Date.now();
check('20,000 notes: index ' + (t1 - t0) + ' ms, search ' + (t2 - t1) + ' ms', found.notes.length === 12 && t2 - t1 < 300, found.notes.length);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} search checks passed`);
process.exit(failed ? 1 : 0);

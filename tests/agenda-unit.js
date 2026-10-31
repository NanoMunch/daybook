// Unit checks for js/agenda.js. Run: node tests/agenda-unit.js
'use strict';
require('../js/collections.js');
require('../js/agenda.js');
const A = globalThis.DaybookAgenda;

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
}

// Notes are read from the day they belong to. 2026-10-28 is a Wednesday.
const ANCHOR = '2026-10-28';
function note(text, opts) {
  opts = opts || {};
  return {
    id: opts.id || 'n1',
    day: opts.day || ANCHOR,
    // Written at 9am on its own day unless said otherwise.
    createdAt: opts.createdAt || new Date(2026, 9, 28, 9, 0).getTime(),
    text: text
  };
}
function got(text, opts) {
  return A.itemsOf(note(text, opts)).map((i) => i.date + (i.time ? ' ' + i.time : ''));
}
function expect(text, want, opts) {
  const g = got(text, opts);
  check(JSON.stringify(text) + ' -> ' + JSON.stringify(want), JSON.stringify(g) === JSON.stringify(want), g);
}

check('weekdayOf: 2026-10-28 is a Wednesday', A.weekdayOf('2026-10-28') === 2);
check('addDays crosses daylight saving (Melbourne, 4 Oct 2026)', A.addDays('2026-10-03', 1) === '2026-10-04');

// Relative words
expect('Call the bank tomorrow', ['2026-10-29']);
expect('Gym today 6pm', ['2026-10-28 18:00']);
expect('Party the day after tomorrow', ['2026-10-30']);
expect('Renew rego in 3 days', ['2026-10-31']);
expect('Check back in two weeks', ['2026-11-11']);
expect('Pay rent in a fortnight', ['2026-11-11']);
expect('Clean gutters this weekend', ['2026-10-31']);
expect('Tomorrow arvo footy', ['2026-10-29']);

// Weekdays
expect('Dentist Friday 3pm', ['2026-10-30 15:00']);
expect('Dentist Wednesday', ['2026-10-28']);
expect('Lunch with Sam next Tuesday at 12:30pm', ['2026-11-03 12:30']);
expect('Book club next Friday', ['2026-11-06']);
expect('On Mon, call Jo', ['2026-11-02']);
expect('Sat 10am farmers market', ['2026-10-31 10:00']);
expect('We sat down for ages', []);
expect('Last Friday was great', []);
expect('Bins go out every Monday', []);
expect('I love Mondays', []);

// Written dates
expect('Mum’s birthday 12 Dec', ['2026-12-12']);
expect('Flights Nov 3rd, back 17 November', ['2026-11-03', '2026-11-17']);
expect('Concert 5th of March 2027 7:30pm', ['2027-03-05 19:30']);
expect('Tue 10 Nov dinner 7pm', ['2026-11-10 19:00']);
expect('Passport expires 2027-02-14', ['2027-02-14']);
expect('Due 12/11', ['2026-11-12']);
expect('12/11 school concert', ['2026-11-12']);
expect('Invoice dated 3/1/27', ['2027-01-03']);
expect('Add 1/2 cup sugar', []);
expect('Moved to 3/45 Lygon Street, Carlton', []);
expect('Hot cross buns from 1 Jan', ['2027-01-01']);
expect('Remember 25 Oct was fun', ['2026-10-25']);
expect('Rent due on the 1st', ['2026-11-01']);
expect('The 3rd time this week', []);
expect('Version 1.2.3 out', []);
expect('Price $12.30 at Coles', []);

// Times
expect('Haircut 4:45 pm', ['2026-10-28 16:45']);
expect('Call at 2:30', ['2026-10-28 14:30']);
expect('Standup 09:15', ['2026-10-28 09:15']);
expect('Meet at noon', ['2026-10-28 12:00']);
expect('Woke up at 7am', [], { createdAt: new Date(2026, 9, 28, 9, 0).getTime() });
expect('Phone 0412 345 678', []);

// Lines, to-dos and leftovers
expect('Dinner at Sam’s Friday\n7pm', ['2026-10-30 19:00']);
expect('[x] Pay water bill Friday\n[ ] Book vet Monday', ['2026-11-02']);
const vet = A.itemsOf(note('[ ] Book vet Monday'))[0];
check('to-do line is marked as a to-do', vet && vet.todo === true && vet.text === '☐ Book vet Monday', vet);
const bare = A.itemsOf(note('Trivia night at the Royal\nThursday 8pm'))[0];
check('a line that is only a date borrows the first line', bare && bare.text === 'Trivia night at the Royal' && bare.time === '20:00', bare);
const marked = A.itemsOf(note('Dentist Friday 3pm'))[0];
check('marks point at the date and time words', marked && marked.marks.map((r) => marked.text.slice(r[0], r[1])).join('|') === 'Friday|3pm', marked);

// A note on a future page with only a time is a plan for that day.
expect('Pick up keys 9am', ['2026-11-05 09:00'], { day: '2026-11-05' });

// build() sorts by date, then time, all-day first.
const all = A.build([
  note('Haircut Friday 2pm', { id: 'a' }),
  note('Friday: bins', { id: 'b' }),
  note('Thursday 9am call', { id: 'c' })
]);
check('build sorts soonest first, all-day before times',
  all.map((i) => i.noteId).join('') === 'cba', all.map((i) => i.noteId + ' ' + i.date + ' ' + i.time));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} agenda checks passed`);
process.exit(passed === results.length ? 0 : 1);

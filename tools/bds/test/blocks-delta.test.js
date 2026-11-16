'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const samples = require('../samples');
const delta = require('../blocks-delta');

const OURS = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'packages', 'bedrock-data', 'canonical_block_states.nbt'));

// Invented blocks, in the compound shape leveldb.nbt yields. fixture:frame gains a state,
// fixture:gone is dropped and fixture:fresh is new, so the other three keep their sets.
const state = (name, states = {}, version = 1) => [['name', 8, name], ['states', 10, Object.entries(states).map(([k, v]) => (typeof v === 'boolean' ? [k, 1, Number(v)] : typeof v === 'number' ? [k, 3, v] : [k, 8, v]))], ['version', 3, version]];
const OLD = [
	state('fixture:air'), state('fixture:lamp', { lit: false }), state('fixture:lamp', { lit: true }),
	state('fixture:frame', { stability: 0 }), state('fixture:frame', { stability: 1 }), state('fixture:gone'), state('fixture:stone'),
];
const NEW = [
	state('fixture:air', {}, 2), state('fixture:lamp', { lit: false }, 2), state('fixture:lamp', { lit: true }, 2),
	...[0, 1].flatMap((s) => [false, true].map((check) => state('fixture:frame', { stability: s, check }, 2))),
	state('fixture:fresh', {}, 2), state('fixture:stone', {}, 2),
];
// BDS kept every new state when placed except the lit lamp, at its index in NEW.
const SENT = NEW.map((c, id) => [c, id]).filter(([, id]) => id !== 2);
const run = (over = {}) => delta.build({ base: OLD, oldPalette: [...OLD].reverse(), newPalette: [...NEW].reverse(), sent: SENT, ...over });
const failed = (r) => Object.entries(r.report.items).filter(([, x]) => x.length).map(([k]) => k);

test('our file reads as samples.js reads it, and writes back byte for byte', () => {
	const ours = delta.decode(OURS);
	assert.deepEqual(ours.map(delta.key), samples.readStateList(OURS).map(samples.stateKey));
	assert.ok(delta.encode(ours).equals(OURS));
	assert.throws(() => delta.decode(OURS.subarray(0, 30)), /truncated/);
	assert.throws(() => delta.encode([ours[0], null]), /ID 1 names no state/);
});

test('kept states sit at their sent IDs, the rest fill the gaps in our order, with the new version', () => {
	const r = run();
	assert.deepEqual(r.report.items, { a: [], b: [], c: [], d: [], f: [] });
	assert.equal(r.report.match, true);
	assert.deepEqual(r.states.map(delta.key), NEW.map(delta.key));
	assert.ok(delta.encode(r.states).equals(delta.encode(NEW)));
	assert.deepEqual([r.report.states, r.report.kept, r.report.inherited], [9, 8, 1]);
	assert.deepEqual(r.report.blocks['fixture:lamp'], { inherited: [{ state: 'fixture:lamp[lit=b:1]', id: 2 }], added: [], removed: [] });
	assert.deepEqual(r.report.blocks['fixture:frame'].added.map((s) => s.id), [3, 4, 5, 6]);
	assert.deepEqual(r.report.blocks['fixture:frame'].removed, [{ state: 'fixture:frame[stability=i:0]', our_id: 3 }, { state: 'fixture:frame[stability=i:1]', our_id: 4 }]);
	assert.deepEqual(r.report.blocks['fixture:gone'], { inherited: [], added: [], removed: [{ state: 'fixture:gone[]', our_id: 5 }] });
	assert.deepEqual(r.report.blocks['fixture:fresh'].added, [{ state: 'fixture:fresh[]', id: 7 }]);
	assert.deepEqual(Object.keys(r.report.blocks), ['fixture:frame', 'fixture:fresh', 'fixture:gone', 'fixture:lamp']);
	const text = delta.render(r.report);
	assert.match(text, /^9 IDs: 8 at the ID BDS sent, 1 in our order$/m);
	assert.match(text, /^ {4}inherited fixture:lamp\[lit=b:1\] at 2$/m);
	assert.match(text, /^ {4}removed fixture:gone\[\], ours 5$/m);
	assert.match(text, /\nMATCH$/);
});

test('each acceptance item fails on its own and names its states', () => {
	const without = (name) => SENT.filter(([c]) => delta.key(c) !== name);
	const cases = [
		[{ sent: without('fixture:frame[check=b:1,stability=i:1]') }, ['a', 'd', 'f'], /fixture:frame\[check=b:1,stability=i:1\] was not sent, and its block changed/],
		[{ sent: [...SENT, [OLD[5], 9]] }, ['b'], /fixture:gone\[\] was sent as 9 and is not in the new palette/],
		[{ sent: [...SENT, [NEW[2], 1]] }, ['b', 'd'], /fixture:lamp\[lit=b:1\] was sent as 1, which fixture:lamp\[lit=b:0\] holds/],
		[{ sent: [...SENT, [NEW[1], 4]] }, ['b', 'd'], /fixture:lamp\[lit=b:0\] was sent as 1 and as 4/],
		[{ sent: SENT.map(([c, id]) => [c, id === 8 ? 10 : id]) }, ['c'], /^8 names no state$/],
		[{ sent: SENT.map(([c, id]) => [c, id < 2 ? 1 - id : id]) }, ['d'], /fixture:lamp\[lit=b:0\] was sent as 0, where our order does not put it/],
		[{ base: OLD.filter((_, i) => i !== 2) }, ['d'], /fixture:lamp\[lit=b:1\] is inherited at 2, but it is not in our file/],
		[{ sent: without('fixture:fresh[]') }, ['a', 'd', 'f'], /fixture:fresh\[\] was added and has no sent ID/],
	];
	for (const [over, items, line] of cases) {
		const r = run(over);
		assert.deepEqual(failed(r), items, `${line}`);
		assert.equal(r.report.match, false);
		const text = delta.render(r.report);
		assert.match(text, /\nMISMATCH$/);
		assert.ok(text.split('\n').some((l) => line.test(l.trim())), `${line} in\n${text}`);
	}
	assert.match(delta.render(run({ sent: SENT.map(([c, id]) => [c, id === 8 ? 10 : id]) }).report), /^c: MISMATCH \(2\)\n {2}8 names no state\n {2}9 names no state$/m);
});

test('a state the tool cannot key, or a palette at two versions of one state, is refused', () => {
	assert.throws(() => run({ newPalette: [...NEW, state('fixture:air', {}, 3)] }), /holds fixture:air\[\] at two versions/);
	assert.throws(() => run({ newPalette: [...NEW, [['name', 8, 'fixture:odd'], ['states', 10, [['f', 5, 0.5]]], ['version', 3, 1]]] }), /fixture:odd state f has tag type 5/);
	assert.throws(() => run({ newPalette: [[['name', 8, 'fixture:air'], ['version', 3, 1]]] }), /a state has no states/);
});

// The shape of item e, on our own file standing in for both palettes: every state but a few
// sent at its own ID gives the file back entry for entry. Two kept states sent at each
// other's IDs is a change of Mojang's order rule, which d and the control both name.
test('the control shape: our file through build() comes back entry for entry, and a swap is named', () => {
	const ours = delta.decode(OURS);
	const sent = ours.map((c, id) => [c, id]).filter(([, id]) => id % 7 !== 3);
	const same = delta.build({ base: ours, oldPalette: ours, newPalette: [...ours].reverse(), sent });
	assert.equal(same.report.match, true);
	assert.deepEqual(delta.control(same.states, ours), []);
	const swapped = sent.map(([c, id]) => [c, id === 10 ? 11 : id === 11 ? 10 : id]);
	const r = delta.build({ base: ours, oldPalette: ours, newPalette: ours, sent: swapped });
	assert.deepEqual(failed(r), ['d']);
	assert.equal(r.report.items.d.length, 2);
	assert.deepEqual(delta.control(r.states, ours).map((l) => l.split(':')[0]), ['10', '11']);
	assert.match(delta.control(ours.slice(0, 2), ours.slice(0, 1))[0], /^1: got .* v\d+, ours none$/);
});

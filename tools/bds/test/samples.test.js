'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const samples = require('../samples');

// Invented blocks and items in the layout of metadata/vanilladata_modules, so nothing of
// Mojang's is committed. Each property type appears once.
const BLOCKS = {
	block_properties: [
		{ name: 'lit', type: 'bool', values: [{ value: false }, { value: true }] },
		{ name: 'power', type: 'int', values: [{ value: 0 }, { value: -1 }, { value: 2 }] },
		{ name: 'fixture:facing', type: 'string', values: [{ value: 'up' }, { value: 'down' }] },
	],
	data_items: [
		{ name: 'fixture:lamp', properties: [{ name: 'lit' }, { name: 'fixture:facing' }], raw_id: 1 },
		{ name: 'fixture:wire', properties: [{ name: 'power' }], raw_id: 2 },
		{ name: 'fixture:slab', properties: [], raw_id: 3 },
	],
};
const ITEMS = { data_items: [{ name: 'fixture:lamp', raw_id: 10 }, { name: 'fixture:dust', raw_id: -11 }] };
const REQUIRED = { 'fixture:lamp': { runtime_id: 10 }, 'fixture:dust': { runtime_id: -11 } };

const uvar = (n) => {
	const out = [];
	do {
		out.push((n % 128) | (n >= 128 ? 0x80 : 0));
		n = Math.floor(n / 128);
	} while (n);
	return Buffer.from(out);
};
const str = (s) => Buffer.concat([uvar(Buffer.byteLength(s)), Buffer.from(s)]);
const tag = (t, k, payload) => Buffer.concat([Buffer.from([t]), str(k), payload]);
const value = ([k, t, v]) => (t === 'b' ? tag(1, k, Buffer.from([v & 0xff])) : t === 'i' ? tag(3, k, uvar(v < 0 ? -2 * v - 1 : 2 * v)) : tag(8, k, str(v)));
const nbt = (states, extra = Buffer.alloc(0)) => Buffer.concat(states.map((s) => Buffer.concat([
	Buffer.from([10]), str(''), tag(8, 'name', str(s.name)), tag(10, 'states', Buffer.concat([...s.states.map(value), Buffer.from([0])])), extra, Buffer.from([0]),
])));

function tree({ blocks = BLOCKS, items = ITEMS, states = samples.deriveStates(BLOCKS), extra, required = REQUIRED } = {}) {
	const dir = fx.tempDir('bds-samples');
	fx.writeTree(dir, {
		[`samples/${samples.MODULES}/mojang-blocks.json`]: blocks,
		[`samples/${samples.MODULES}/mojang-items.json`]: items,
		'data/canonical_block_states.nbt': nbt(states, extra),
		'data/required_item_list.json': required,
		'data/protocol_info.json': { version: { major: 1, minor: 2, patch: 3, revision: 4, protocol_version: 99 } },
	});
	return { samples: path.join(dir, 'samples'), data: path.join(dir, 'data') };
}

test('arguments default to v1.26.60.5 and our bedrock-data, and bad ones are refused', () => {
	const a = samples.parseArgs([]);
	assert.equal(a.tag, 'v1.26.60.5');
	assert.equal(path.basename(a.data_dir), 'bedrock-data');
	assert.deepEqual(samples.parseArgs(['--tag', 'v1.26.70.23-preview', '--samples-dir', 's', '--json']).samples_dir, 's');
	assert.throws(() => samples.parseArgs(['--tag', 'main']), /not a bedrock-samples/);
	assert.throws(() => samples.parseArgs(['--data-dir']), /needs a value/);
	assert.throws(() => samples.parseArgs(['--verbose']), /unknown argument/);
});

test('FNV-1 64 gives the published test vectors', () => {
	assert.equal(samples.fnv1(''), 0xcbf29ce484222325n);
	assert.equal(samples.fnv1('a'), 0xaf63bd4c8601b7ben);
});

test('states are every combination of a block\'s values, first property fastest, blocks in hash order', () => {
	const states = samples.deriveStates(BLOCKS);
	const names = [...new Set(states.map((s) => s.name))];
	assert.deepEqual(names, [...names].sort((a, b) => (samples.fnv1(a) < samples.fnv1(b) ? -1 : 1)));
	assert.deepEqual(states.filter((s) => s.name === 'fixture:lamp').map(samples.stateKey), [
		'fixture:lamp[fixture:facing=s:"up",lit=b:0]',
		'fixture:lamp[fixture:facing=s:"down",lit=b:0]',
		'fixture:lamp[fixture:facing=s:"up",lit=b:1]',
		'fixture:lamp[fixture:facing=s:"down",lit=b:1]',
	]);
	assert.equal(states.length, 4 + 3 + 1);
	assert.throws(() => samples.deriveStates({ ...BLOCKS, data_items: [{ name: 'fixture:x', properties: [{ name: 'gone' }] }] }), /unknown property gone/);
	assert.throws(() => samples.deriveStates({ data_items: [] }), /no block_properties/);
});

test('the NBT reader round-trips states and refuses what is not a state list', () => {
	const states = samples.deriveStates(BLOCKS);
	assert.deepEqual(samples.readStateList(nbt(states)).map(samples.stateKey), states.map(samples.stateKey));
	assert.deepEqual(samples.readStateList(nbt(states.slice(0, 1), tag(3, 'version', uvar(4)))).map((s) => s.fields), [['version']]);
	assert.throws(() => samples.readStateList(nbt(states).subarray(0, 20)), /truncated/);
	assert.throws(() => samples.readStateList(Buffer.from([8, 0, 0])), /not a compound/);
	const holding = (t, payload) => Buffer.concat([Buffer.from([10]), str(''), tag(8, 'name', str('fixture:x')), tag(10, 'states', Buffer.concat([tag(t, 'v', payload), Buffer.from([0])])), Buffer.from([0])]);
	assert.throws(() => samples.readStateList(holding(5, Buffer.alloc(4))), /tag type 5 .* is not a block state value/);
	assert.throws(() => samples.readStateList(holding(10, Buffer.from([0]))), /fixture:x state v has tag type 10/);
});

test('samples that reproduce bedrock-data exactly are a MATCH', () => {
	const t = tree();
	const lines = [];
	assert.equal(samples.main(['--samples-dir', t.samples, '--data-dir', t.data], (s) => lines.push(s)), 0);
	const out = lines.join('\n').split('\n');
	assert.equal(out[0], 'bedrock-samples v1.26.60.5 against packages/bedrock-data 1.2.3.4 (protocol 99)');
	assert.equal(out[out.length - 1], 'MATCH');
});

test('every mutation of bedrock-data is a MISMATCH that names the difference', () => {
	const states = samples.deriveStates(BLOCKS);
	const wire = states.filter((s) => s.name === 'fixture:wire');
	const swapped = states.map((s) => (s === wire[0] ? wire[1] : s === wire[1] ? wire[0] : s));
	const cases = [
		[{ required: { ...REQUIRED, 'fixture:lamp': { runtime_id: 12 } } }, (r) => assert.deepEqual(r.items.id_differs, ['fixture:lamp: samples 10, ours 12'])],
		[{ required: { ...REQUIRED, 'fixture:extra': { runtime_id: 13 } } }, (r) => assert.deepEqual(r.items.only_ours_other, ['fixture:extra'])],
		[{ required: { 'fixture:lamp': { runtime_id: 10 } } }, (r) => assert.deepEqual(r.items.only_samples, ['fixture:dust'])],
		[{ required: { ...REQUIRED, 'fixture:dust': { runtime_id: -11, version: 2 } } }, (r) => assert.deepEqual(r.items.fields_not_in_samples, ['version'])],
		[{ states: states.filter((s) => samples.stateKey(s) !== 'fixture:wire[power=i:2]') }, (r) => assert.deepEqual([r.blocks.values_differ, r.blocks.states_only_samples], [['fixture:wire power: samples only [i:2], ours only []'], ['fixture:wire[power=i:2]']])],
		[{ states: [...states, { name: 'fixture:extra', states: [] }] }, (r) => assert.deepEqual(r.blocks.names_only_ours, ['fixture:extra'])],
		[{ states: swapped }, (r) => assert.deepEqual(r.blocks.state_order_differs, ['fixture:wire'])],
		[{ states: [...states].reverse() }, (r) => assert.match(r.blocks.block_order_differs[0], /^from shared block 0: /)],
		[{ states: [...states, states[0]] }, (r) => assert.deepEqual(r.blocks.state_order_differs, [states[0].name])],
		[{ extra: tag(3, 'version', uvar(8)) }, (r) => assert.deepEqual(r.blocks.fields_not_in_samples, ['version'])],
	];
	for (const [mutation, check] of cases) {
		const t = tree(mutation);
		const r = samples.compare(t.samples, t.data);
		assert.equal(r.match, false, JSON.stringify(mutation));
		check(r);
		const lines = [];
		assert.equal(samples.main(['--samples-dir', t.samples, '--data-dir', t.data], (s) => lines.push(s)), 1);
		assert.match(lines.join('\n'), /\nMISMATCH$/);
	}
});

test('a tag is cloned sparse into the cache, reused once complete, and a failed clone leaves nothing', (t) => {
	const cache = fx.tempDir('bds-samples-cache');
	t.after(() => { delete process.env.PMMP_UPDATER_CACHE; });
	process.env.PMMP_UPDATER_CACHE = cache;
	const calls = [];
	const run = (args) => {
		calls.push(args);
		if (args[0] === 'clone') fs.mkdirSync(args[args.length - 1], { recursive: true });
	};
	const dir = samples.checkout('v1.26.60.5', run);
	assert.equal(dir, path.join(cache, 'bedrock-samples', 'v1.26.60.5'));
	assert.deepEqual(calls[0].slice(0, 8), ['clone', '-q', '--depth', '1', '--branch', 'v1.26.60.5', '--filter=blob:none', '--sparse']);
	assert.deepEqual(calls[1].slice(2), ['sparse-checkout', 'set', samples.MODULES]);
	assert.equal(samples.checkout('v1.26.60.5', () => assert.fail('cached tag cloned again')), dir);
	assert.throws(() => samples.checkout('v1.26.70.23-preview', (args) => { run(args); throw new Error('network down'); }), /network down/);
	assert.deepEqual(fs.readdirSync(path.join(cache, 'bedrock-samples')), ['v1.26.60.5']);
	assert.throws(() => samples.checkout('../v1.26.60.5', run), /not a bedrock-samples/);
});

test('live: bedrock-samples v1.26.60.5 derives 1466 blocks in 24058 states and 1627 items', { skip: !process.env.RIFTAL_LIVE }, () => {
	const dir = samples.checkout('v1.26.60.5');
	const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, samples.MODULES, f), 'utf8'));
	const states = samples.deriveStates(read('mojang-blocks.json'));
	assert.equal(new Set(states.map((s) => s.name)).size, 1466);
	assert.equal(states.length, 24058);
	assert.equal(read('mojang-items.json').data_items.length, 1627);
});

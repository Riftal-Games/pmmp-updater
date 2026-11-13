'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const fx = require('../../test-support/fixtures');
const dec = require('../decode');

// Invented blocks and items, so nothing of Mojang's is committed. State 0 is the ID an item
// with no block sends too, so no item names it; the lamp's states are out of name order.
const STATES = [{ name: 'fixture:slab', states: [] }, ...[0, 1].map((v) => ({ name: 'fixture:lamp', states: [['lit', 'b', v], ['facing', 's', 'up']] }))];
const str = (s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
const tag = (t, k, payload) => Buffer.concat([Buffer.from([t]), str(k), payload]);
const value = ([k, t, v]) => (t === 's' ? tag(8, k, str(v)) : tag(1, k, Buffer.from([v])));
const nbt = (states) => Buffer.concat(states.map((s) => Buffer.concat([Buffer.from([10, 0]), tag(8, 'name', str(s.name)), tag(10, 'states', Buffer.concat([...s.states.map(value), Buffer.from([0])])), Buffer.from([0])])));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const stack = (name, block, extra = {}) => ({ name, meta: 0, count: 1, block, nbt: null, can_place_on: [], can_destroy: [], ...extra });
const LIT = dec.leStates(STATES[2].states).toString('base64');
const NBT = Buffer.from([10, 0, 0, 3, 1, 0, ...Buffer.from('x'), 1, 0, 0, 0, 0]).toString('base64');
// Items with no block, so meta stands, and one carrying every extra field the generator keeps.
const extras = () => [stack('fixture:dye', 0, { meta: 3 }), stack('fixture:dye', 0, { meta: 32767 }), stack('fixture:pick', 0, { nbt: NBT, can_place_on: ['fixture:slab'], can_destroy: ['fixture:lamp'] })];
const OURS_EXTRAS = [{ name: 'fixture:dye', meta: 3 }, 'fixture:dye', { name: 'fixture:pick', nbt: NBT, can_place_on: ['fixture:slab'], can_destroy: ['fixture:lamp'] }];
const LAMP0 = dec.leStates(STATES[1].states).toString('base64');
const ing = (id, meta, count = 1) => ({ id, meta, count });
const tagIn = () => ({ tag: 'fixture:tag', count: 1 });
// The generator's files for dump()'s recipes, written by hand: keys sorted, entries in its order.
const RECIPES = {
	'recipes/shaped_crafting.json': [
		{ block: 'fixture_table', input: { A: { block_states: LIT, name: 'fixture:lamp' }, B: { meta: 32767, name: 'fixture:dust' } }, output: [{ block_states: LAMP0, name: 'fixture:lamp' }], priority: 2, shape: ['A ', 'AB'], unlockingIngredients: [{ meta: 32767, name: 'fixture:dust' }] },
		{ block: 'fixture_table', input: { A: { tag: 'fixture:tag' } }, output: ['fixture:dust'], priority: 0, shape: ['A'] },
	],
	'recipes/shapeless_crafting.json': [{ block: 'fixture_table', input: [{ meta: 3, name: 'fixture:dust' }, { molang_expression: 'q.x', molang_version: 9 }], output: [{ count: 2, name: 'fixture:dust' }], priority: 1 }],
	'recipes/special_hardcoded.json': ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
	'recipes/smithing.json': [{ addition: { tag: 'fixture:tag' }, block: 'fixture_smithy', input: { name: 'fixture:slab' }, output: { block_states: LIT, name: 'fixture:lamp' }, template: { meta: 32767, name: 'fixture:dust' } }],
	'recipes/potion_type.json': [{ ingredient: { name: 'fixture:dye' }, input: { meta: 5, name: 'fixture:dust' }, output: { meta: 6, name: 'fixture:dust' } }],
	'recipes/potion_container_change.json': [{ ingredient: { name: 'fixture:dye' }, input_item_name: 'fixture:dust', output_item_name: 'fixture:dye' }],
	'recipes/shaped_chemistry.json': [{ block: 'fixture_lab', input: { A: { meta: 3, name: 'fixture:dye' } }, output: [{ meta: 4, name: 'fixture:dye' }], priority: 0, shape: ['A'] }],
	'recipes/shapeless_chemistry.json': [{ block: 'fixture_lab', input: [{ meta: 4, name: 'fixture:dye' }], output: ['fixture:dust'], priority: 0 }],
	'recipes/shapeless_shulker_box.json': [{ block: 'fixture_table', input: [{ name: 'fixture:slab' }, { tag: 'fixture:tag' }], output: ['fixture:pick'], priority: 3 }],
	'recipes/smithing_trim.json': [{ addition: { meta: 3, name: 'fixture:dye' }, block: 'fixture_smithy', input: { name: 'fixture:pick' }, template: { meta: 32767, name: 'fixture:dust' } }],
};
const BIOMES = { 'fixture:plains': { id: 1, rain: true, tags: ['warm'] } };
const SHAPES = { nameMap: { 'fixture:box': 1 }, shapes: [{ cells: { storage: [1], xSize: 1, ySize: 1, zSize: 1 }, x: [0, 1], y: [0, 1], z: [0, 1] }] };

const data = () => fx.writeTree(fx.tempDir('bds-decode'), {
	'canonical_block_states.nbt': nbt(STATES),
	'protocol_info.json': { version: { major: 1, minor: 2, patch: 3, revision: 4, protocol_version: 99 } },
	'required_item_list.json': { 'fixture:lamp': { runtime_id: -1, component_based: false, version: 2 }, 'fixture:dust': { runtime_id: 5, component_based: true, version: 1, component_nbt: 'AAA=' } },
	'creative/construction.json': [{ group_icon: null, group_name: 'g', items: [{ name: 'fixture:lamp', block_states: LIT }, 'fixture:dust', { name: 'fixture:dust', count: 2 }] }],
	'creative/nature.json': [], 'creative/equipment.json': [], 'creative/items.json': [{ group_icon: 'fixture:dye', group_name: 'h', items: OURS_EXTRAS }],
	'data_driven_blocks.nbt': 'a', 'entity_identifiers.nbt': 'b', 'jigsaw_structures_data.nbt': 'c', 'biome_definitions.json': BIOMES, 'voxel_shapes.json': SHAPES,
	'block_state_meta_map.json': [0, 0, 1], 'block_id_to_item_id_map.json': { 'fixture:lamp': 'fixture:lamp', 'fixture:slab': 'fixture:slab' }, ...RECIPES,
});

// A dump as decode.php prints one, from a server sending hashed or sequential block IDs.
function dump(hashes = true) {
	const id = (i) => (hashes ? dec.blockHash(STATES[i]) : i);
	return {
		protocol: 99, version: '1.2.3', records: 8, unknown: [], start_game: { hashes, experiments: [], education: false, data_driven_blocks: sha('a') },
		items: [{ name: 'fixture:lamp', runtime_id: -1, component_based: false, version: 2, component_nbt: null }, { name: 'fixture:dust', runtime_id: 5, component_based: true, version: 1, component_nbt: 'AAA=' }],
		creative: { groups: [{ category: 1, name: 'g', icon: null }, { category: 4, name: 'h', icon: extras()[1] }], items: [...[stack('fixture:lamp', id(2)), stack('fixture:dust', 0), stack('fixture:dust', 0, { count: 2 })].map((item) => ({ group: 0, item })), ...extras().map((item) => ({ group: 1, item }))] },
		crafting: {
			shaped_crafting: [
				{ input: [[tagIn()]], output: [stack('fixture:dust', 0)], block: 'fixture_table', priority: 0, symmetric: true, unlocking: null },
				{ input: [[ing('fixture:lamp', 1), null], [ing('fixture:lamp', 1), ing('fixture:dust', 32767)]], output: [stack('fixture:lamp', id(1))], block: 'fixture_table', priority: 2, symmetric: true, unlocking: [ing('fixture:dust', 32767)] },
			],
			shaped_chemistry: [{ input: [[ing('fixture:dye', 3)]], output: [stack('fixture:dye', 0, { meta: 4 })], block: 'fixture_lab', priority: 0, symmetric: true, unlocking: null }],
			shapeless_shulker_box: [{ input: [ing('fixture:slab', 0), tagIn()], output: [stack('fixture:pick', 0)], block: 'fixture_table', priority: 3, unlocking: [] }],
			shapeless_chemistry: [{ input: [ing('fixture:dye', 4)], output: [stack('fixture:dust', 0)], block: 'fixture_lab', priority: 0, unlocking: [] }],
			smithing_trim: [{ template: ing('fixture:dust', 32767), input: ing('fixture:pick', 0), addition: ing('fixture:dye', 3), block: 'fixture_smithy' }],
			shapeless_crafting: [{ input: [ing('fixture:dust:3', 3), { molang_expression: 'q.x', molang_version: 9, count: 1 }], output: [stack('fixture:dust', 0, { count: 2 })], block: 'fixture_table', priority: 1, unlocking: [] }],
			special_hardcoded: ['00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001'],
			smithing: [{ template: ing('fixture:dust', 32767), input: ing('fixture:slab', 4), addition: tagIn(), block: 'fixture_smithy', output: stack('fixture:lamp', id(2)) }],
			potion_type: [{ input: ing('fixture:dust', 5), ingredient: ing('fixture:dye', 0), output: stack('fixture:dust', 0, { meta: 6 }) }],
			potion_container_change: [{ input: 'fixture:dust', ingredient: ing('fixture:dye', 0), output: 'fixture:dye' }],
		},
		biomes: BIOMES, actors: sha('b'), jigsaw: sha('c'), voxel_shapes: { custom: 0, ...SHAPES },
	};
}

test('FNV-1a 32 gives its published vectors, and a block hash sorts the states by name and is signed', () => {
	assert.deepEqual(['', 'a', 'foobar'].map((s) => dec.fnv1a32(Buffer.from(s))), [0x811c9dc5, 0xe40c292c, 0xbf9cf968]);
	const s = (states) => dec.blockHash({ name: 'fixture:wire', states });
	assert.equal(s([['b', 'i', 1], ['a', 's', 'x']]), s([['a', 's', 'x'], ['b', 'i', 1]]));
	const le = Buffer.from([10, 0, 0, 8, 4, 0, ...Buffer.from('name'), 12, 0, ...Buffer.from('fixture:slab'), 10, 6, 0, ...Buffer.from('states'), 0, 0]);
	assert.ok(dec.fnv1a32(le) >= 2 ** 31 && dec.blockHash(STATES[0]) === (dec.fnv1a32(le) | 0) && dec.blockHash(STATES[0]) < 0);
});

test('block_states are the little-endian NBT of the states alone, in their order', () => {
	const got = dec.leStates([['lit', 'b', 1], ['power', 'i', -2], ['facing', 's', 'up']]);
	assert.deepEqual(got, Buffer.from([10, 0, 0, 1, 3, 0, ...Buffer.from('lit'), 1, 3, 5, 0, ...Buffer.from('power'), 0xfe, 0xff, 0xff, 0xff, 8, 6, 0, ...Buffer.from('facing'), 2, 0, ...Buffer.from('up'), 0]));
});

test('a capture equal to ours matches, hashed or sequential, and names how its block IDs became states', () => {
	for (const hashes of [true, false]) {
		const r = dec.compare(dump(hashes), data());
		assert.equal(r.match, true, JSON.stringify(r.rows.filter((x) => x.diffs.length)));
		assert.match(r.blocks.rule, hashes ? /^hashes, each matched with FNV-1a 32/ : /^sequential, each taken as an index/);
		assert.deepEqual(r.blocks.seen, { CreativeContentPacket: [null], CraftingDataPacket: [null, null] });
	}
	const lines = [];
	assert.equal(dec.main(['--dump', path.join(fx.writeTree(fx.tempDir('bds-decode'), { 'd.json': dump() }), 'd.json'), '--data-dir', data()], (s) => lines.push(s)), 0);
	assert.match(lines[0], /CreativeContentPacket: 1 IDs, 1 became states of the item's own block, 0 did not\n[\s\S]*MATCH creative\/construction\.json[\s\S]*\nMATCH recipes\/potion_container_change\.json \(CraftingDataPacket\)\n[\s\S]*\nMATCH recipes\/special_hardcoded\.json \(CraftingDataPacket\)\nMATCH$/);
});

test('an ID that names no state, or a state of another block, a changed value, an item field ours lacks, a missing packet or an unknown one is a MISMATCH', () => {
	for (const [mutate, file, want] of [
		[(d) => { d.creative.items[0].item.block = 12345; }, 'blocks', /^12345$/],
		[(d) => { d.crafting.shaped_crafting[1].output[0].name = 'fixture:slab'; }, 'blocks', /\(fixture:lamp for fixture:slab\)$/],
		[(d) => { d.creative.items[2].item.count = 3; }, 'creative/construction.json', /^\[0\]\.items\[2\]\.count: capture 3, ours 2$/],
		[(d) => { d.items[1].component_nbt = null; }, 'required_item_list.json', /component_nbt: capture absent, ours "AAA="$/],
		[(d) => { d.jigsaw = sha('d'); }, 'jigsaw_structures_data.nbt', /^sha256 capture /],
		[(d) => { delete d.biomes; }, 'biome_definitions.json', /^BiomeDefinitionListPacket is not in the capture$/],
		[(d) => { d.unknown = [999]; }, 'capture', /does not know: 999$/],
		[(d) => { delete d.crafting; }, 'block network IDs', /^CraftingDataPacket is not in the capture, so its block network IDs are not accounted for$/],
		[(d) => { d.creative.items[5].item.meta = 5; }, 'creative/items.json', /^\[0\]\.items\[2\]\.meta: capture 5, ours absent$/],
		[(d) => { d.creative.items[3].item.nbt = NBT; }, 'creative/items.json', /^\[0\]\.items\[0\]\.nbt: capture "CgAAAwEAeAEAAAAA", ours absent$/],
		[(d) => { d.creative.items[3].item.can_place_on = ['fixture:lamp']; }, 'creative/items.json', /^\[0\]\.items\[0\]\.can_place_on: capture \["fixture:lamp"\], ours absent$/],
		[(d) => { d.creative.items[3].item.can_destroy = ['fixture:slab']; }, 'creative/items.json', /^\[0\]\.items\[0\]\.can_destroy: capture \["fixture:slab"\], ours absent$/],
		[(d) => { d.crafting.shaped_crafting[1].priority = 5; }, 'recipes/shaped_crafting.json', /^\[0\]\.priority: capture 5, ours 2$/],
		[(d) => { d.crafting.shaped_crafting[1].unlocking = null; }, 'recipes/shaped_crafting.json', /^\[0\]\.unlockingIngredients: capture absent, ours \[/],
		[(d) => { d.crafting.shaped_crafting[0].symmetric = false; }, 'recipes/shaped_crafting_asymmetric.json', /^not in packages\/bedrock-data$/],
		[(d) => { d.crafting.shaped_crafting[1].input[0][1] = ing('fixture:dust', 32767); }, 'recipes/shaped_crafting.json', /^\[0\]\.shape\[0\]: capture "AB", ours "A "$/],
		[(d) => { d.crafting.shaped_crafting[1].input[1][0].meta = 0; }, 'recipes/shaped_crafting.json', /^\[0\]\.input\.B\.block_states: capture "/],
		[(d) => { d.crafting.shapeless_crafting[0].input[0].id = 'fixture:dust:4'; }, 'recipes/shapeless_crafting.json', /^\[0\]\.input\[0\]\.meta_suffix: capture "4", ours absent$/],
		[(d) => { d.crafting.smithing[0].addition.count = 2; }, 'recipes/smithing.json', /^\[0\]\.addition\.count: capture 2, ours absent$/],
		[(d) => { d.crafting.smithing[0].input.meta = 32767; }, 'recipes/smithing.json', /^\[0\]\.input\.meta: capture 32767, ours absent$/],
		[(d) => { d.crafting.potion_type[0].input.meta = 0; }, 'recipes/potion_type.json', /^\[0\]\.input\.meta: capture absent, ours 5$/],
		[(d) => { d.crafting.potion_container_change[0].output = null; }, 'recipes/potion_container_change.json', /^\[0\]\.output_item_name: capture null, ours "fixture:dye"$/],
		[(d) => { d.crafting.special_hardcoded.pop(); }, 'recipes/special_hardcoded.json', /^: length capture 1, ours 2$/],
		[(d) => { d.crafting.smithing = []; }, 'recipes/smithing.json', /^: length capture 0, ours 1$/],
		[(d) => { d.crafting.shaped_chemistry = []; }, 'recipes/shaped_chemistry.json', /^: length capture 0, ours 1$/],
		[(d) => { d.crafting.shaped_chemistry[0].unlocking = [tagIn()]; }, 'recipes/shaped_chemistry.json', /^\[0\]\.unlockingIngredients: capture \[\{"tag":"fixture:tag"\}\], ours absent$/],
		[(d) => { d.crafting.shaped_chemistry[0].symmetric = false; }, 'recipes/shaped_chemistry_asymmetric.json', /^not in packages\/bedrock-data$/],
		[(d) => { d.crafting.shapeless_chemistry = []; }, 'recipes/shapeless_chemistry.json', /^: length capture 0, ours 1$/],
		[(d) => { d.crafting.shapeless_chemistry[0].input[0].count = 2; }, 'recipes/shapeless_chemistry.json', /^\[0\]\.input\[0\]\.count: capture 2, ours absent$/],
		[(d) => { d.crafting.shapeless_shulker_box = []; }, 'recipes/shapeless_shulker_box.json', /^: length capture 0, ours 1$/],
		[(d) => { d.crafting.shapeless_shulker_box[0].unlocking = [tagIn()]; }, 'recipes/shapeless_shulker_box.json', /^\[0\]\.unlockingIngredients: capture \[\{"tag":"fixture:tag"\}\], ours absent$/],
		[(d) => { d.crafting.smithing_trim = []; }, 'recipes/smithing_trim.json', /^: length capture 0, ours 1$/],
		[(d) => { d.crafting.smithing_trim[0].addition.count = 2; }, 'recipes/smithing_trim.json', /^\[0\]\.addition\.count: capture 2, ours absent$/],
	]) {
		const d = dump();
		mutate(d);
		const r = dec.compare(d, data());
		const found = file === 'blocks' ? r.blocks.unresolved : r.rows.find((x) => x.file === file).diffs;
		assert.ok(!r.match && found.some((s) => want.test(s)), `${file}: ${found}`);
	}
});

test('an item takes the generator\'s form: meta 32767 is 0, and meta, nbt, can_place_on and can_destroy appear only when set', () => {
	assert.deepEqual(extras().map((s) => dec.itemJson(s, () => null)), OURS_EXTRAS);
});

test('a MISMATCH is what main prints and returns: the row, the absent packet, MISMATCH last and exit 1', () => {
	const d = dump();
	d.jigsaw = sha('d');
	delete d.crafting;
	const lines = [];
	assert.equal(dec.main(['--dump', path.join(fx.writeTree(fx.tempDir('bds-decode'), { 'd.json': d }), 'd.json'), '--data-dir', data()], (s) => lines.push(s)), 1);
	assert.match(lines[0], /\n {2}CraftingDataPacket: not in the capture\n[\s\S]*\nMISMATCH jigsaw_structures_data\.nbt \(JigsawStructureDataPacket\): 1 differences\n[\s\S]*\nMATCH voxel_shapes\.json \(VoxelShapesPacket\)\n[\s\S]*\nMISMATCH block network IDs \(CraftingDataPacket\): 1 differences\n[\s\S]*\nMISMATCH$/);
});

test('block ID 0 names state 0 only of the item\'s own block under sequential IDs, and with no StartGamePacket no ID becomes a state', () => {
	const seq = dec.resolver(false, STATES);
	assert.deepEqual([seq.resolve(0, 'CreativeContentPacket', 'fixture:slab'), seq.resolve(0, 'CreativeContentPacket', 'fixture:dust'), dec.resolver(true, STATES).resolve(0, 'CreativeContentPacket', 'fixture:slab')], [STATES[0], null, null]);
	assert.deepEqual(seq.seen.CreativeContentPacket, [null]);
	const d = dump();
	delete d.start_game;
	const r = dec.compare(d, data());
	assert.match(r.blocks.rule, /^not known, since the capture has no StartGamePacket, so none became a state$/);
	assert.ok(!r.match && r.blocks.unresolved.length === 3 && r.rows.some((x) => x.packet === 'StartGamePacket' && x.file === 'block network IDs'));
});

test('recipes take the generator\'s order: PHP json_encode with sorted keys and a letter per duplicate, compared byte by byte', () => {
	assert.equal(dec.phpJson({ a: 'x/y\u00e9' }), '{"a":"x\\/y\\u00e9"}');
	assert.deepEqual(dec.sortRecipes(['a\u00e9', 'a0', 'a/b', 'a0']), ['a0', 'a0', 'a/b', 'a\u00e9']);
	assert.deepEqual(dec.sortRecipes([1, 12]), [12, 1]);
	assert.deepEqual(JSON.stringify(dec.sortRecipes([{ b: 1, a: 2 }, { a: 1 }])), '[{"a":1},{"a":2,"b":1}]');
	assert.match(dec.unmatched(['x', 'y', 'y'], ['y', 'z']), /^entries: capture 3, ours 2; 2 only in the capture, 1 only in ours, first "x"; first of ours "z"$/);
});

test('an ingredient\'s meta becomes a state only for a block item, through block_state_meta_map.json, and keeps the generator\'s other rules', () => {
	const look = dec.metaLookup(STATES, [0, 0, 1], { 'fixture:lamp': 'fixture:lamp', 'fixture:slab': 'fixture:slab' });
	assert.deepEqual([look('fixture:lamp', 1), look('fixture:lamp', 7), look('fixture:slab', 9), look('fixture:dust', 0), dec.metaLookup(STATES, [0, 0, 1], {})('fixture:lamp', 1)], [STATES[2], null, STATES[0], null, null]);
	const got = [ing('fixture:lamp:1', 1), ing('fixture:lamp', 7, 2), ing('fixture:slab', 5), ing('fixture:dust', 32767), ing('fixture:dust', 0), ing('fixture:dust:2', 3), tagIn(), null].map((x) => dec.ingredientJson(x, look));
	assert.deepEqual(got, [{ name: 'fixture:lamp', block_states: LIT }, { name: 'fixture:lamp', meta: 7, count: 2 }, { name: 'fixture:slab' }, { name: 'fixture:dust', meta: 32767 }, { name: 'fixture:dust' }, { name: 'fixture:dust', meta_suffix: '2', meta: 3 }, { tag: 'fixture:tag' }, null]);
});

test('a creative row says how many of ours the capture leaves out and whether the rest keep our order', () => {
	const d = dump();
	d.creative.items.splice(1, 1);
	assert.match(dec.compare(d, data()).rows.find((x) => x.file === 'creative/construction.json').note, /^items: capture 2, ours 3; 2 are ours in our order, 1 of ours are not among them, 0 are not ours in that order$/);
	d.creative.items.reverse();
	assert.match(dec.leftOut(dec.derive(d, dec.resolver(true, STATES))['creative/construction.json'][1], [{ items: [{ name: 'fixture:lamp', block_states: LIT }, { name: 'fixture:dust', count: 2 }] }]), /1 are not ours in that order, first /);
});

test('the decode runs in a throwaway container with no network, the package and capture read-only, and is removed by name', () => {
	const a = dec.dockerArgs('cap.bin', 'img');
	const name = a[a.indexOf('--name') + 1];
	assert.match(name, /^riftal_smoke_bds_decode_\d+$/);
	assert.deepEqual([a[0], a[1], ...['--network', '-m', '--cpus'].map((k) => a[a.indexOf(k) + 1])], ['run', '--rm', 'none', '1g', '1']);
	assert.ok(!a.includes('-p') && !a.includes('--publish') && a.some((x) => x.endsWith(`${path.join('packages', 'bedrock-protocol')}:/protocol:ro`)));
	assert.deepEqual(a.filter((x) => x.includes(':/') && !x.startsWith('phar:')).map((x) => x.split(':').pop()), ['ro', 'ro', 'ro']);
	assert.deepEqual(a.slice(-4), ['/tool/decode.php', dec.AUTOLOAD, '/protocol', '/capture.bin']);
	assert.throws(() => dec.parseArgs([]), /exactly one of --capture and --dump/);
	assert.throws(() => dec.parseArgs(['--capture', 'a', '--dump', 'b']), /exactly one/);
	const calls = [];
	const lines = [];
	const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: args[0] === 'image' ? 'sha256:feed\n' : JSON.stringify(dump()) }; };
	assert.equal(dec.main(['--capture', 'cap.bin', '--data-dir', data(), '--docker', 'dk'], (s) => lines.push(s), run), 0);
	assert.deepEqual(calls.map((c) => c.slice(0, 4)), [['dk', 'image', 'inspect', '--format'], ['timeout', '--kill-after=10', '300', 'dk'], ['dk', 'rm', '-f', name]]);
	assert.ok(calls[1].includes('sha256:feed') && !calls[1].includes(dec.IMAGE) && lines[0].includes(`in ${dec.IMAGE} (sha256:feed),`));
});

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
const BIOMES = { 'fixture:plains': { id: 1, rain: true, tags: ['warm'] } };
const SHAPES = { nameMap: { 'fixture:box': 1 }, shapes: [{ cells: { storage: [1], xSize: 1, ySize: 1, zSize: 1 }, x: [0, 1], y: [0, 1], z: [0, 1] }] };

const data = () => fx.writeTree(fx.tempDir('bds-decode'), {
	'canonical_block_states.nbt': nbt(STATES),
	'protocol_info.json': { version: { major: 1, minor: 2, patch: 3, revision: 4, protocol_version: 99 } },
	'required_item_list.json': { 'fixture:lamp': { runtime_id: -1, component_based: false, version: 2 }, 'fixture:dust': { runtime_id: 5, component_based: true, version: 1, component_nbt: 'AAA=' } },
	'creative/construction.json': [{ group_icon: null, group_name: 'g', items: [{ name: 'fixture:lamp', block_states: LIT }, 'fixture:dust', { name: 'fixture:dust', count: 2 }] }],
	'creative/nature.json': [], 'creative/equipment.json': [], 'creative/items.json': [],
	'data_driven_blocks.nbt': 'a', 'entity_identifiers.nbt': 'b', 'jigsaw_structures_data.nbt': 'c', 'biome_definitions.json': BIOMES, 'voxel_shapes.json': SHAPES,
});

// A dump as decode.php prints one, from a server sending hashed or sequential block IDs.
function dump(hashes = true) {
	const id = (i) => (hashes ? dec.blockHash(STATES[i]) : i);
	return {
		protocol: 99, version: '1.2.3', records: 8, unknown: [], start_game: { hashes, experiments: [], education: false, data_driven_blocks: sha('a') },
		items: [{ name: 'fixture:lamp', runtime_id: -1, component_based: false, version: 2, component_nbt: null }, { name: 'fixture:dust', runtime_id: 5, component_based: true, version: 1, component_nbt: 'AAA=' }],
		creative: { groups: [{ category: 1, name: 'g', icon: null }], items: [stack('fixture:lamp', id(2)), stack('fixture:dust', 0), stack('fixture:dust', 0, { count: 2 })].map((item) => ({ group: 0, item })) },
		crafting: { outputs: [stack('fixture:lamp', id(1)), stack('fixture:dust', 0)] },
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
		assert.deepEqual(r.blocks.seen, { CreativeContentPacket: [null], CraftingDataPacket: [null] });
	}
	const lines = [];
	assert.equal(dec.main(['--dump', path.join(fx.writeTree(fx.tempDir('bds-decode'), { 'd.json': dump() }), 'd.json'), '--data-dir', data()], (s) => lines.push(s)), 0);
	assert.match(lines[0], /CreativeContentPacket: 1 IDs, 1 became states of the item's own block, 0 did not\n[\s\S]*MATCH creative\/construction\.json[\s\S]*not compared: recipes\/potion_container_change\.json[\s\S]*\nMATCH$/);
});

test('an ID that names no state, or a state of another block, a changed value, a missing packet or an unknown one is a MISMATCH', () => {
	for (const [mutate, file, want] of [
		[(d) => { d.creative.items[0].item.block = 12345; }, 'blocks', /^12345$/],
		[(d) => { d.crafting.outputs[0].name = 'fixture:slab'; }, 'blocks', /\(fixture:lamp for fixture:slab\)$/],
		[(d) => { d.creative.items[2].item.count = 3; }, 'creative/construction.json', /^\[0\]\.items\[2\]\.count: capture 3, ours 2$/],
		[(d) => { d.items[1].component_nbt = null; }, 'required_item_list.json', /component_nbt: capture absent, ours "AAA="$/],
		[(d) => { d.jigsaw = sha('d'); }, 'jigsaw_structures_data.nbt', /^sha256 capture /],
		[(d) => { delete d.biomes; }, 'biome_definitions.json', /^BiomeDefinitionListPacket is not in the capture$/],
		[(d) => { d.unknown = [999]; }, 'capture', /does not know: 999$/],
		[(d) => { delete d.crafting; }, 'block network IDs', /^CraftingDataPacket is not in the capture, so its block network IDs are not accounted for$/],
	]) {
		const d = dump();
		mutate(d);
		const r = dec.compare(d, data());
		const found = file === 'blocks' ? r.blocks.unresolved : r.rows.find((x) => x.file === file).diffs;
		assert.ok(!r.match && found.some((s) => want.test(s)), `${file}: ${found}`);
	}
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
	assert.ok(!r.match && r.blocks.unresolved.length === 2 && r.rows.some((x) => x.packet === 'StartGamePacket' && x.file === 'block network IDs'));
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

#!/usr/bin/env node
'use strict';

// Decodes a capture.bin with decode.php, our packages/bedrock-protocol in a PHP container
// with no network, and compares the BedrockData files ADR 002 sources from packets with
// packages/bedrock-data. Each block network ID in CreativeContentPacket and
// CraftingDataPacket becomes one of our states by the rule StartGamePacket puts in force:
// a hash is matched with FNV-1a 32 of each state's little-endian NBT, a sequential ID is
// taken as its index. An ID that names no state of the item's own block, and any other
// difference, is a MISMATCH and exits 1. Run it where docker is local, as inspect.js says.
// Usage: node tools/bds/decode.js (--capture <capture.bin> | --dump <json>) [--image <image>]
//   [--docker <command>] [--data-dir <dir>] [--save-dump <json>]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { spawnSync } = require('child_process');
const samples = require('./samples');
const pkg = require('../lib/packages');

// The image needs only PHP with ext-encoding and the PocketMine-MP phar's libraries. It runs
// by the ID the tag names when the run starts, and the report names both.
const IMAGE = 'local-pocketmine-mp:latest';
const AUTOLOAD = 'phar:///opt/pocketmine/PocketMine-MP.phar/vendor/autoload.php';
const CATEGORIES = { 1: 'construction', 2: 'nature', 3: 'equipment', 4: 'items' };
const NOT_COMPARED = ['potion_container_change', 'potion_type', 'shaped_crafting', 'shaped_crafting_asymmetric', 'shapeless_crafting', 'shapeless_shulker_box', 'smithing', 'smithing_trim', 'special_hardcoded'].map((r) => `recipes/${r}.json`);

const leString = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length & 0xff, b.length >> 8]), b]); };
const leTag = (t, k, payload) => Buffer.concat([Buffer.from([t]), leString(k), payload]);
const leInt = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const leValue = ([k, t, v]) => (t === 's' ? leTag(8, k, leString(v)) : t === 'b' ? leTag(1, k, Buffer.from([v & 0xff])) : leTag(3, k, leInt(v)));
const leCompound = (k, tags) => Buffer.concat([leTag(10, k, Buffer.concat(tags)), Buffer.from([0])]);
// The block_states form BedrockData stores: the states alone, in our file's order.
const leStates = (states) => leCompound('', states.map(leValue));

const fnv1a32 = (buf) => buf.reduce((h, c) => Math.imul(h ^ c, 0x01000193) >>> 0, 0x811c9dc5);

// What BDS sends with block-network-ids-are-hashes=true, as a signed 32-bit ID: the hash of
// the state's name and its states sorted by name.
const blockHash = (s) => fnv1a32(leCompound('', [leTag(8, 'name', leString(s.name)), leCompound('states', [...s.states].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(leValue))])) | 0;

// A hash two of our states share names neither, and a state of a block other than the
// item's is not the item's, so both stay unresolved. hashes is null when the capture has no
// StartGamePacket, and then no ID becomes a state.
function resolver(hashes, canonical) {
	const byHash = new Map();
	if (hashes) for (const s of canonical) { const h = blockHash(s); byHash.set(h, byHash.has(h) ? null : s); }
	const seen = { CreativeContentPacket: [], CraftingDataPacket: [] };
	const resolve = (id, packet, item) => {
		// 0 is also what an item with no block sends, so it names a block only as state 0 of
		// the item's own block under sequential IDs.
		if (id === 0 && (hashes !== false || !canonical.length || canonical[0].name !== item)) return null;
		const s = (hashes === null ? null : hashes ? byHash.get(id) : canonical[id]) || null;
		seen[packet].push(s && s.name === item ? null : `${id}${s ? ` (${s.name} for ${item})` : ''}`);
		return s && s.name === item ? s : null;
	};
	const rule = hashes === null ? 'not known, since the capture has no StartGamePacket, so none became a state' : hashes ? 'hashes, each matched with FNV-1a 32 of the little-endian NBT {name, states sorted by name} of a state in canonical_block_states.nbt' : 'sequential, each taken as an index in canonical_block_states.nbt, which holds only for a server whose palette is that file';
	return { resolve, seen, rule };
}

// The form BedrockData stores an item in, by the rules of pmmp-core's tools/generate-bedrock-data-from-packets.php.
function itemJson(s, resolve) {
	if (!s) return null;
	const o = { name: s.name };
	const meta = s.meta === 32767 ? 0 : s.meta;
	if (s.count !== 1) o.count = s.count;
	const state = resolve(s.block, s.name);
	if (state && state.states.length) o.block_states = leStates(state.states).toString('base64');
	if (meta !== 0) o.meta = meta;
	if (s.nbt) o.nbt = s.nbt;
	if (s.can_place_on.length) o.can_place_on = s.can_place_on;
	if (s.can_destroy.length) o.can_destroy = s.can_destroy;
	return Object.keys(o).length === 1 ? s.name : o;
}

// Each file's packet and the value derived from the dump: JSON, or a sha256 for an NBT file.
function derive(d, blocks) {
	const rows = {
		'required_item_list.json': ['ItemRegistryPacket', d.items && Object.fromEntries(d.items.map((e) => [e.name, { runtime_id: e.runtime_id, component_based: e.component_based, version: e.version, ...(e.component_nbt ? { component_nbt: e.component_nbt } : {}) }]))],
		'data_driven_blocks.nbt': ['StartGamePacket', d.start_game && d.start_game.data_driven_blocks],
		'biome_definitions.json': ['BiomeDefinitionListPacket', d.biomes],
		'entity_identifiers.nbt': ['AvailableActorIdentifiersPacket', d.actors],
		'jigsaw_structures_data.nbt': ['JigsawStructureDataPacket', d.jigsaw],
		'voxel_shapes.json': ['VoxelShapesPacket', d.voxel_shapes && { nameMap: d.voxel_shapes.nameMap, shapes: d.voxel_shapes.shapes }],
	};
	for (const c of Object.values(CATEGORIES)) rows[`creative/${c}.json`] = ['CreativeContentPacket', d.creative && []];
	const item = (s) => itemJson(s, (id, name) => blocks.resolve(id, 'CreativeContentPacket', name));
	if (d.creative) d.creative.groups.forEach((g, i) => (rows[`creative/${CATEGORIES[g.category] || `category ${g.category}`}.json`] ||= ['CreativeContentPacket', []])[1].push({ group_icon: item(g.icon), group_name: g.name, items: d.creative.items.filter((x) => x.group === i).map((x) => item(x.item)) }));
	if (d.crafting) d.crafting.outputs.forEach((s) => s && blocks.resolve(s.block, 'CraftingDataPacket', s.name));
	return rows;
}

const show = (v) => (v === undefined ? 'absent' : JSON.stringify(v).slice(0, 80));
function diff(a, b, at, out) {
	if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
		if (Array.isArray(a) && a.length !== b.length) out.push(`${at}: length capture ${a.length}, ours ${b.length}`);
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${at}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
	} else if (a !== b) out.push(`${at}: capture ${show(a)}, ours ${show(b)}`);
	return out;
}

// For explanation only, never a MATCH: whether the capture's creative items are ours with
// some left out, in our order.
function leftOut(got, ours) {
	const key = (x) => (typeof x === 'string' ? x : JSON.stringify(Object.fromEntries(Object.entries(x).sort())));
	const [a, b] = [got, ours].map((gs) => gs.flatMap((g) => g.items.map(key)));
	let j = 0;
	const extra = a.filter((x) => { const k = b.indexOf(x, j); if (k < 0) return true; j = k + 1; return false; });
	return `items: capture ${a.length}, ours ${b.length}; ${a.length - extra.length} are ours in our order, ${b.length - a.length + extra.length} of ours are not among them, ${extra.length} are not ours in that order${extra.length ? `, first ${extra[0].slice(0, 80)}` : ''}`;
}

function compare(d, dataDir) {
	const canonical = samples.readStateList(fs.readFileSync(path.join(dataDir, 'canonical_block_states.nbt')));
	const blocks = resolver(d.start_game ? d.start_game.hashes : null, canonical);
	const rows = Object.entries(derive(d, blocks)).map(([file, [packet, got]]) => {
		const p = path.join(dataDir, file);
		if (got === undefined || got === null) return { file, packet, diffs: [`${packet} is not in the capture`] };
		if (!fs.existsSync(p)) return { file, packet, diffs: ['not in packages/bedrock-data'] };
		const ours = file.endsWith('.nbt') ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : JSON.parse(fs.readFileSync(p, 'utf8'));
		if (typeof ours === 'string') return { file, packet, diffs: got === ours ? [] : [`sha256 capture ${got}, ours ${ours}`] };
		return { file, packet, diffs: diff(got, ours, '', []), note: file.startsWith('creative/') ? leftOut(got, ours) : null };
	});
	if (!d.start_game) rows.push({ file: 'block network IDs', packet: 'StartGamePacket', diffs: ['no StartGamePacket, so no rule for them is known'] });
	if (!d.crafting) rows.push({ file: 'block network IDs', packet: 'CraftingDataPacket', diffs: ['CraftingDataPacket is not in the capture, so its block network IDs are not accounted for'] });
	if (d.unknown.length) rows.push({ file: 'capture', packet: 'any', diffs: [`packet IDs packages/bedrock-protocol does not know: ${d.unknown.join(', ')}`] });
	const unresolved = Object.values(blocks.seen).flat().filter((x) => x !== null);
	return { match: !unresolved.length && rows.every((r) => !r.diffs.length), rows, blocks: { ...blocks, unresolved } };
}

function render(r, header, d) {
	const lines = [header];
	if (d.start_game) lines.push(`StartGamePacket: experiments ${JSON.stringify(d.start_game.experiments)}, education features ${d.start_game.education}`);
	lines.push(`block network IDs: ${r.blocks.rule}`);
	const sent = { CreativeContentPacket: d.creative, CraftingDataPacket: d.crafting };
	for (const [p, ids] of Object.entries(r.blocks.seen)) {
		const bad = ids.filter((x) => x !== null);
		lines.push(!sent[p] ? `  ${p}: not in the capture` : `  ${p}: ${ids.length} IDs, ${ids.length - bad.length} became states of the item's own block, ${bad.length} did not${bad.length ? `: ${[...new Set(bad)].slice(0, 20).join(', ')}` : ''}`);
	}
	for (const x of r.rows) lines.push(`${x.diffs.length ? 'MISMATCH' : 'MATCH'} ${x.file} (${x.packet})${x.diffs.length ? `: ${x.diffs.length} differences` : ''}`, ...x.diffs.slice(0, 8).map((s) => `    ${s}`), ...(x.diffs.length && x.note ? [`  ${x.note}`] : []));
	return [...lines, `not compared: ${NOT_COMPARED.join(', ')} (CraftingDataPacket)`, r.match ? 'MATCH' : 'MISMATCH'].join('\n');
}

function dockerArgs(capture, image) {
	return [
		'run', '--rm', '--init', '--name', `riftal_smoke_bds_decode_${process.pid}`, '--network', 'none', '-m', '1g', '--cpus', '1', '--entrypoint', 'php',
		'-v', `${path.join(pkg.REPO, 'packages', 'bedrock-protocol')}:/protocol:ro`, '-v', `${path.join(__dirname, 'decode.php')}:/tool/decode.php:ro`, '-v', `${path.resolve(capture)}:/capture.bin:ro`,
		image, '-d', 'memory_limit=1G', '/tool/decode.php', AUTOLOAD, '/protocol', '/capture.bin',
	];
}

function parseArgs(args) {
	const { values: v } = util.parseArgs({ args, strict: true, options: { capture: { type: 'string' }, dump: { type: 'string' }, image: { type: 'string', default: IMAGE }, docker: { type: 'string', default: 'docker' }, 'data-dir': { type: 'string', default: path.join(pkg.REPO, 'packages', 'bedrock-data') }, 'save-dump': { type: 'string' } } });
	if (!v.capture === !v.dump) throw new Error('give exactly one of --capture and --dump');
	return v;
}

function main(argv, log = (s) => process.stdout.write(`${s}\n`), run = spawnSync) {
	const a = parseArgs(argv);
	let text = a.dump && fs.readFileSync(a.dump, 'utf8');
	let image = '';
	if (a.capture) {
		const id = run(a.docker, ['image', 'inspect', '--format', '{{.Id}}', a.image], { encoding: 'utf8' });
		if (id.error || id.status !== 0 || !id.stdout.trim()) throw id.error || new Error(`no image ${a.image}`);
		image = id.stdout.trim();
		const args = dockerArgs(a.capture, image);
		const r = run('timeout', ['--kill-after=10', '300', a.docker, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });
		// A forced timeout can kill the docker CLI while the container runs on.
		run(a.docker, ['rm', '-f', args[args.indexOf('--name') + 1]], { stdio: 'ignore' });
		if (r.error || r.status !== 0) throw r.error || new Error(`decode.php exited ${r.status}`);
		if (a['save-dump']) fs.writeFileSync(a['save-dump'], r.stdout);
		text = r.stdout;
	}
	const d = JSON.parse(text);
	const r = compare(d, a['data-dir']);
	const v = JSON.parse(fs.readFileSync(path.join(a['data-dir'], 'protocol_info.json'), 'utf8')).version;
	log(render(r, `${a.capture || a.dump}: ${d.records} records, decoded by packages/bedrock-protocol ${d.version} (protocol ${d.protocol})${a.capture ? ` in ${a.image} (${image})` : ''}, against packages/bedrock-data ${v.major}.${v.minor}.${v.patch}.${v.revision} (protocol ${v.protocol_version})`, d));
	return r.match ? 0 : 1;
}

if (require.main === module) {
	try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`bds decode: ${e.message}\n`); process.exitCode = 2; }
}

module.exports = { IMAGE, AUTOLOAD, NOT_COMPARED, leStates, fnv1a32, blockHash, resolver, itemJson, derive, diff, leftOut, compare, dockerArgs, parseArgs, main };

#!/usr/bin/env node
'use strict';

// Derives the block state list and the item table from Mojang/bedrock-samples and
// compares them with packages/bedrock-data. The repository is "all rights reserved,
// subject to the Minecraft EULA"; the steward's ruling item 1 on #3 (issuecomment
// 6761625992) admits it under that EULA for protocol work, so a tag is cloned into the
// cache and never committed. Any difference is a MISMATCH, and the process exits 1.
//
// Usage: node tools/bds/samples.js [--tag <tag>] [--samples-dir <dir>] [--data-dir <dir>] [--json]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const docs = require('../lib/mojang-docs');
const pkg = require('../lib/packages');

const SAMPLES_URL = 'https://github.com/Mojang/bedrock-samples';
const MODULES = 'metadata/vanilladata_modules';
const TAG = /^v\d+\.\d+\.\d+\.\d+(?:-preview)?$/;
const TYPES = { bool: 'b', int: 'i', string: 's' };
const NBT_TYPES = { 1: 'b', 3: 'i', 8: 's' };

function parseArgs(argv) {
	const a = { tag: 'v1.26.60.5', samples_dir: null, data_dir: path.join(pkg.REPO, 'packages', 'bedrock-data'), json: false };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--json') a.json = true;
		else if (['--tag', '--samples-dir', '--data-dir'].includes(k)) {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
			a[k.slice(2).replace('-', '_')] = v;
		} else throw new Error(`unknown argument ${k}`);
	}
	if (!TAG.test(a.tag)) throw new Error(`not a bedrock-samples release or preview tag: ${a.tag}`);
	return a;
}

// Cloned under a temporary name and renamed only once complete, so an interrupted clone
// never leaves a tree later runs would trust. `run` stands in for git in tests.
function checkout(tag, run = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })) {
	if (!TAG.test(tag)) throw new Error(`not a bedrock-samples release or preview tag: ${tag}`);
	const dir = path.join(docs.cacheRoot(), 'bedrock-samples', tag);
	if (fs.existsSync(path.join(dir, '.checkout-complete'))) return dir;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const partial = `${dir}.partial-${process.pid}`;
	fs.rmSync(partial, { recursive: true, force: true });
	try {
		run(['clone', '-q', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', SAMPLES_URL, partial]);
		run(['-C', partial, 'sparse-checkout', 'set', MODULES]);
		fs.writeFileSync(path.join(partial, '.checkout-complete'), `${tag}\n`);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.renameSync(partial, dir);
	} catch (e) {
		fs.rmSync(partial, { recursive: true, force: true, maxRetries: 5 });
		throw e;
	}
	return dir;
}

// Network NBT, as canonical_block_states.nbt is written: varint lengths and zigzag
// varint ints. A block state is a byte, an int or a string, so any other tag fails.
function readStateList(buf) {
	let o = 0;
	const fail = (message) => { throw new Error(`NBT: ${message}`); };
	const byte = () => (o < buf.length ? buf[o++] : fail(`truncated at byte ${o}`));
	const uvarint = () => {
		let v = 0;
		for (let shift = 0, b = 0x80; b & 0x80; shift += 7) {
			if (shift > 28) fail(`varint too long at byte ${o}`);
			b = byte();
			v += (b & 0x7f) * 2 ** shift;
		}
		return v;
	};
	const string = () => {
		const n = uvarint();
		if ((o += n) > buf.length) fail(`truncated at byte ${o - n}`);
		return buf.toString('utf8', o - n, o);
	};
	const payload = (t) => {
		if (t === 1) return byte() << 24 >> 24;
		if (t === 3) return ((u) => (u % 2 ? -(u + 1) / 2 : u / 2))(uvarint());
		if (t === 8) return string();
		if (t !== 10) fail(`tag type ${t} at byte ${o - 1} is not a block state value`);
		const c = {};
		for (let tt = byte(); tt !== 0; tt = byte()) c[string()] = { t: tt, v: payload(tt) };
		return c;
	};
	const out = [];
	while (o < buf.length) {
		if (byte() !== 10) fail(`root at byte ${o - 1} is not a compound`);
		string();
		const { name, states, ...rest } = payload(10);
		if (!name || name.t !== 8 || !states || states.t !== 10) fail(`state ${out.length} has no name or states`);
		const list = Object.entries(states.v).map(([k, s]) => [k, NBT_TYPES[s.t] || fail(`${name.v} state ${k} has tag type ${s.t}`), s.v]);
		out.push({ name: name.v, states: list, fields: Object.keys(rest) });
	}
	return out;
}

// FNV-1 64 of the block name, the order BDS gives block network IDs in.
function fnv1(s) {
	let h = 0xcbf29ce484222325n;
	for (const c of Buffer.from(s)) h = ((h * 0x100000001b3n) & 0xffffffffffffffffn) ^ BigInt(c);
	return h;
}

// Every combination of each block's property values, its first property varying
// fastest. Samples list a property's values once for every block that uses it.
function deriveStates(blocks) {
	if (!Array.isArray(blocks.block_properties) || !Array.isArray(blocks.data_items)) throw new Error('samples: mojang-blocks.json has no block_properties or data_items');
	const props = new Map(blocks.block_properties.map((p) => [p.name, p]));
	const out = [];
	const hashed = blocks.data_items.map((b) => [fnv1(b.name), b]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
	for (const [, b] of hashed) {
		let combos = [[]];
		for (const name of (b.properties || []).map((p) => p.name).sort()) {
			const p = props.get(name);
			if (!p || !TYPES[p.type]) throw new Error(`samples: ${b.name} uses unknown property ${name}`);
			combos = p.values.flatMap((v) => combos.map((c) => [...c, [name, TYPES[p.type], p.type === 'bool' ? Number(v.value) : v.value]]));
		}
		for (const states of combos) out.push({ name: b.name, states, fields: [] });
	}
	return out;
}

const value = ([, t, v]) => `${t}:${JSON.stringify(v)}`;
const stateKey = (s) => `${s.name}[${[...s.states].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((s) => `${s[0]}=${value(s)}`).join(',')}]`;
const minus = (a, b) => [...a].filter((x) => !b.has(x));
const entry = (m, k, make) => m.get(k) || m.set(k, make()).get(k);

// Block name to property name to the set of its values.
function valueSets(states) {
	const m = new Map();
	for (const s of states) {
		const props = entry(m, s.name, () => new Map());
		for (const st of s.states) entry(props, st[0], () => new Set()).add(value(st));
	}
	return m;
}

// A state's position in canonical_block_states.nbt is its network ID, so the states both
// lists share must stand in the same order, element by element, across blocks and within.
function orderDiffers(a, b) {
	let i = 0;
	while ((i < a.length || i < b.length) && a[i] === b[i]) i++;
	return i === a.length && i === b.length ? [] : [`from shared state ${i}: samples ${a[i] ?? 'end of list'}, ours ${b[i] ?? 'end of list'}`];
}

function compareStates(derived, ours) {
	const [dk, ok] = [derived.map(stateKey), ours.map(stateKey)];
	const [ds, os, dv, ov] = [new Set(dk), new Set(ok), valueSets(derived), valueSets(ours)];
	const values = [];
	for (const [name, props] of dv) {
		if (!ov.has(name)) continue;
		for (const k of new Set([...props.keys(), ...ov.get(name).keys()])) {
			const [a, b] = [props.get(k) || new Set(), ov.get(name).get(k) || new Set()];
			if (minus(a, b).length || minus(b, a).length) values.push(`${name} ${k}: samples only [${minus(a, b)}], ours only [${minus(b, a)}]`);
		}
	}
	return {
		samples: { names: dv.size, states: dk.length },
		ours: { names: ov.size, states: ok.length },
		names_only_samples: minus(dv.keys(), ov),
		names_only_ours: minus(ov.keys(), dv),
		values_differ: values,
		states_only_samples: minus(dk, os),
		states_only_ours: minus(ok, ds),
		order_differs: orderDiffers(dk.filter((k) => os.has(k)), ok.filter((k) => ds.has(k))),
		fields_not_in_samples: [...new Set(ours.flatMap((s) => s.fields))],
	};
}

function compareItems(items, ours, blockNames) {
	if (!Array.isArray(items.data_items)) throw new Error('samples: mojang-items.json has no data_items');
	const sm = new Map(items.data_items.map((i) => [i.name, i.raw_id]));
	const onlyOurs = Object.keys(ours).filter((n) => !sm.has(n));
	return {
		samples: sm.size,
		ours: Object.keys(ours).length,
		only_samples: [...sm.keys()].filter((n) => !(n in ours)),
		only_ours_named_as_block: onlyOurs.filter((n) => blockNames.has(n)),
		only_ours_other: onlyOurs.filter((n) => !blockNames.has(n)),
		id_differs: [...sm].filter(([n, id]) => n in ours && ours[n].runtime_id !== id).map(([n, id]) => `${n}: samples ${id}, ours ${ours[n].runtime_id}`),
		fields_not_in_samples: [...new Set(Object.values(ours).flatMap((e) => Object.keys(e)))].filter((k) => k !== 'runtime_id'),
	};
}

// Every list in the report names a difference, so the two tables match only when all
// of them are empty.
function compare(samplesDir, dataDir) {
	const read = (f) => JSON.parse(fs.readFileSync(path.join(samplesDir, MODULES, f), 'utf8'));
	const derived = deriveStates(read('mojang-blocks.json'));
	const ours = readStateList(fs.readFileSync(path.join(dataDir, 'canonical_block_states.nbt')));
	const blocks = compareStates(derived, ours);
	const names = new Set([...derived, ...ours].map((s) => s.name));
	const items = compareItems(read('mojang-items.json'), JSON.parse(fs.readFileSync(path.join(dataDir, 'required_item_list.json'), 'utf8')), names);
	const match = [blocks, items].every((r) => Object.values(r).every((v) => !Array.isArray(v) || v.length === 0));
	return { match, blocks, items };
}

function render(r, header) {
	const list = (xs) => (xs.length > 20 ? `${xs.slice(0, 20).join(', ')} and ${xs.length - 20} more` : xs.join(', ') || 'none');
	const show = (v) => (Array.isArray(v) ? `(${v.length}) ${list(v)}` : typeof v === 'object' ? Object.entries(v).map((e) => e.join(' ')).join(', ') : v);
	const lines = [header];
	for (const section of ['blocks', 'items']) lines.push(`${section}:`, ...Object.entries(r[section]).map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${show(v)}`));
	return [...lines, r.match ? 'MATCH' : 'MISMATCH'].join('\n');
}

function main(argv, log = (s) => process.stdout.write(`${s}\n`)) {
	const a = parseArgs(argv);
	const r = compare(a.samples_dir || checkout(a.tag), a.data_dir);
	const v = JSON.parse(fs.readFileSync(path.join(a.data_dir, 'protocol_info.json'), 'utf8')).version;
	const header = `bedrock-samples ${a.tag} against packages/bedrock-data ${v.major}.${v.minor}.${v.patch}.${v.revision} (protocol ${v.protocol_version})`;
	log(a.json ? JSON.stringify({ header, ...r }, null, '\t') : render(r, header));
	return r.match ? 0 : 1;
}

if (require.main === module) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`bds samples: ${e.message}\n`);
		process.exitCode = 2;
	}
}

module.exports = { MODULES, parseArgs, checkout, readStateList, fnv1, deriveStates, stateKey, compareStates, compare, main };

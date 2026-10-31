'use strict';

// Reads Mojang/bedrock-protocol-docs. The repository is "all rights reserved, subject to
// the Minecraft EULA", so tags are cloned into a cache outside this repository and never
// committed here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DOCS_URL = 'https://github.com/Mojang/bedrock-protocol-docs';
const VOLATILE_KEYS = new Set(['$schema', 'x-minecraft-version', 'x-protocol-version', 'x-format-version']);
const PROSE_KEYS = new Set(['description', 'x-runtime-constraint-description', '[cereal:packet_details]']);

function cacheRoot() {
	if (process.env.RIFTAL_PROTOCOL_CACHE) return process.env.RIFTAL_PROTOCOL_CACHE;
	if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'riftal-protocol', 'cache');
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'riftal-protocol');
}

function git(args, opts = {}) {
	return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function parseTag(tag) {
	const m = /^v(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(tag);
	if (!m) return null;
	return { tag, version: `${m[1]}.${m[2]}.${m[3]}`, preview: m[4] === undefined ? null : Number(m[4]), parts: [m[1], m[2], m[3]].map(Number) };
}

// Orders releases after every preview of the same version.
function compareTags(a, b) {
	for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
	const pa = a.preview === null ? Infinity : a.preview;
	const pb = b.preview === null ? Infinity : b.preview;
	return pa === pb ? 0 : pa < pb ? -1 : 1;
}

function parseLsRemote(text) {
	return text.split(/\r?\n/)
		.map((l) => /refs\/tags\/([^^]+)$/.exec(l))
		.filter(Boolean)
		.map((m) => parseTag(m[1]))
		.filter(Boolean)
		.sort(compareTags);
}

function listTags() {
	return parseLsRemote(git(['ls-remote', '--tags', DOCS_URL]));
}

// The newest tag whose version is the given client or library version, preferring a
// release over previews. A client build such as 1.26.60.5 maps to tag v1.26.60.
function tagForVersion(tags, version) {
	const v = version.split('.').slice(0, 3).join('.');
	const matches = tags.filter((t) => t.version === v);
	return matches.length ? matches[matches.length - 1] : null;
}

function checkout(tag) {
	const dir = path.join(cacheRoot(), 'mojang-docs', tag);
	if (!fs.existsSync(path.join(dir, 'json'))) {
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.rmSync(dir, { recursive: true, force: true });
		git(['clone', '-q', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', DOCS_URL, dir]);
		git(['-C', dir, 'sparse-checkout', 'set', 'json', 'developer_notes']);
	}
	return dir;
}

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') {
		const out = {};
		for (const k of Object.keys(value).sort()) if (!VOLATILE_KEYS.has(k)) out[k] = stable(value[k]);
		return out;
	}
	return value;
}

// Strips prose and enum value annotations so two schemas compare equal when only their
// documentation differs. Explicit enum values are compared separately by wireChanged,
// because Mojang began publishing them for enums whose values were already fixed.
function wire(value) {
	if (Array.isArray(value)) return value.map(wire);
	if (value && typeof value === 'object') {
		const out = {};
		for (const k of Object.keys(value).sort()) {
			if (VOLATILE_KEYS.has(k) || PROSE_KEYS.has(k) || k === 'x-enum-binary-value') continue;
			out[k] = wire(value[k]);
		}
		return out;
	}
	return value;
}

function wireChanged(a, b) {
	if (JSON.stringify(wire(a)) !== JSON.stringify(wire(b))) return true;
	const va = a['x-enum-binary-value'];
	const vb = b['x-enum-binary-value'];
	return va !== undefined && vb !== undefined && JSON.stringify(va) !== JSON.stringify(vb);
}

function refsOf(schema, out = new Set()) {
	if (Array.isArray(schema)) schema.forEach((s) => refsOf(s, out));
	else if (schema && typeof schema === 'object') {
		for (const [k, v] of Object.entries(schema)) {
			if (k === '$ref' && typeof v === 'string') out.add(path.basename(v, '.json'));
			else refsOf(v, out);
		}
	}
	return out;
}

// Loads one tag's schemas from a directory laid out like the docs repository.
function loadDocs(dir) {
	const jsonDir = path.join(dir, 'json');
	const schemas = new Map();
	for (const f of fs.readdirSync(jsonDir).filter((n) => n.endsWith('.json'))) {
		schemas.set(path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8')));
	}
	const packets = new Map();
	const protocols = new Map();
	let minecraftVersion = null;
	for (const [file, s] of schemas) {
		const meta = s.$metaProperties || {};
		if (typeof meta['[cereal:packet]'] === 'number') {
			packets.set(s.title, { id: meta['[cereal:packet]'], file, details: meta['[cereal:packet_details]'] || null });
		}
		if (typeof s['x-protocol-version'] === 'number') protocols.set(s['x-protocol-version'], (protocols.get(s['x-protocol-version']) || 0) + 1);
		if (!minecraftVersion && s['x-minecraft-version']) minecraftVersion = s['x-minecraft-version'];
	}
	const protocol = [...protocols].sort((a, b) => b[1] - a[1])[0];
	const notesDir = path.join(dir, 'developer_notes');
	const notes = new Map();
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else notes.set(path.relative(notesDir, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8'));
		}
	};
	if (fs.existsSync(notesDir)) walk(notesDir);
	return { schemas, packets, protocol: protocol ? protocol[0] : null, minecraftVersion, notes };
}

function closure(schemas, start) {
	const seen = new Set();
	const stack = [start];
	while (stack.length) {
		const name = stack.pop();
		if (seen.has(name) || !schemas.has(name)) continue;
		seen.add(name);
		for (const r of refsOf(schemas.get(name))) stack.push(r);
	}
	return seen;
}

function diffDocs(from, to) {
	const added = [...to.packets.keys()].filter((n) => !from.packets.has(n)).sort();
	const removed = [...from.packets.keys()].filter((n) => !to.packets.has(n)).sort();
	const idChanged = [...to.packets].filter(([n, p]) => from.packets.has(n) && from.packets.get(n).id !== p.id)
		.map(([n, p]) => ({ name: n, from: from.packets.get(n).id, to: p.id })).sort((a, b) => a.name.localeCompare(b.name));

	const changedTypes = [];
	const annotatedTypes = [];
	const addedTypes = [];
	for (const [name, schema] of to.schemas) {
		const old = from.schemas.get(name);
		if (!old) addedTypes.push(name);
		else if (wireChanged(old, schema)) changedTypes.push(name);
		else if (JSON.stringify(stable(schema)) !== JSON.stringify(stable(old))) annotatedTypes.push(name);
	}
	const removedTypes = [...from.schemas.keys()].filter((n) => !to.schemas.has(n));
	const touched = new Set([...changedTypes, ...addedTypes, ...removedTypes]);

	const changedPackets = [];
	for (const [name, p] of to.packets) {
		if (!from.packets.has(name)) continue;
		const via = [...closure(to.schemas, p.file)].filter((t) => touched.has(t));
		const lost = [...closure(from.schemas, from.packets.get(name).file)].filter((t) => removedTypes.includes(t));
		if (via.length || lost.length) changedPackets.push({ name, id: p.id, types: [...new Set([...via, ...lost])].sort() });
	}
	changedPackets.sort((a, b) => a.name.localeCompare(b.name));

	const newNotes = [...to.notes].filter(([f]) => !from.notes.has(f)).map(([file, text]) => ({ file, text: text.trim() }));

	return {
		protocol: { from: from.protocol, to: to.protocol },
		minecraft_version: { from: from.minecraftVersion, to: to.minecraftVersion },
		packets: {
			added: added.map((n) => ({ name: n, id: to.packets.get(n).id, details: to.packets.get(n).details })),
			removed: removed.map((n) => ({ name: n, id: from.packets.get(n).id })),
			id_changed: idChanged,
			changed: changedPackets,
		},
		types: { added: addedTypes.sort(), removed: removedTypes.sort(), changed: changedTypes.sort(), annotation_only: annotatedTypes.sort() },
		developer_notes: newNotes,
	};
}

module.exports = { DOCS_URL, cacheRoot, parseTag, compareTags, parseLsRemote, listTags, tagForVersion, checkout, loadDocs, diffDocs, stable, wire, wireChanged, refsOf };

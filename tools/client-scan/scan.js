#!/usr/bin/env node
// Reads an installed Minecraft Bedrock for Windows client and reports what a protocol
// update needs to know: the client's version and protocol, the gap to our packages,
// packet names the client knows that our packages do not, and the vanilla content that
// changed in the newest version. It reads the client's files and never runs it.
//
// Usage: node tools/client-scan/scan.js [--client <Content dir>] [--offline] [--no-save]

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const docs = require('../lib/mojang-docs');
const pkg = require('../lib/packages');

const DEFAULT_CLIENT = 'C:\\XboxGames\\Minecraft for Windows\\Content';
const BRARCHIVE_MAGIC = 0x267052a0b125277dn;
const BRARCHIVE_ENTRY_BYTES = 256;
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;

function parseArgs(argv) {
	const args = { client: DEFAULT_CLIENT, offline: false, save: true, snapshots: path.join(__dirname, 'snapshots'), packagesSrc: pkg.PROTOCOL_SRC };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--client') args.client = argv[++i];
		else if (a === '--offline') args.offline = true;
		else if (a === '--no-save') args.save = false;
		else if (a === '--snapshots') args.snapshots = argv[++i];
		else if (a === '--packages-src') args.packagesSrc = argv[++i];
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

function compareVersions(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

function peSections(buf) {
	const pe = buf.readUInt32LE(0x3c);
	if (buf.readUInt32LE(pe) !== 0x4550) throw new Error('not a PE image');
	const count = buf.readUInt16LE(pe + 6);
	let off = pe + 24 + buf.readUInt16LE(pe + 20);
	const sections = [];
	for (let i = 0; i < count; i++, off += 40) {
		sections.push({
			name: buf.toString('latin1', off, off + 8).replace(/\0.*$/, ''),
			raw: buf.readUInt32LE(off + 20),
			size: buf.readUInt32LE(off + 16),
		});
	}
	return sections;
}

function fileVersion(buf, sections) {
	const rsrc = sections.find((s) => s.name === '.rsrc');
	if (!rsrc) return null;
	const sig = Buffer.alloc(4);
	sig.writeUInt32LE(VS_FIXEDFILEINFO_SIGNATURE);
	const at = buf.indexOf(sig, rsrc.raw);
	if (at === -1 || at > rsrc.raw + rsrc.size) return null;
	const ms = buf.readUInt32LE(at + 8);
	const ls = buf.readUInt32LE(at + 12);
	return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
}

// Packet class names survive in the stripped client as plain strings. The regex also
// catches unrelated *Packet identifiers from bundled libraries, so the useful signal is
// the difference against BedrockProtocol and against the previous snapshot.
function packetNames(buf, sections) {
	const names = new Set();
	const re = /(?<![A-Za-z])[A-Z][A-Za-z0-9]{2,60}Packet(?![A-Za-z0-9])/g;
	for (const s of sections.filter((x) => x.name === '.rdata' || x.name === '.data')) {
		const text = buf.toString('latin1', s.raw, s.raw + s.size);
		for (const m of text.matchAll(re)) names.add(m[0]);
	}
	return [...names].sort();
}

// MSVC decorated names glue type codes such as AEBV or QEAV onto the front of a class
// name. A name is kept only when no shorter capitalised suffix of it is itself known.
function dropDecorated(names, known) {
	const all = new Set([...names, ...known].map((n) => n.toLowerCase()));
	return names.filter((n) => {
		for (let k = 1; k < n.length - 'Packet'.length; k++) {
			if (/[A-Z]/.test(n[k]) && all.has(n.slice(k).toLowerCase())) return false;
		}
		return true;
	});
}

function diffIgnoringCase(a, b) {
	const sb = new Set(b.map((x) => x.toLowerCase()));
	return a.filter((x) => !sb.has(x.toLowerCase()));
}

function summariseCategories(changed) {
	const groups = new Map();
	for (const [cat, names] of Object.entries(changed)) {
		const key = cat.split('/').slice(0, 2).join('/');
		groups.set(key, (groups.get(key) || 0) + names.length);
	}
	return [...groups].map(([k, n]) => `${k} ${n}`).join(', ');
}

function readBrarchive(file) {
	const buf = fs.readFileSync(file);
	if (buf.length < 16 || buf.readBigUInt64LE(0) !== BRARCHIVE_MAGIC) return null;
	const count = buf.readUInt32LE(8);
	const base = 16 + count * BRARCHIVE_ENTRY_BYTES;
	const entries = [];
	for (let i = 0; i < count; i++) {
		const o = 16 + i * BRARCHIVE_ENTRY_BYTES;
		const name = buf.toString('utf8', o + 1, o + 1 + buf[o]);
		const offset = buf.readUInt32LE(o + 248);
		const length = buf.readUInt32LE(o + 252);
		entries.push({ name, data: buf.subarray(base + offset, base + offset + length) });
	}
	return entries;
}

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// Each vanilla_<version> pack carries only the definitions that changed in that version,
// so a name first seen in the newest pack is content that version introduced.
function packInventory(packsDir) {
	const packs = fs.readdirSync(packsDir)
		.map((n) => ({ dir: n, m: /^vanilla(?:_(\d+(?:\.\d+)+))?$/.exec(n) }))
		.filter((p) => p.m)
		.map((p) => ({ dir: p.dir, version: p.m[1] || '0' }))
		.sort((a, b) => compareVersions(a.version, b.version));

	const inventory = [];
	for (const pack of packs) {
		const root = path.join(packsDir, pack.dir);
		const files = new Map();
		const add = (category, name) => {
			if (!files.has(category)) files.set(category, new Set());
			files.get(category).add(name);
		};
		const archiveRoot = path.join(root, '__brarchive');
		if (fs.existsSync(archiveRoot)) {
			for (const f of walk(archiveRoot).filter((x) => x.endsWith('.brarchive'))) {
				const category = path.relative(archiveRoot, f).replace(/\\/g, '/').replace(/\.brarchive$/, '');
				for (const e of readBrarchive(f) || []) add(category, e.name);
			}
		}
		const contents = path.join(root, 'contents.json');
		if (fs.existsSync(contents)) {
			for (const c of JSON.parse(fs.readFileSync(contents, 'utf8')).content || []) {
				const p = c.path.replace(/\\/g, '/');
				const slash = p.lastIndexOf('/');
				if (slash > 0 && !p.endsWith('.brarchive')) add(p.slice(0, slash), p.slice(slash + 1));
			}
		}
		inventory.push({ dir: pack.dir, version: pack.version, files });
	}
	return inventory;
}

function newestDelta(inventory) {
	if (inventory.length === 0) return null;
	const newest = inventory[inventory.length - 1];
	const seen = new Map();
	for (const pack of inventory.slice(0, -1)) {
		for (const [cat, names] of pack.files) {
			if (!seen.has(cat)) seen.set(cat, new Set());
			for (const n of names) seen.get(cat).add(n);
		}
	}
	const changed = {};
	const introduced = {};
	for (const [cat, names] of [...newest.files].sort(([a], [b]) => a.localeCompare(b))) {
		changed[cat] = [...names].sort();
		const fresh = changed[cat].filter((n) => !(seen.get(cat) || new Set()).has(n));
		if (fresh.length) introduced[cat] = fresh;
	}
	return { pack: newest.dir, version: newest.version, changed, introduced };
}

function latestSnapshot(dir, exclude) {
	if (!fs.existsSync(dir)) return null;
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== exclude).sort((a, b) => compareVersions(a.replace(/\.json$/, '').replace(/-/g, '.'), b.replace(/\.json$/, '').replace(/-/g, '.')));
	return files.length ? JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')) : null;
}

function diff(a, b) {
	const sb = new Set(b);
	return a.filter((x) => !sb.has(x));
}

// The client's protocol number is not recoverable from its stripped binary, so it comes
// from Mojang's docs for the client's version. Null when offline or when Mojang has not
// published that version.
function clientProtocol(gameVersion, offline) {
	if (offline || !gameVersion) return null;
	const tag = docs.tagForVersion(docs.listTags(), gameVersion);
	if (!tag) return null;
	return { tag: tag.tag, protocol: docs.loadDocs(docs.checkout(tag.tag)).protocol };
}

function verdict(ours, client) {
	if (!client.game_version) return 'UNKNOWN: could not read the client version';
	if (client.protocol) {
		if (client.protocol.protocol === ours.protocol) {
			return compareVersions(ours.version, client.game_version) === 0
				? 'CURRENT: our packages speak the client\'s protocol and version'
				: `CURRENT PROTOCOL: both speak ${ours.protocol}, but the client is ${client.game_version} and our packages ${ours.version}; the boot test decides, since block and item data can still differ`;
		}
		return `BEHIND: the client speaks ${client.protocol.protocol} (${client.protocol.tag}), our packages ${ours.protocol}; run /protocol-update`;
	}
	return compareVersions(ours.version, client.game_version) >= 0
		? 'CURRENT BY VERSION: no Mojang docs reached, protocol unconfirmed'
		: 'BEHIND BY VERSION: no Mojang docs reached, protocol unconfirmed; run /docs-diff, then /protocol-update';
}

function scan(args) {
	const exe = path.join(args.client, 'Minecraft.Windows.exe');
	const config = fs.readFileSync(path.join(args.client, 'MicrosoftGame.Config'), 'utf8');
	const packageVersion = (/<Identity[^>]*\sVersion="([^"]+)"/.exec(config) || [])[1] || null;

	const buf = fs.readFileSync(exe);
	const sections = peSections(buf);
	const behaviorDelta = newestDelta(packInventory(path.join(args.client, 'data', 'behavior_packs')));
	const limitsFile = path.join(args.client, 'data', 'packetlimitconfig.json');
	const limits = fs.existsSync(limitsFile) ? JSON.parse(fs.readFileSync(limitsFile, 'utf8')) : { limitGroups: [] };
	const gameVersion = behaviorDelta ? behaviorDelta.version : null;
	const ours = pkg.readProtocolInfo(args.packagesSrc);
	const ourClasses = pkg.packetClasses(args.packagesSrc);
	const clientPackets = dropDecorated(packetNames(buf, sections), ourClasses);

	const snapshot = {
		scanned_at: new Date().toISOString(),
		client: {
			path: args.client,
			package_version: packageVersion,
			exe_file_version: fileVersion(buf, sections),
			exe_sha256: crypto.createHash('sha256').update(buf).digest('hex'),
			game_version: gameVersion,
			protocol: clientProtocol(gameVersion, args.offline),
		},
		packages: { protocol: ours.protocol, version: ours.version },
		core_pin: pkg.corePin(),
		packet_limit_ids: [...new Set(limits.limitGroups.flatMap((g) => g.minecraftPacketIds))].sort((a, b) => a - b),
		client_packet_names: clientPackets,
		not_in_packages: diffIgnoringCase(clientPackets, ourClasses),
		behavior_delta: behaviorDelta,
		resource_delta: newestDelta(packInventory(path.join(args.client, 'data', 'resource_packs'))),
	};
	snapshot.verdict = verdict(ours, snapshot.client);
	return snapshot;
}

function render(snapshot, previous) {
	const c = snapshot.client;
	const out = [];
	out.push('# Client scan');
	out.push('');
	out.push(`Client: Bedrock ${c.game_version}, package ${c.package_version}, exe ${c.exe_file_version}, protocol ${c.protocol ? `${c.protocol.protocol} (Mojang ${c.protocol.tag})` : 'unconfirmed'}`);
	out.push(`Our packages: ${snapshot.packages.version}, protocol ${snapshot.packages.protocol}`);
	const core = snapshot.core_pin;
	out.push(`pmmp-core checkout pins: ${core ? `${core.package_version} from ${core.source}` : 'no sibling pmmp-core checkout'}`);
	out.push(`Verdict: ${snapshot.verdict}`);
	if (core && core.version && compareVersions(core.version, snapshot.packages.version) !== 0) {
		out.push(`Core lags: the checked-out pmmp-core branch builds ${core.version}, not our packages' ${snapshot.packages.version}. Players get what pmmp-core builds.`);
	}
	out.push('');
	out.push(`## Client packet names with no class in our packages (${snapshot.not_in_packages.length})`);
	out.push('Mostly client internals and packets the protocol dropped. A name new since the previous snapshot is a packet our packages lack.');
	out.push(snapshot.not_in_packages.join(', ') || 'none');
	out.push('');
	if (previous) {
		out.push(`## Packet names since snapshot ${previous.client.game_version} (${previous.client.package_version})`);
		out.push(`Added: ${diff(snapshot.client_packet_names, previous.client_packet_names).join(', ') || 'none'}`);
		out.push(`Removed: ${diff(previous.client_packet_names, snapshot.client_packet_names).join(', ') || 'none'}`);
		out.push('');
	}
	out.push(`## Packet IDs in packetlimitconfig.json: ${snapshot.packet_limit_ids.join(', ') || 'none'}`);
	out.push('');
	for (const [label, delta] of [['Behavior', snapshot.behavior_delta], ['Resource', snapshot.resource_delta]]) {
		if (!delta) continue;
		out.push(`## ${label} pack ${delta.pack}: introduced in ${delta.version}`);
		const cats = Object.entries(delta.introduced);
		out.push(cats.length ? cats.map(([cat, n]) => `- ${cat}: ${n.join(', ')}`).join('\n') : 'nothing new');
		out.push(`Changed definitions: ${summariseCategories(delta.changed) || 'none'}`);
		if (delta.changed.entities) out.push(`Changed entities: ${delta.changed.entities.map((n) => n.replace(/\.json$/, '')).join(', ')}`);
		out.push('');
	}
	return out.join('\n');
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const snapshot = scan(args);
	const snapName = `${snapshot.client.game_version}-${snapshot.client.package_version}.json`;
	const previous = latestSnapshot(args.snapshots, snapName);
	let text = render(snapshot, previous);
	if (args.save) {
		fs.mkdirSync(args.snapshots, { recursive: true });
		fs.writeFileSync(path.join(args.snapshots, snapName), JSON.stringify(snapshot, null, '\t') + '\n');
		text += `\nSnapshot: ${path.relative(pkg.REPO, path.join(args.snapshots, snapName)).split(path.sep).join('/')}`;
	}
	process.stdout.write(text + '\n');
}

if (require.main === module) main();

module.exports = { peSections, fileVersion, packetNames, dropDecorated, readBrarchive, packInventory, newestDelta, verdict, scan, render, compareVersions, BRARCHIVE_MAGIC, VS_FIXEDFILEINFO_SIGNATURE };

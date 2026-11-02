#!/usr/bin/env node
'use strict';

// Compares two tags of Mojang's protocol docs and checks the newer one against our
// packages. With no arguments it compares the version our packages speak against the
// newest tag Mojang has published, preview or release.
//
// Usage: node tools/docs-diff/diff.js [--from <tag>] [--to <tag>] [--json]
//        node tools/docs-diff/diff.js --from-dir <dir> --to-dir <dir>   (fixtures, no network)

const docs = require('../lib/mojang-docs');
const pkg = require('../lib/packages');

function parseArgs(argv) {
	const a = { json: false };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--json') a.json = true;
		else if (['--from', '--to', '--from-dir', '--to-dir', '--packages-src'].includes(k)) a[k.slice(2).replace('-', '_')] = argv[++i];
		else throw new Error(`unknown argument ${k}`);
	}
	return a;
}

function againstPackages(diff, toDocs, src) {
	const info = pkg.readProtocolInfo(src);
	const classes = new Set(pkg.packetClasses(src));
	const missing = [];
	const idMismatch = [];
	for (const [name, p] of toDocs.packets) {
		if (!classes.has(name)) missing.push({ name, id: p.id });
		const ours = info.ids.get(pkg.constantStem(name));
		if (ours !== undefined && ours !== p.id) idMismatch.push({ name, ours, mojang: p.id });
	}
	return {
		protocol: info.protocol,
		version: info.version,
		protocol_matches: info.protocol === diff.protocol.to,
		missing_classes: missing.sort((a, b) => a.name.localeCompare(b.name)),
		id_mismatch: idMismatch.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function render(r) {
	const d = r.diff;
	const list = (xs, f) => (xs.length ? xs.map(f).join('\n') : 'none');
	const out = [];
	out.push(`# Mojang docs diff: ${r.from} to ${r.to}`);
	out.push('');
	out.push(`Protocol: ${d.protocol.from} to ${d.protocol.to}`);
	out.push(`Minecraft: ${d.minecraft_version.from} to ${d.minecraft_version.to}`);
	out.push('');
	out.push(`## Added packets (${d.packets.added.length})`);
	out.push(list(d.packets.added, (p) => `- ${p.name} (ID ${p.id})${p.details ? `: ${p.details}` : ''}`));
	out.push('');
	out.push(`## Removed packets (${d.packets.removed.length})`);
	out.push(list(d.packets.removed, (p) => `- ${p.name} (ID ${p.id})`));
	out.push('');
	out.push(`## Packet ID changes (${d.packets.id_changed.length})`);
	out.push(list(d.packets.id_changed, (p) => `- ${p.name}: ${p.from} to ${p.to}`));
	out.push('');
	out.push(`## Changed packets (${d.packets.changed.length})`);
	out.push(list(d.packets.changed, (p) => `- ${p.name} (ID ${p.id}) via ${p.types.join(', ')}`));
	out.push('');
	out.push(`## Types: ${d.types.added.length} added, ${d.types.removed.length} removed, ${d.types.changed.length} changed on the wire, ${d.types.enum_values_to_check.length} with enum values to check, ${d.types.annotation_only.length} changed in documentation only`);
	if (d.types.enum_values_to_check.length) out.push(`Enum values published for the first time or no longer published, not 0, 1, 2 in order. Check each against our code: ${d.types.enum_values_to_check.join(', ')}`);
	if (d.types.added.length) out.push(`Added: ${d.types.added.join(', ')}`);
	if (d.types.removed.length) out.push(`Removed: ${d.types.removed.join(', ')}`);
	if (d.types.changed.length) out.push(`Changed: ${d.types.changed.join(', ')}`);
	out.push('');
	out.push(`## Developer notes (${d.developer_notes.length})`);
	out.push(list(d.developer_notes, (n) => `- ${n.file}: ${n.text.replace(/\s+/g, ' ').slice(0, 300)}`));
	if (r.packages) {
		const p = r.packages;
		out.push('');
		out.push(`## Our packages: protocol ${p.protocol}, ${p.version}`);
		out.push(p.protocol_matches ? `Protocol matches ${r.to}.` : `Protocol differs: ours ${p.protocol}, ${r.to} is ${d.protocol.to}.`);
		out.push(`Packets with no class in packages/bedrock-protocol (${p.missing_classes.length}): ${p.missing_classes.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}`);
		out.push(`Packet IDs that differ from ProtocolInfo (${p.id_mismatch.length}): ${p.id_mismatch.map((x) => `${x.name} ours ${x.ours} Mojang ${x.mojang}`).join(', ') || 'none'}`);
	}
	return out.join('\n') + '\n';
}

function run(args) {
	let fromDir;
	let toDir;
	let from = args.from;
	let to = args.to;
	if (args.from_dir && args.to_dir) {
		fromDir = args.from_dir;
		toDir = args.to_dir;
		from = from || fromDir;
		to = to || toDir;
	} else {
		const tags = docs.listTags();
		if (!from) {
			const ours = pkg.readProtocolInfo(args.packages_src).version;
			const t = docs.tagForVersion(tags, ours);
			if (!t) throw new Error(`no Mojang docs tag for our packages' version ${ours}`);
			from = t.tag;
		}
		if (!to) to = tags[tags.length - 1].tag;
		fromDir = docs.checkout(from);
		toDir = docs.checkout(to);
	}
	const fromDocs = docs.loadDocs(fromDir);
	const toDocs = docs.loadDocs(toDir);
	const diff = docs.diffDocs(fromDocs, toDocs);
	const result = { from, to, diff, packages: againstPackages(diff, toDocs, args.packages_src) };
	return result;
}

if (require.main === module) {
	const args = parseArgs(process.argv.slice(2));
	const result = run(args);
	process.stdout.write(args.json ? JSON.stringify(result, null, '\t') + '\n' : render(result));
}

module.exports = { run, render, againstPackages, parseArgs };

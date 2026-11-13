#!/usr/bin/env node
'use strict';

// Compares the block states BDS's Script API resolves, logged by our pack script-pack in
// script-run.sh's container, with canonical_block_states.nbt by samples.js's comparator.
// The log stays in <cache>/script-states/<build>/states.log. Any difference is a MISMATCH
// and exits 1; the Script API gives no network ID, so no order it yields can MATCH.
//
// Usage: node tools/bds/script.js [--channel release|preview] [--links-file <json>]
//   [--cache <dir>] [--docker <command>] [--dry-run] [--from <states.log>] [--data-dir <dir>]
// Run it where docker is local, as inspect.js says.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const inspect = require('./inspect');
const record = require('./record');
const samples = require('./samples');
const pkg = require('../lib/packages');

const SECONDS = 300;
const ORDER = 'the Script API gives no network ID, so this order is chosen here: blocks by FNV-1 64 of the name, each block\'s states as the pack enumerates them';
const TYPES = { boolean: 'b', number: 'i', string: 's' };

function dockerArgs(build, cacheDir, outDir, user) {
	return [
		'run', '--rm', '--init', '--name', `riftal_smoke_bds_script_${process.pid}`,
		'--network', 'none', '-m', '2g', '--cpus', '2', '--user', user, '-e', 'HOME=/tmp',
		'-v', `${cacheDir}:/bds:ro`, '-v', `${path.join(cacheDir, 'node')}:/node:ro`, '-v', `${__dirname}:/tool:ro`, '-v', `${outDir}:/out`,
		inspect.IMAGE, 'bash', '/tool/script-run.sh', build.file, record.NODE.file, record.NODE.sha256,
	];
}

function stateOf(name, k, x) {
	const t = typeof x === 'number' && !Number.isInteger(x) ? undefined : TYPES[typeof x];
	if (!t) throw new Error(`${name} state ${k} is ${JSON.stringify(x)}, not a bool, an int or a string`);
	return [k, t, t === 'b' ? Number(x) : x];
}

// The pack's own count is checked against the lines read, so a line the log dropped is
// reported as lost, never read as a state BDS lacks.
function parseLog(text) {
	const out = { states: [], errors: [], done: null };
	for (const [, kind, json] of text.matchAll(/RIFTAL_(STATE|DONE|ERROR) (.*)$/gm)) {
		const v = JSON.parse(json);
		if (kind === 'DONE') out.done = v;
		else if (kind === 'ERROR') out.errors.push(`the pack failed: ${v}`);
		else out.states.push({ name: v.name, states: Object.entries(v.states).map(([k, x]) => stateOf(v.name, k, x)), fields: [] });
	}
	if (!out.done && !out.errors.length) throw new Error('the pack logged neither RIFTAL_DONE nor RIFTAL_ERROR');
	if (out.done && out.done.states !== out.states.length) out.errors.push(`the pack counted ${out.done.states} states, the log holds ${out.states.length}`);
	return out;
}

// Drops each state the Script API gives that ours does not carry on that block, such as
// `color` on a flattened block, and counts the permutations that merges. Only ours can say
// which states those are, so this explains a difference and never makes a MATCH.
function project(states, ours) {
	const [props, dropped] = [new Map(), new Map()];
	for (const s of ours) for (const [k] of s.states) (props.get(s.name) || props.set(s.name, new Set()).get(s.name)).add(k);
	const kept = states.map((s) => {
		const has = props.get(s.name) || new Set();
		for (const [k] of s.states) if (!has.has(k)) dropped.set(k, (dropped.get(k) || 0) + 1);
		return { ...s, states: s.states.filter(([k]) => has.has(k)) };
	});
	const merged = kept.length - new Set(kept.map(samples.stateKey)).size;
	return { states_dropped: [...dropped].map(([k, n]) => `${k} in ${n} states`), permutations_merged: merged ? [merged] : [], ...samples.compareStates(kept, ours, 'script') };
}

function compare(text, dataDir) {
	const log = parseLog(text);
	const hashed = log.states.map((s) => [samples.fnv1(s.name), s]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, s]) => s);
	const ours = samples.readStateList(fs.readFileSync(path.join(dataDir, 'canonical_block_states.nbt')));
	const blocks = { ...samples.compareStates(hashed, ours, 'script'), script_errors: log.errors, order_not_guaranteed: [ORDER] };
	const empty = ([, v]) => !Array.isArray(v) || !v.length;
	const content = Object.entries(blocks).filter(([k]) => k !== 'order_not_guaranteed').every(empty);
	return { match: Object.entries(blocks).every(empty), content, done: log.done, blocks, projected: project(hashed, ours) };
}

function render(r, header) {
	const list = (xs) => (xs.length > 20 ? `${xs.slice(0, 20).join(', ')} and ${xs.length - 20} more` : xs.join(', ') || 'none');
	const show = (v) => (Array.isArray(v) ? `(${v.length}) ${list(v)}` : Object.entries(v).map((e) => e.join(' ')).join(', '));
	const rows = (o) => Object.entries(o).map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${show(v)}`);
	return [header, `pack: ${r.done ? show(r.done) : 'did not finish'}`, 'blocks:', ...rows(r.blocks), `content ${r.content ? 'MATCH' : 'MISMATCH'}`,
		'without the states ours lacks, for explanation only:', ...rows(r.projected), r.match ? 'MATCH' : 'MISMATCH'].join('\n');
}

async function fetchInputs(build, cacheDir, log) {
	await inspect.download(build, cacheDir, log);
	await record.nodeTarball(cacheDir, log);
}

async function main(argv, log = (s) => process.stdout.write(`${s}\n`), { seconds = SECONDS, fetchAll = fetchInputs } = {}) {
	const take = (k) => {
		const i = argv.indexOf(k);
		if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) throw new Error(`${k} needs a value`);
		return i < 0 ? null : argv.splice(i, 2)[1];
	};
	argv = [...argv];
	let file = take('--from');
	const dataDir = take('--data-dir') || path.join(pkg.REPO, 'packages', 'bedrock-data');
	const a = inspect.parseArgs(argv);
	let source = `log ${file}`;
	if (!file) {
		const build = inspect.selectBuild(await inspect.readLinks(a), a.channel);
		const out = path.join(a.cache, 'script-states', build.build);
		const me = os.userInfo();
		const run = dockerArgs(build, a.cache, out, `${me.uid}:${me.gid}`);
		const args = ['--kill-after=10', String(seconds), a.docker, ...run];
		[file, source] = [path.join(out, 'states.log'), `BDS Linux ${build.channel} ${build.build}`];
		log(`${source}: ${build.url}`);
		if (a.dry_run) {
			log(`would write ${file}`);
			log(`would run timeout ${args.join(' ')}`);
			return 0;
		}
		await fetchAll(build, a.cache, log);
		fs.mkdirSync(out, { recursive: true });
		fs.rmSync(file, { force: true });
		const r = spawnSync('timeout', args, { stdio: 'inherit' });
		// A forced timeout can kill the docker CLI while the container runs on.
		spawnSync(a.docker, ['rm', '-f', run[run.indexOf('--name') + 1]], { stdio: 'ignore' });
		if (r.error) throw r.error;
		if (r.status !== 0) throw new Error(`the run exited ${r.status}`);
	}
	const r = compare(fs.readFileSync(file, 'utf8'), dataDir);
	const v = JSON.parse(fs.readFileSync(path.join(dataDir, 'protocol_info.json'), 'utf8')).version;
	log(render(r, `Script API of ${source} against packages/bedrock-data ${v.major}.${v.minor}.${v.patch}.${v.revision} (protocol ${v.protocol_version})`));
	return r.match ? 0 : 1;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`bds script: ${e.message}\n`);
		process.exitCode = 2;
	});
}

module.exports = { SECONDS, ORDER, dockerArgs, parseLog, compare, main };

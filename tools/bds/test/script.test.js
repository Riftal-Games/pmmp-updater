'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('../../test-support/fixtures');
const samples = require('../samples');
const script = require('../script');

const PACK = path.join(__dirname, '..', 'script-pack');
const RUN = fs.readFileSync(path.join(__dirname, '..', 'script-run.sh'), 'utf8');

// Invented blocks only, so nothing BDS wrote is committed. `color` stands for a state the
// Script API gives on a flattened block and resolves to another type unless it is red.
const VALUES = { lit: [false, true], power: [0, 1, 2], color: ['red', 'blue'] };
const DEFAULTS = { 'fixture:lamp': { lit: false, color: 'red' }, 'fixture:wire': { power: 0 } };
const API = {
	values: (n) => VALUES[n],
	resolve: (id, want = {}) => {
		const s = { ...DEFAULTS[id], ...want };
		if (id === 'fixture:wire' && s.power === 2) throw new Error('out of range');
		const states = id === 'fixture:wire' && s.power === 1 ? { power: 0 } : s;
		return { type: { id: s.color === 'blue' ? 'fixture:blue_lamp' : id }, getAllStates: () => states };
	},
};

test('the pack keeps only combinations BDS resolves back to the same type and states, first state fastest', async () => {
	const src = fs.readFileSync(path.join(PACK, 'scripts', 'permutations.js')).toString('base64');
	const { permutations } = await import(`data:text/javascript;base64,${src}`);
	assert.deepEqual([...permutations('fixture:lamp', API)], [{ lit: false, color: 'red' }, { lit: true, color: 'red' }, null, null]);
	assert.deepEqual([...permutations('fixture:wire', API)], [{ power: 0 }, null, null]);
	assert.throws(() => [...permutations('fixture:wire', { ...API, values: () => [] })], /no values/);
});

test('the pack declares one script module on an exact @minecraft/server version and imports nothing else', () => {
	const m = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'));
	assert.deepEqual(m.modules.map((x) => [x.type, x.entry]), [['script', 'scripts/main.js']]);
	assert.deepEqual(m.dependencies.map((d) => d.module_name), ['@minecraft/server']);
	assert.match(m.dependencies[0].version, /^\d+\.\d+\.\d+$/);
	assert.notEqual(m.header.uuid, m.modules[0].uuid);
	const imports = [...fs.readFileSync(path.join(PACK, 'scripts', 'main.js'), 'utf8').matchAll(/from '([^']+)'/g)].map((x) => x[1]);
	assert.deepEqual(imports, ['@minecraft/server', './permutations.js']);
});

test('the container has no network, no port, limits, a smoke name and read-only inputs', () => {
	const args = script.dockerArgs({ file: 'bedrock-server-9.8.7.6.zip' }, '/cache/bds', '/cache/bds/script-states/9.8.7.6', '1000:1000');
	assert.deepEqual(args.slice(0, 3), ['run', '--rm', '--init']);
	assert.match(args[args.indexOf('--name') + 1], /^riftal_smoke_bds_script_\d+$/);
	assert.match(args.join(' '), / --network none -m 2g --cpus 2 --user 1000:1000 /);
	assert.ok(!args.some((x) => /^(-p|--publish)(=|$)/.test(x)) && args.filter((x) => /^--net/.test(x)).length === 1);
	const mounts = args.filter((_, i) => args[i - 1] === '-v');
	assert.deepEqual(mounts.filter((m) => !m.endsWith(':ro')), ['/cache/bds/script-states/9.8.7.6:/out']);
	assert.match(args[args.indexOf('bash') - 1], /^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
	assert.deepEqual(args.slice(args.indexOf('bash') + 1, -2), ['/tool/script-run.sh', 'bedrock-server-9.8.7.6.zip']);
});

// canonical_block_states.nbt's layout. Every fixture length and int is under 64, so each
// varint, zigzag or not, is one byte.
const str = (s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
const tag = (t, k, p) => Buffer.concat([Buffer.from([t]), str(k), p]);
const nbtValue = ([k, t, v]) => tag({ b: 1, i: 3, s: 8 }[t], k, t === 's' ? str(v) : Buffer.from([t === 'i' ? 2 * v : v]));
const nbt = (list) => Buffer.concat(list.map((s) => Buffer.concat([Buffer.from([10]), str(''), tag(8, 'name', str(s.name)), tag(10, 'states', Buffer.concat([...s.states.map(nbtValue), Buffer.from([0])])), Buffer.from([0])])));

const byHash = (a, b) => (samples.fnv1(a.name) < samples.fnv1(b.name) ? -1 : samples.fnv1(a.name) > samples.fnv1(b.name) ? 1 : 0);
const OURS = [['lamp', 'lit', 'b', 0], ['lamp', 'lit', 'b', 1], ['wire', 'power', 'i', 0], ['wire', 'power', 'i', 1]]
	.map(([n, ...st]) => ({ name: `fixture:${n}`, states: [st] })).concat({ name: 'fixture:slab', states: [] }).sort(byHash);
const asLogged = (s, extra = {}) => ({ name: s.name, states: { ...Object.fromEntries(s.states.map(([k, t, v]) => [k, t === 'b' ? Boolean(v) : v])), ...extra } });
const logOf = (logged, count = logged.length) => [...logged.map((s) => `[2026-01-01 INFO] [Scripting] RIFTAL_STATE ${JSON.stringify(s)}`), `RIFTAL_DONE ${JSON.stringify({ types: 3, states: count, refused: 0 })}`].join('\n');

function tree(log) {
	const dir = fx.tempDir('bds-script');
	const version = { major: 1, minor: 2, patch: 3, revision: 4, protocol_version: 99 };
	fx.writeTree(dir, { 'data/canonical_block_states.nbt': nbt(OURS), 'data/protocol_info.json': { version }, 'states.log': log });
	return { log: path.join(dir, 'states.log'), data: path.join(dir, 'data') };
}

test('every mutated log is a content MISMATCH that names the difference', () => {
	const logged = OURS.map((s) => asLogged(s));
	const lamp = logged.filter((s) => s.name === 'fixture:lamp');
	const cases = [
		[logOf(logged.filter((s) => s.name !== 'fixture:wire' || s.states.power !== 1)), (r) => assert.deepEqual(r.blocks.states_only_ours, ['fixture:wire[power=i:1]'])],
		[logOf(logged.map((s) => (s === lamp[0] ? lamp[1] : s === lamp[1] ? lamp[0] : s))), (r) => assert.equal(r.blocks.order_differs.length, 1)],
		[logOf(logged, logged.length + 1), (r) => assert.deepEqual(r.blocks.script_errors, [`the pack counted ${logged.length + 1} states, the log holds ${logged.length}`])],
		[`${logOf(logged)}\nRIFTAL_ERROR "boom"`, (r) => assert.deepEqual(r.blocks.script_errors, ['the pack failed: boom'])],
		[logOf(logged.map((s) => (s.name === 'fixture:lamp' ? { ...s, states: { ...s.states, color: 'red' } } : s))), (r) => {
			assert.deepEqual(r.blocks.values_differ, ['fixture:lamp color: script only [s:"red"], ours only []']);
			assert.deepEqual([r.projected.states_dropped, r.projected.permutations_merged, r.projected.states_only_ours], [['color in 2 states'], [], []]);
		}],
		[logOf([...logged, { ...lamp[0], states: { ...lamp[0].states, color: 'blue' } }]), (r) => assert.deepEqual(r.projected.permutations_merged, [1])],
	];
	for (const [log, check] of cases) {
		const r = script.compare(log, tree('').data);
		assert.deepEqual([r.content, r.match], [false, false], log);
		check(r);
	}
	assert.throws(() => script.compare(logOf([{ name: 'fixture:wire', states: { power: 0.5 } }]), tree('').data), /not a bool, an int or a string/);
	assert.throws(() => script.parseLog('Server started.'), /neither RIFTAL_DONE nor RIFTAL_ERROR/);
});

test('a log that reproduces bedrock-data is content MATCH and still a MISMATCH, as the Script API guarantees no order; a dry run uses no network', async () => {
	const t = tree(logOf(OURS.map((s) => asLogged(s))));
	assert.deepEqual(script.compare(fs.readFileSync(t.log, 'utf8'), t.data).blocks.order_not_guaranteed, [script.ORDER]);
	const lines = [];
	assert.equal(await script.main(['--from', t.log, '--data-dir', t.data], (s) => lines.push(s)), 1);
	const out = lines.join('\n').split('\n');
	assert.equal(out[0], `Script API of log ${t.log} against packages/bedrock-data 1.2.3.4 (protocol 99)`);
	assert.deepEqual([out.includes('content MATCH'), out.at(-1)], [true, 'MISMATCH']);
	const dir = fx.tempDir('bds-script-dry');
	fx.writeTree(dir, { 'links.json': { result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-9.8.7.6.zip' }] } } });
	const dry = [];
	assert.equal(await script.main(['--links-file', path.join(dir, 'links.json'), '--cache', path.join(dir, 'c'), '--dry-run'], (s) => dry.push(s)), 0);
	assert.equal(dry[1], `would write ${path.join(dir, 'c', 'script-states', '9.8.7.6', 'states.log')}`);
	assert.match(dry[2], new RegExp(`^would run timeout --kill-after=10 ${script.SECONDS} docker run --rm --init .* --network none `));
});

test('script-run.sh starts BDS offline with content logging on and the pack in a fresh level', () => {
	assert.match(RUN, /^for kv in online-mode=false allow-list=false enable-lan-visibility=false level-name=riftal_states content-log-console-output-enabled=true; do$/m);
	assert.match(RUN, /cp -r \/tool\/script-pack behavior_packs\/riftal_states\n/);
	assert.match(RUN, /grep -a 'RIFTAL_' bds\.log >\/out\/states\.log/);
	if (process.platform !== 'win32') assert.equal(spawnSync('bash', ['-n', path.join(__dirname, '..', 'script-run.sh')]).status, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const inspect = require('../inspect');
const record = require('../record');

const LINKS = { result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-9.8.7.6.zip' }] } };
const BODY = Buffer.from('synthetic node tarball');
const PIN = { file: 'node-v0.0.0-linux-x64.tar.gz', url: 'https://nodejs.invalid/node-v0.0.0-linux-x64.tar.gz', sha256: crypto.createHash('sha256').update(BODY).digest('hex') };
const serve = (body) => async () => ({ ok: true, status: 200, arrayBuffer: async () => body });

test('the container is on its own smoke network only, with limits, a smoke name, read-only inputs and no port', () => {
	const args = record.dockerArgs({ file: 'bedrock-server-9.8.7.6.zip' }, '/cache/bds', '/cache/bds/captures/9.8.7.6', '1000:1000');
	const line = args.join(' ');
	assert.deepEqual(args.slice(0, 3), ['run', '--rm', '--init']);
	assert.match(args[args.indexOf('--name') + 1], /^riftal_smoke_bds_record_\d+$/);
	assert.match(line, new RegExp(`--network riftal_smoke_bds_net_${process.pid} -m 2g --cpus 2 --user 1000:1000`));
	assert.ok(!args.includes('-p') && !args.includes('--publish') && args.filter((x) => /^--net/.test(x)).length === 1);
	const mounts = args.filter((_, i) => args[i - 1] === '-v');
	assert.deepEqual(mounts.filter((m) => !m.endsWith(':ro')), ['/cache/bds/captures/9.8.7.6:/out']);
	assert.ok(mounts.includes('/cache/bds:/bds:ro'));
	assert.ok(mounts.some((m) => /^[/\\]cache[/\\]bds[/\\]node:\/node:ro$/.test(m)));
	assert.ok(mounts.some((m) => /^[/\\]cache[/\\]bds[/\\]npm:\/npm:ro$/.test(m)));
	assert.ok(mounts.some((m) => /packages[\\/]bedrock-data[\\/]protocol_info\.json:\/proto\/protocol_info\.json:ro$/.test(m)));
	assert.deepEqual(mounts.filter((m) => /^\/(usr|lib|bin|opt)\//.test(m)), [], 'nothing from the host system is mounted');
	assert.match(args[args.indexOf('bash') - 1], /^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
	assert.deepEqual(args.slice(-6), ['bash', '/tool/run.sh', 'bedrock-server-9.8.7.6.zip', record.NODE.file, record.NODE.sha256, 'nethernet']);
	assert.equal(record.dockerArgs({ file: 'b.zip' }, '/c', '/o', '1:1', 'raknet').at(-1), 'raknet');
});

test('the Node pin is an exact 22.x linux-x64 release from nodejs.org with a SHA-256', () => {
	const m = /^node-(v22\.\d+\.\d+)-linux-x64\.tar\.gz$/.exec(record.NODE.file);
	assert.ok(m, record.NODE.file);
	assert.equal(record.NODE.url, `https://nodejs.org/dist/${m[1]}/${record.NODE.file}`);
	assert.match(record.NODE.sha256, /^[0-9a-f]{64}$/);
});

test('a Node download is kept only when its SHA-256 matches the pin', async () => {
	const dir = fx.tempDir('bds-node');
	const dest = path.join(dir, 'node', PIN.file);
	await assert.rejects(record.nodeTarball(dir, () => {}, PIN, serve(Buffer.from('tampered'))), /sha256 [0-9a-f]{64}, expected/);
	assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
	assert.equal(await record.nodeTarball(dir, () => {}, PIN, serve(BODY)), dest);
	assert.deepEqual(fs.readFileSync(dest), BODY);
});

test('a cached Node tarball that no longer matches the pin is refused', async () => {
	const dir = fx.tempDir('bds-node');
	fx.writeTree(dir, { [`node/${PIN.file}`]: 'tampered' });
	await assert.rejects(record.nodeTarball(dir, () => {}, PIN, () => assert.fail('a cached file is not downloaded again')), /cached .* has sha256/);
});

test('a dry run names the capture path and runs docker under timeout', async () => {
	const dir = fx.tempDir('bds-record');
	fx.writeTree(dir, { 'links.json': LINKS });
	const lines = [];
	assert.equal(await record.main(['--links-file', path.join(dir, 'links.json'), '--cache', path.join(dir, 'cache'), '--dry-run'], (s) => lines.push(s)), 0);
	assert.equal(lines[1], `would write ${path.join(dir, 'cache', 'captures', '9.8.7.6', 'capture.bin')}`);
	assert.match(lines[2], new RegExp(`^would run timeout --kill-after=10 ${record.SECONDS} docker run --rm .* nethernet$`));
	const raknet = [];
	await record.main(['--transport', 'raknet', '--links-file', path.join(dir, 'links.json'), '--dry-run'], (s) => raknet.push(s));
	assert.match(raknet[2], / raknet$/);
	await assert.rejects(record.main(['--transport', 'quic', '--dry-run']), /nethernet or raknet/);
});

test('--build names the BDS version without reading the links, and --sha256 pins its zip', async () => {
	const dir = fx.tempDir('bds-record');
	const lines = [];
	assert.equal(await record.main(['--build', '1.26.63.1', '--cache', path.join(dir, 'cache'), '--dry-run'], (s) => lines.push(s)), 0);
	assert.equal(lines[0], 'BDS Linux release 1.26.63.1: https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip');
	assert.equal(lines[1], `would write ${path.join(dir, 'cache', 'captures', '1.26.63.1', 'capture.bin')}`);
	const pin = 'ab'.repeat(32);
	let fetched;
	const stop = async (b) => { fetched = b; throw new Error('fetched'); };
	await assert.rejects(record.main(['--channel', 'preview', '--build', '1.26.70.24', '--sha256', pin, '--cache', path.join(dir, 'cache')], () => {}, { fetchAll: stop }), /^Error: fetched$/);
	assert.deepEqual(fetched, { ...inspect.namedBuild('1.26.70.24', 'preview'), sha256: pin });
	await assert.rejects(record.main(['--build', '1.26.63.1', '--cache', path.join(dir, 'cache')], () => {}, { fetchAll: stop }), /^Error: fetched$/);
	assert.ok(!('sha256' in fetched));
	fx.writeTree(dir, { 'links.json': LINKS });
	for (const [argv, why] of [
		[['--build', '1.26.63.1', '--links-file', path.join(dir, 'links.json')], /--build and --links-file/],
		[['--build'], /--build needs a value/],
		[['--build', '--dry-run'], /--build needs a value/],
		[['--build', '1.26'], /four numbers/],
		[['--sha256', 'AB'.repeat(32)], /--sha256 must be 64 lowercase hex digits/],
	]) await assert.rejects(record.main([...argv, '--dry-run'], () => {}, { fetchAll: stop }), why, argv.join(' '));
});

// A stand-in docker that logs each call and answers as the test asks, so every path
// through the isolated network is driven without an engine.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const mode = JSON.parse(process.env.FAKE_DOCKER);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
const sub = args[0] === 'network' ? args[1] : args[0];
if (sub === 'ls') process.stdout.write(mode.ls.join('\\n'));
if (sub === 'create' && mode.create) { process.stderr.write('invalid option'); process.exit(1); }
if (sub === 'inspect') process.stdout.write(JSON.stringify([mode.inspect]));
if (sub === 'run' && mode.run === 'hang') setInterval(() => {}, 1000);
else if (sub === 'run') process.exit(mode.run);
`;
const NET = `riftal_smoke_bds_net_${process.pid}`;
const CONTAINER = `riftal_smoke_bds_record_${process.pid}`;
const ISOLATED = { Internal: true, EnableIPv6: false, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' }, IPAM: { Config: [{ Subnet: '172.23.0.0/16', Gateway: '' }] } };
const unix = { skip: process.platform === 'win32' && 'the fake docker is an executable script' };

async function fakeRun(mode) {
	const dir = fx.tempDir('bds-net');
	fx.writeTree(dir, { 'links.json': LINKS, docker: FAKE, calls: '' });
	fs.chmodSync(path.join(dir, 'docker'), 0o755);
	process.env.FAKE_DOCKER = JSON.stringify({ ls: [], inspect: ISOLATED, run: 0, ...mode });
	process.env.FAKE_DOCKER_LOG = path.join(dir, 'calls');
	const lines = [];
	const argv = ['--links-file', path.join(dir, 'links.json'), '--cache', path.join(dir, 'cache'), '--docker', path.join(dir, 'docker')];
	const status = await record.main(argv, (s) => lines.push(s), { seconds: 1, fetchAll: async () => {} });
	const calls = fs.readFileSync(process.env.FAKE_DOCKER_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	return { status, lines, calls, subs: calls.map((c) => (c[0] === 'network' ? `network ${c[1]}` : c[0])) };
}

const removedLast = (calls) => assert.deepEqual(calls.slice(-2), [['rm', '-f', CONTAINER], ['network', 'rm', NET]]);

test('the network is created internal, isolated and IPv4 only, checked, and holds exactly one container', unix, async () => {
	const { status, lines, calls, subs } = await fakeRun({});
	assert.equal(status, 0);
	assert.deepEqual(subs, ['network ls', 'network create', 'network inspect', 'run', 'rm', 'network rm']);
	assert.deepEqual(calls[1], ['network', 'create', '--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', NET]);
	assert.ok(!calls.flat().includes('--ipv6') && !subs.includes('network connect'));
	const run = calls[subs.indexOf('run')];
	assert.equal(run[run.indexOf('--network') + 1], NET);
	assert.ok(!run.some((x) => /^(-p|--publish|--network-alias|--alias)(=|$)/.test(x)));
	assert.ok(lines.some((l) => l.startsWith(`network ${NET} {"Internal":true,"EnableIPv6":false`)));
	removedLast(calls);
});

test('a network that fails any check, or an engine refusing the option, is removed and nothing runs', unix, async () => {
	const cases = [
		{ inspect: { ...ISOLATED, Internal: false } },
		{ inspect: { ...ISOLATED, EnableIPv6: true } },
		{ inspect: { ...ISOLATED, Options: {} } },
		{ inspect: { ...ISOLATED, IPAM: { Config: [{ Subnet: '172.23.0.0/16', Gateway: '172.23.0.1' }] } } },
		{ create: 'refused' },
	];
	for (const mode of cases) {
		const { status, calls, subs } = await fakeRun(mode);
		assert.equal(status, 1, JSON.stringify(mode));
		assert.ok(!subs.includes('run'), JSON.stringify(mode));
		assert.deepEqual(calls.at(-1), ['network', 'rm', NET]);
	}
});

test('the container and then the network are removed after a non-zero exit and after a timeout', unix, async () => {
	for (const [mode, code] of [[{ run: 3 }, 3], [{ run: 'hang' }, 124]]) {
		const { status, calls } = await fakeRun(mode);
		assert.equal(status, code);
		removedLast(calls);
	}
});

test('stranded networks are reported by name and never removed, and a taken name stops the run', unix, async () => {
	const strays = ['riftal_smoke_bds_net_1', 'riftal_smoke_bds_net_2'];
	const { lines, calls } = await fakeRun({ ls: [...strays, 'riftal_smoke_other'] });
	for (const s of strays) assert.ok(lines.includes(`stranded network ${s}, left in place`));
	assert.ok(!calls.some((c) => strays.includes(c.at(-1)) || c.includes('riftal_smoke_other')));
	const taken = await fakeRun({ ls: [NET] });
	assert.equal(taken.status, 1);
	assert.deepEqual(taken.subs, ['network ls']);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const inspect = require('../../bds/inspect');
const record = require('../../bds/record');
const ghidra = require('../analyze');

const GIB = 1024 ** 3;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pin = (file, body) => ({ file, url: `https://dist.invalid/${file}`, sha256: sha(body) });
const serve = (bodies) => async (url) => ({ ok: true, status: 200, arrayBuffer: async () => bodies[path.basename(url)] });
const roomy = () => ({ bavail: 64 * 1024 ** 2, bsize: 4096 });

test('the pins are an exact Temurin 21 Linux x64 JDK and the Ghidra 12.1.4 release zip, each with a SHA-256, and Node is record.js\'s', () => {
	const m = /^OpenJDK21U-jdk_x64_linux_hotspot_(21\.\d+\.\d+)_(\d+)\.tar\.gz$/.exec(ghidra.JDK.file);
	assert.ok(m, ghidra.JDK.file);
	assert.equal(ghidra.JDK.url, `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${m[1]}%2B${m[2]}/${ghidra.JDK.file}`);
	assert.match(ghidra.GHIDRA.file, /^ghidra_12\.1\.4_PUBLIC_\d{8}\.zip$/);
	assert.equal(ghidra.GHIDRA.url, `https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/${ghidra.GHIDRA.file}`);
	for (const p of [ghidra.JDK, ghidra.GHIDRA]) assert.match(p.sha256, /^[0-9a-f]{64}$/);
	assert.equal(ghidra.NODE, record.NODE);
});

test('the unpack container is capped, has no network or port, a smoke name, only staging writable, and no heap variable but GHIDRA_HEADLESS_MAXMEM, as the image has none', () => {
	const args = ghidra.unpackArgs('/c', '/c/ghidra/staging/7', '1000:1000');
	assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--init', '--pull', 'never']);
	assert.equal(args[args.indexOf('--name') + 1], `riftal_smoke_ghidra_unpack_${process.pid}`);
	assert.match(args.join(' '), /--network none -m 2g --cpus 2 --user 1000:1000 -e HOME=\/tmp -e GHIDRA_HEADLESS_MAXMEM=1400M -w \//);
	assert.doesNotMatch(`${args.join(' ')}\n${ghidra.dockerfile()}`, /(^|[^A-Z_])(GHIDRA_MAXMEM|GHIDRA_(HEADLESS_)?JAVA_OPTIONS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|MAXMEM)=/m);
	assert.ok(!args.some((x) => /^(-p|--publish|--privileged|--cap-add)(=|$)/.test(x)));
	const mounts = args.filter((_, i) => args[i - 1] === '-v');
	assert.deepEqual(mounts.filter((m) => !m.endsWith(':ro')), ['/c/ghidra/staging/7:/staging']);
	for (const re of [/^[/\\]c[/\\]ghidra[/\\]dist:\/dist:ro$/, /^[/\\]c[/\\]node:\/node:ro$/, /tools[/\\]bds:\/bdstool:ro$/, /tools[/\\]ghidra:\/tool:ro$/]) assert.ok(mounts.some((m) => re.test(m)), re);
	assert.equal(args[args.indexOf('bash') - 1], inspect.IMAGE);
	assert.deepEqual(args.slice(-7), ['/tool/unpack.sh', record.NODE.file, record.NODE.sha256, ghidra.JDK.file, ghidra.JDK.sha256, ghidra.GHIDRA.file, ghidra.GHIDRA.sha256]);
});

test('the image is built with no network from a Dockerfile FROM the pinned base holding only COPY and ENV', () => {
	const lines = ghidra.dockerfile().trim().split('\n');
	assert.equal(lines[0], `FROM ${inspect.IMAGE}`);
	assert.deepEqual(lines.slice(1).filter((l) => !/^(COPY|ENV) /.test(l)), []);
	assert.deepEqual(ghidra.buildArgs('/s', '/i.part'), ['build', '--network', 'none', '--iidfile', '/i.part', '-t', 'riftal_smoke_ghidra:12.1.4', '/s']);
});

test('headroom refuses under 4 GiB of free memory or under 8 GiB free on the cache\'s filesystem', () => {
	const disk = (gib) => () => ({ bavail: gib * GIB / 4096, bsize: 4096 });
	assert.deepEqual(ghidra.headroom('/c', 4 * GIB, disk(8)).problems, []);
	assert.match(ghidra.headroom('/c', 4 * GIB - 1, disk(8)).problems.join(), /memory free, under 4 GiB/);
	assert.match(ghidra.headroom('/c', 4 * GIB, disk(8 - 1 / 1024)).problems.join(), /filesystem, under 8 GiB/);
});

test('the JDK and Ghidra land in <cache>/ghidra/dist and Node in <cache>/node, each kept only on a matching hash', async () => {
	const dir = fx.tempDir('ghidra-dist');
	const bodies = { 'n.tar.gz': Buffer.from('n'), 'j.tar.gz': Buffer.from('j'), 'g.zip': Buffer.from('g') };
	const pins = { NODE: pin('n.tar.gz', bodies['n.tar.gz']), JDK: pin('j.tar.gz', bodies['j.tar.gz']), GHIDRA: pin('g.zip', bodies['g.zip']) };
	await assert.rejects(ghidra.fetchDist(dir, () => {}, serve({ ...bodies, 'g.zip': Buffer.from('tampered') }), pins), /g\.zip: sha256 [0-9a-f]{64}, expected/);
	assert.ok(!fs.existsSync(path.join(dir, 'ghidra', 'dist', 'g.zip')));
	await ghidra.fetchDist(dir, () => {}, serve(bodies), pins);
	for (const rel of ['node/n.tar.gz', 'ghidra/dist/j.tar.gz', 'ghidra/dist/g.zip']) assert.ok(fs.existsSync(path.join(dir, rel)), rel);
});

test('a dry run names both steps under timeout and the 3600 s limit', async () => {
	const lines = [];
	assert.equal(await ghidra.main(['--cache', fx.tempDir('ghidra-dry'), '--dry-run'], (s) => lines.push(s)), 0);
	assert.match(lines[0], /^would run timeout --kill-after=10 3600 docker run --rm .* \/tool\/unpack\.sh /);
	assert.match(lines[1], /^would run timeout --kill-after=10 3600 docker build --network none --iidfile .*image\.iid\.part -t riftal_smoke_ghidra:12\.1\.4 /);
});

// A stand-in docker that logs each call and answers as the test asks.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const mode = JSON.parse(process.env.FAKE_DOCKER);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image') process.exit(mode.images.includes(args[2]) ? 0 : 1);
if (args[0] === 'run') process.exit(mode.unpack);
if (args[0] === 'build') { fs.writeFileSync(args[args.indexOf('--iidfile') + 1], 'sha256:built'); process.exit(mode.build); }
`;
const unix = { skip: process.platform === 'win32' && 'the fake docker is an executable script' };
const CONTAINER = `riftal_smoke_ghidra_unpack_${process.pid}`;

async function fakeRun(mode, opts = {}) {
	const dir = fx.tempDir('ghidra-run');
	fx.writeTree(dir, { docker: FAKE, calls: '' });
	fs.chmodSync(path.join(dir, 'docker'), 0o755);
	process.env.FAKE_DOCKER = JSON.stringify({ images: [inspect.IMAGE], unpack: 0, build: 0, ...mode });
	process.env.FAKE_DOCKER_LOG = path.join(dir, 'calls');
	const lines = [];
	const cache = path.join(dir, 'cache');
	const status = await ghidra.main(['--cache', cache, '--docker', path.join(dir, 'docker')], (s) => lines.push(s), { seconds: 5, fetchAll: async () => {}, free: 8 * GIB, statfs: roomy, ...opts });
	const calls = fs.readFileSync(process.env.FAKE_DOCKER_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const left = fs.existsSync(path.join(cache, 'ghidra')) ? fs.readdirSync(path.join(cache, 'ghidra'), { recursive: true }) : [];
	return { status, lines, calls, subs: calls.map((c) => c[0]), left };
}

test('nothing runs when the pinned base is absent or headroom is short', unix, async () => {
	for (const [mode, opts, re] of [[{ images: [] }, {}, /is not present, and this tool pulls nothing/], [{}, { free: GIB }, /refused, 1\.0 GiB of memory free/]]) {
		const { status, lines, subs } = await fakeRun(mode, opts);
		assert.equal(status, 1);
		assert.deepEqual(subs, ['image']);
		assert.match(lines.at(-1), re);
	}
});

test('a failed unpack or build removes the container and staging and keeps no image ID', unix, async () => {
	for (const [mode, subs] of [[{ unpack: 2 }, ['image', 'run', 'rm']], [{ build: 1 }, ['image', 'run', 'build', 'rm']]]) {
		const r = await fakeRun(mode);
		assert.notEqual(r.status, 0);
		assert.deepEqual(r.subs, subs);
		assert.deepEqual(r.calls.at(-1), ['rm', '-f', CONTAINER]);
		assert.deepEqual(r.left, ['staging']);
	}
});

test('a good build keeps its image ID and removes the container and staging', unix, async () => {
	const r = await fakeRun({});
	assert.equal(r.status, 0);
	assert.deepEqual(r.subs, ['image', 'run', 'build', 'rm']);
	assert.deepEqual(r.calls.at(-1), ['rm', '-f', CONTAINER]);
	assert.deepEqual(r.left.sort(), ['image.iid', 'staging']);
	assert.match(r.lines.at(-1), /^image sha256:built, tagged riftal_smoke_ghidra:12\.1\.4$/);
});

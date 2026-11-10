'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const record = require('../record');

const LINKS = { result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-9.8.7.6.zip' }] } };
const BODY = Buffer.from('synthetic node tarball');
const PIN = { file: 'node-v0.0.0-linux-x64.tar.gz', url: 'https://nodejs.invalid/node-v0.0.0-linux-x64.tar.gz', sha256: crypto.createHash('sha256').update(BODY).digest('hex') };
const serve = (body) => async () => ({ ok: true, status: 200, arrayBuffer: async () => body });

test('the container has no network, limits, a smoke name, read-only inputs and no port', () => {
	const args = record.dockerArgs({ file: 'bedrock-server-9.8.7.6.zip' }, '/cache/bds', '/cache/bds/captures/9.8.7.6', '1000:1000');
	const line = args.join(' ');
	assert.deepEqual(args.slice(0, 3), ['run', '--rm', '--init']);
	assert.match(args[args.indexOf('--name') + 1], /^riftal_smoke_bds_record_\d+$/);
	assert.match(line, /--network none -m 2g --cpus 2 --user 1000:1000/);
	assert.ok(!args.includes('-p') && !args.includes('--publish') && !/--network (?!none)/.test(line));
	const mounts = args.filter((_, i) => args[i - 1] === '-v');
	assert.deepEqual(mounts.filter((m) => !m.endsWith(':ro')), ['/cache/bds/captures/9.8.7.6:/out']);
	assert.ok(mounts.includes('/cache/bds:/bds:ro'));
	assert.ok(mounts.some((m) => /^[/\\]cache[/\\]bds[/\\]node:\/node:ro$/.test(m)));
	assert.ok(mounts.some((m) => /packages[\\/]bedrock-data[\\/]protocol_info\.json:\/proto\/protocol_info\.json:ro$/.test(m)));
	assert.deepEqual(mounts.filter((m) => /^\/(usr|lib|bin|opt)\//.test(m)), [], 'nothing from the host system is mounted');
	assert.match(args[args.indexOf('bash') - 1], /^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
	assert.deepEqual(args.slice(-5), ['bash', '/tool/run.sh', 'bedrock-server-9.8.7.6.zip', record.NODE.file, record.NODE.sha256]);
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
	assert.match(lines[2], new RegExp(`^would run timeout --kill-after=10 ${record.SECONDS} docker run --rm `));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fx = require('../../test-support/fixtures');
const record = require('../record');

const LINKS = { result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-9.8.7.6.zip' }] } };

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
	assert.ok(mounts.some((m) => /packages[\\/]bedrock-data[\\/]protocol_info\.json:\/proto\/protocol_info\.json:ro$/.test(m)));
	assert.deepEqual(args.slice(-3), ['bash', '/tool/run.sh', 'bedrock-server-9.8.7.6.zip']);
});

test('a dry run names the capture path and runs docker under timeout', async () => {
	const dir = fx.tempDir('bds-record');
	fx.writeTree(dir, { 'links.json': LINKS });
	const lines = [];
	assert.equal(await record.main(['--links-file', path.join(dir, 'links.json'), '--cache', path.join(dir, 'cache'), '--dry-run'], (s) => lines.push(s)), 0);
	assert.equal(lines[1], `would write ${path.join(dir, 'cache', 'captures', '9.8.7.6', 'capture.bin')}`);
	assert.match(lines[2], new RegExp(`^would run timeout --kill-after=10 ${record.SECONDS} docker run --rm `));
});

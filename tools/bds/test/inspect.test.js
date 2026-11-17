'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const inspect = require('../inspect');

// The shape of Mojang's links response on 2026-11-03, Windows and Java entries included,
// so selection is shown to pick the Linux zip out of the full list.
const LINKS = {
	result: {
		links: [
			{ downloadType: 'serverBedrockWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.61.1.zip' },
			{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.61.1.zip' },
			{ downloadType: 'serverBedrockPreviewWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.70.22.zip' },
			{ downloadType: 'serverBedrockPreviewLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip' },
			{ downloadType: 'serverJar', downloadUrl: 'https://piston-data.mojang.com/v1/objects/0000/server.jar' },
		],
	},
};

const withLink = (type, url) => ({ result: { links: LINKS.result.links.map((l) => (l.downloadType === type ? { ...l, downloadUrl: url } : l)) } });

test('arguments default to the release channel and the cache outside the repository', () => {
	const a = inspect.parseArgs([]);
	assert.equal(a.channel, 'release');
	assert.equal(a.dry_run, false);
	assert.equal(path.basename(a.cache), 'bds');
	assert.ok(!path.resolve(a.cache).startsWith(path.resolve(__dirname, '..', '..', '..')));
});

test('arguments are parsed and bad ones refused', () => {
	assert.deepEqual(inspect.parseArgs(['--channel', 'preview', '--links-file', 'l.json', '--cache', '/c', '--dry-run']), { channel: 'preview', links_file: 'l.json', cache: '/c', docker: 'docker', dry_run: true });
	assert.throws(() => inspect.parseArgs(['--channel', 'beta']), /must be release or preview/);
	assert.throws(() => inspect.parseArgs(['--channel']), /needs a value/);
	assert.throws(() => inspect.parseArgs(['--cache', '--dry-run']), /needs a value/);
	assert.throws(() => inspect.parseArgs(['--verbose']), /unknown argument/);
});

test('the Linux zip is selected for each channel, never the Windows one', () => {
	assert.deepEqual(inspect.selectBuild(LINKS, 'release'), {
		channel: 'release',
		build: '1.26.61.1',
		url: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.61.1.zip',
		file: 'bedrock-server-1.26.61.1.zip',
	});
	assert.deepEqual(inspect.selectBuild(LINKS, 'preview'), {
		channel: 'preview',
		build: '1.26.70.22',
		url: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip',
		file: 'bedrock-server-1.26.70.22.zip',
	});
});

test('a links layout or URL it does not recognise fails instead of downloading', () => {
	assert.throws(() => inspect.selectBuild({ links: [] }, 'release'), /no result\.links/);
	assert.throws(() => inspect.selectBuild({ result: { links: LINKS.result.links.filter((l) => l.downloadType !== 'serverBedrockPreviewLinux') } }, 'preview'), /no serverBedrockPreviewLinux link/);
	assert.throws(() => inspect.selectBuild(withLink('serverBedrockLinux', 'https://example.com/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.61.1.zip'), 'release'), /not a minecraft\.net Linux BDS zip/);
	assert.throws(() => inspect.selectBuild(withLink('serverBedrockLinux', 'http://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.61.1.zip'), 'release'), /not a minecraft\.net Linux BDS zip/);
	assert.throws(() => inspect.selectBuild(withLink('serverBedrockLinux', 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.61.1.zip'), 'release'), /not a minecraft\.net Linux BDS zip/);
	assert.throws(() => inspect.selectBuild(withLink('serverBedrockLinux', 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/../evil/bedrock-server-1.26.61.1.zip'), 'release'), /not a minecraft\.net Linux BDS zip/);
	assert.throws(() => inspect.selectBuild(withLink('serverBedrockLinux', 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip'), 'release'), /points at a preview build/);
});

test('a build named by version gets the URL the links would give it, and only four numbers are accepted', () => {
	assert.deepEqual(inspect.namedBuild('1.26.63.1', 'release'), {
		channel: 'release',
		build: '1.26.63.1',
		url: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip',
		file: 'bedrock-server-1.26.63.1.zip',
	});
	assert.equal(inspect.namedBuild('1.26.70.24', 'preview').url, 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.24.zip');
	for (const bad of ['1.26.63', '1.26.63.1/../x', 'latest', '']) assert.throws(() => inspect.namedBuild(bad, 'release'), /four numbers/, bad);
});

const zip = (s) => Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.from(s)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const serveZip = (body) => async () => ({ ok: true, status: 200, headers: { get: () => String(body.length) }, arrayBuffer: async () => body });
const BUILD = { channel: 'release', build: '9.8.7.6', url: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-9.8.7.6.zip', file: 'bedrock-server-9.8.7.6.zip' };

test('a BDS zip is logged with its sha256, and with a pin any other zip is refused, downloaded or cached', async (t) => {
	t.mock.method(globalThis, 'fetch', () => assert.fail('a test never reaches minecraft.net'));
	const body = zip('synthetic server');
	const dir = fx.tempDir('bds-zip');
	const dest = path.join(dir, BUILD.file);
	const lines = [];
	await assert.rejects(inspect.download({ ...BUILD, sha256: sha(zip('other')) }, dir, () => {}, serveZip(body)), new RegExp(`sha256 ${sha(body)}, expected ${sha(zip('other'))}`));
	assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
	assert.equal(await inspect.download({ ...BUILD, sha256: sha(body) }, dir, (s) => lines.push(s), serveZip(body)), dest);
	assert.equal(lines.at(-1), `saved ${dest}, ${body.length} bytes, sha256 ${sha(body)}`);
	await inspect.download(BUILD, dir, (s) => lines.push(s), () => assert.fail('a cached zip is not downloaded again'));
	assert.equal(lines.at(-1), `cached ${dest}, sha256 ${sha(body)}`);
	fs.writeFileSync(dest, zip('tampered'));
	await assert.rejects(inspect.download({ ...BUILD, sha256: sha(body) }, dir, () => {}, () => assert.fail('not downloaded')), /sha256 [0-9a-f]{64}, expected/);
});

test('the container is the pinned ubuntu:24.04, limited, with both mounts read-only and no port', () => {
	const build = inspect.selectBuild(LINKS, 'release');
	const args = inspect.dockerArgs(build, '/cache/bds', '/repo/tools/bds');
	assert.match(inspect.IMAGE, /^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
	assert.ok(args.includes(inspect.IMAGE));
	assert.match(args.join(' '), /-m 2g --cpus 2/);
	assert.match(args[args.indexOf('--name') + 1], /^riftal_smoke_/);
	assert.ok(args.includes('/cache/bds:/bds:ro'));
	assert.ok(args.includes('/repo/tools/bds:/probe:ro'));
	assert.ok(!args.includes('-p') && !args.includes('--publish'));
	assert.deepEqual(args.slice(-3), ['bash', '/probe/probe.sh', 'bedrock-server-1.26.61.1.zip']);
});

test('a dry run against a links file reads no network and names the cache path and command', async () => {
	const dir = fx.tempDir('bds-inspect');
	fx.writeTree(dir, { 'links.json': LINKS });
	const lines = [];
	const code = await inspect.main(['--channel', 'preview', '--links-file', path.join(dir, 'links.json'), '--cache', path.join(dir, 'cache'), '--dry-run'], (s) => lines.push(s));
	assert.equal(code, 0);
	assert.equal(lines[0], 'BDS Linux preview 1.26.70.22: https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip');
	assert.equal(lines[1], `would cache ${path.join(dir, 'cache', 'bedrock-server-1.26.70.22.zip')}`);
	assert.match(lines[2], /^would run docker run --rm /);
});

#!/usr/bin/env node
'use strict';

// Downloads one Linux BDS zip into the cache and reports whether its bedrock_server
// carries symbols, by running probe.sh in a pinned ubuntu:24.04 container. Downloading
// BDS accepts Mojang's EULA, which Nasir accepted for protocol work on 2026-11-02
// (riftal-pm docs/decision-log.md); the zip stays in the cache and is never committed.
//
// Usage: node tools/bds/inspect.js [--channel release|preview] [--links-file <json>]
//   [--cache <dir>] [--docker <command>] [--dry-run]
//
// Run it where docker is local. For pmmp-updater#10's Stage 3 runs that is the BDS job in
// .github/workflows/bds.yml, whose runner's docker is its own sidecar.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const docs = require('../lib/mojang-docs');

const LINKS_URL = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const DOWNLOAD_TYPES = { release: 'serverBedrockLinux', preview: 'serverBedrockPreviewLinux' };
const IMAGE = 'ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac';
const ZIP_URL = /^https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-linux(?:-preview)?\/(bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip)$/;

function parseArgs(argv) {
	const a = { channel: 'release', links_file: null, cache: path.join(docs.cacheRoot(), 'bds'), docker: 'docker', dry_run: false };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--dry-run') a.dry_run = true;
		else if (['--channel', '--links-file', '--cache', '--docker'].includes(k)) {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
			a[k.slice(2).replace('-', '_')] = v;
		} else throw new Error(`unknown argument ${k}`);
	}
	if (!DOWNLOAD_TYPES[a.channel]) throw new Error(`--channel must be release or preview, not ${a.channel}`);
	return a;
}

// Only a minecraft.net Linux BDS zip is accepted, so a changed layout or an unexpected
// host fails here rather than downloading something else into the cache.
function selectBuild(json, channel) {
	const links = json && json.result && json.result.links;
	if (!Array.isArray(links)) throw new Error('BDS links: no result.links array');
	const type = DOWNLOAD_TYPES[channel];
	const link = links.find((l) => l && l.downloadType === type);
	if (!link) throw new Error(`BDS links: no ${type} link`);
	const m = ZIP_URL.exec(String(link.downloadUrl));
	if (!m) throw new Error(`BDS links: ${type} URL is not a minecraft.net Linux BDS zip: ${link.downloadUrl}`);
	if (channel === 'release' && link.downloadUrl.includes('-preview/')) throw new Error(`BDS links: ${type} points at a preview build`);
	return { channel, build: m[2], url: link.downloadUrl, file: m[1] };
}

// A build the links no longer offer, such as the control's, at the URL they gave it,
// checked as one they give now.
function namedBuild(version, channel) {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`--build must be four numbers, not ${version}`);
	const url = `https://www.minecraft.net/bedrockdedicatedserver/bin-linux${channel === 'preview' ? '-preview' : ''}/bedrock-server-${version}.zip`;
	return selectBuild({ result: { links: [{ downloadType: DOWNLOAD_TYPES[channel], downloadUrl: url }] } }, channel);
}

// Mojang publishes no hash for a BDS zip. Every run logs the one it used, and a build
// carrying a sha256 refuses any other.
function zipSha256(build, body) {
	const got = crypto.createHash('sha256').update(body).digest('hex');
	if (build.sha256 && got !== build.sha256) throw new Error(`BDS ${build.file}: sha256 ${got}, expected ${build.sha256}`);
	return got;
}

function dockerArgs(build, cacheDir, probeDir) {
	return [
		'run', '--rm', '--name', `riftal_smoke_bds_inspect_${process.pid}`,
		'-m', '2g', '--cpus', '2',
		'-v', `${cacheDir}:/bds:ro`,
		'-v', `${probeDir}:/probe:ro`,
		IMAGE, 'bash', '/probe/probe.sh', build.file,
	];
}

async function readLinks(a) {
	if (a.links_file) return JSON.parse(fs.readFileSync(a.links_file, 'utf8'));
	const res = await fetch(LINKS_URL, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`BDS links: HTTP ${res.status}`);
	return res.json();
}

// Writes to a .part file and renames only once the whole body arrived and starts with a
// zip header, so an interrupted download is never mistaken for a cached build.
async function download(build, cacheDir, log, get = fetch) {
	const dest = path.join(cacheDir, build.file);
	if (fs.existsSync(dest)) {
		log(`cached ${dest}, sha256 ${zipSha256(build, fs.readFileSync(dest))}`);
		return dest;
	}
	fs.mkdirSync(cacheDir, { recursive: true });
	log(`downloading ${build.url}`);
	const res = await get(build.url, { signal: AbortSignal.timeout(600000) });
	if (!res.ok) throw new Error(`BDS download: HTTP ${res.status}`);
	const body = Buffer.from(await res.arrayBuffer());
	const expected = Number(res.headers.get('content-length'));
	if (expected && body.length !== expected) throw new Error(`BDS download: ${body.length} bytes, expected ${expected}`);
	if (body.subarray(0, 4).toString('binary') !== 'PK\x03\x04') throw new Error('BDS download: not a zip');
	const sha256 = zipSha256(build, body);
	fs.writeFileSync(`${dest}.part`, body);
	fs.renameSync(`${dest}.part`, dest);
	log(`saved ${dest}, ${body.length} bytes, sha256 ${sha256}`);
	return dest;
}

async function main(argv, log = (s) => process.stdout.write(`${s}\n`)) {
	const a = parseArgs(argv);
	const build = selectBuild(await readLinks(a), a.channel);
	const args = dockerArgs(build, a.cache, __dirname);
	log(`BDS Linux ${build.channel} ${build.build}: ${build.url}`);
	if (a.dry_run) {
		log(`would cache ${path.join(a.cache, build.file)}`);
		log(`would run ${a.docker} ${args.join(' ')}`);
		return 0;
	}
	await download(build, a.cache, log);
	const r = spawnSync(a.docker, args, { stdio: 'inherit' });
	if (r.error) throw r.error;
	return r.status;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`bds inspect: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { LINKS_URL, IMAGE, DOWNLOAD_TYPES, parseArgs, selectBuild, namedBuild, readLinks, download, dockerArgs, main };

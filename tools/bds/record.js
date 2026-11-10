#!/usr/bin/env node
'use strict';

// Records one client session against a Linux BDS. Downloads the build into the cache as
// inspect.js does, then runs run.sh in the pinned ubuntu:24.04 container with no network
// but loopback and no published port: BDS from the read-only cache mount, tracer.js
// joining it on 127.0.0.1, the capture written to <cache>/captures/<build>/capture.bin.
//
// Usage: node tools/bds/record.js [--channel release|preview] [--links-file <json>]
//   [--cache <dir>] [--docker <command>] [--dry-run]
//
// Run it where docker is local, as inspect.js says.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const inspect = require('./inspect');
const pkg = require('../lib/packages');

const SECONDS = 360;
const PROTOCOL_INFO = path.join(pkg.REPO, 'packages', 'bedrock-data', 'protocol_info.json');
// ubuntu:24.04 has no Node, so the container runs this official release on its own loader
// and libraries. The hash is the one nodejs.org publishes in the release's signed
// SHASUMS256.txt.asc; run.sh checks it again before unpacking.
const NODE = {
	file: 'node-v22.23.4-linux-x64.tar.gz',
	url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.gz',
	sha256: 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
};

function sha256(body) {
	return crypto.createHash('sha256').update(body).digest('hex');
}

// The cached tarball is checked on every run, and a download is renamed into place only
// once its hash matches, so the container never sees a Node that is not the pinned one.
async function nodeTarball(cacheDir, log, pin = NODE, get = fetch) {
	const dest = path.join(cacheDir, 'node', pin.file);
	if (fs.existsSync(dest)) {
		const got = sha256(fs.readFileSync(dest));
		if (got !== pin.sha256) throw new Error(`cached ${dest} has sha256 ${got}, expected ${pin.sha256}`);
		log(`cached ${dest}`);
		return dest;
	}
	log(`downloading ${pin.url}`);
	const res = await get(pin.url, { signal: AbortSignal.timeout(300000) });
	if (!res.ok) throw new Error(`Node download: HTTP ${res.status}`);
	const body = Buffer.from(await res.arrayBuffer());
	const got = sha256(body);
	if (got !== pin.sha256) throw new Error(`Node download: sha256 ${got}, expected ${pin.sha256}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(`${dest}.part`, body);
	fs.renameSync(`${dest}.part`, dest);
	log(`saved ${dest}, sha256 ${got}`);
	return dest;
}

function dockerArgs(build, cacheDir, outDir, user) {
	return [
		'run', '--rm', '--init', '--name', `riftal_smoke_bds_record_${process.pid}`,
		'--network', 'none', '-m', '2g', '--cpus', '2', '--user', user, '-e', 'HOME=/tmp',
		'-v', `${cacheDir}:/bds:ro`,
		'-v', `${path.join(cacheDir, 'node')}:/node:ro`,
		'-v', `${__dirname}:/tool:ro`,
		'-v', `${PROTOCOL_INFO}:/proto/protocol_info.json:ro`,
		'-v', `${outDir}:/out`,
		inspect.IMAGE, 'bash', '/tool/run.sh', build.file, NODE.file, NODE.sha256,
	];
}

async function main(argv, log = (s) => process.stdout.write(`${s}\n`)) {
	const a = inspect.parseArgs(argv);
	const build = inspect.selectBuild(await inspect.readLinks(a), a.channel);
	const out = path.join(a.cache, 'captures', build.build);
	const me = os.userInfo();
	const args = ['--kill-after=10', String(SECONDS), a.docker, ...dockerArgs(build, a.cache, out, `${me.uid}:${me.gid}`)];
	log(`BDS Linux ${build.channel} ${build.build}: ${build.url}`);
	if (a.dry_run) {
		log(`would write ${path.join(out, 'capture.bin')}`);
		log(`would run timeout ${args.join(' ')}`);
		return 0;
	}
	await inspect.download(build, a.cache, log);
	await nodeTarball(a.cache, log);
	const capture = path.join(out, 'capture.bin');
	fs.mkdirSync(out, { recursive: true });
	// A capture left by an earlier run would otherwise be reported as this run's.
	fs.rmSync(capture, { force: true });
	const r = spawnSync('timeout', args, { stdio: 'inherit' });
	if (r.error) throw r.error;
	log(`exit ${r.status}, ${fs.existsSync(capture) ? `capture ${capture}` : 'no capture'}`);
	return r.status;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`bds record: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { SECONDS, NODE, nodeTarball, dockerArgs, main };

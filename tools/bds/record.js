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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const inspect = require('./inspect');
const pkg = require('../lib/packages');

const SECONDS = 360;
const PROTOCOL_INFO = path.join(pkg.REPO, 'packages', 'bedrock-data', 'protocol_info.json');
// The tracer runs on the host's own Node 22, which ubuntu:24.04 lacks. The distro's node
// is Debian-packaged, with libnode and its externalised builtins outside the binary, so
// all of them are mounted and loaded by the host's dynamic loader, not the container's.
const HOST_MOUNTS = { '/usr/bin/node': '/opt/host/node', '/usr/bin/unzip': '/opt/host/unzip', '/usr/lib/x86_64-linux-gnu': '/opt/host/lib', '/usr/share/nodejs': '/usr/share/nodejs' };

function dockerArgs(build, cacheDir, outDir, user) {
	return [
		'run', '--rm', '--init', '--name', `riftal_smoke_bds_record_${process.pid}`,
		'--network', 'none', '-m', '2g', '--cpus', '2', '--user', user, '-e', 'HOME=/tmp',
		'-v', `${cacheDir}:/bds:ro`,
		'-v', `${__dirname}:/tool:ro`,
		'-v', `${PROTOCOL_INFO}:/proto/protocol_info.json:ro`,
		...Object.entries(HOST_MOUNTS).flatMap(([from, to]) => ['-v', `${from}:${to}:ro`]),
		'-v', `${outDir}:/out`,
		inspect.IMAGE, 'bash', '/tool/run.sh', build.file,
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
	fs.mkdirSync(out, { recursive: true });
	const r = spawnSync('timeout', args, { stdio: 'inherit' });
	if (r.error) throw r.error;
	if (r.status === 0) log(`capture ${path.join(out, 'capture.bin')}`);
	return r.status;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`bds record: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { SECONDS, HOST_MOUNTS, dockerArgs, main };

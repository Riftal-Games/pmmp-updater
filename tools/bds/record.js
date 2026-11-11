#!/usr/bin/env node
'use strict';

// Records one client session against a Linux BDS. Downloads the build into the cache as
// inspect.js does, then runs run.sh in the pinned ubuntu:24.04 container, alone on an
// internal network in isolated gateway mode and with no published port: BDS from the
// read-only cache mount, tracer.js beside it in the same container, the capture written
// to <cache>/captures/<build>/capture.bin.
//
// Usage: node tools/bds/record.js [--channel release|preview] [--links-file <json>]
//   [--cache <dir>] [--docker <command>] [--dry-run]
//
// Run it where docker is local, as inspect.js says.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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
const NET_PREFIX = 'riftal_smoke_bds_net_';
const ISOLATED = 'com.docker.network.bridge.gateway_mode_ipv4';

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
		'--network', `${NET_PREFIX}${process.pid}`, '-m', '2g', '--cpus', '2', '--user', user, '-e', 'HOME=/tmp',
		'-v', `${cacheDir}:/bds:ro`,
		'-v', `${path.join(cacheDir, 'node')}:/node:ro`,
		'-v', `${__dirname}:/tool:ro`,
		'-v', `${PROTOCOL_INFO}:/proto/protocol_info.json:ro`,
		'-v', `${outDir}:/out`,
		inspect.IMAGE, 'bash', '/tool/run.sh', build.file, NODE.file, NODE.sha256,
	];
}

const networkCreateArgs = (name) => ['network', 'create', '--internal', '-o', `${ISOLATED}=isolated`, name];

function networkProblems(n) {
	const out = [];
	if (n.Internal !== true) out.push(`Internal ${n.Internal}`);
	if (n.EnableIPv6 !== false) out.push(`EnableIPv6 ${n.EnableIPv6}`);
	if ((n.Options || {})[ISOLATED] !== 'isolated') out.push(`${ISOLATED} ${(n.Options || {})[ISOLATED]}`);
	const gateways = ((n.IPAM || {}).Config || []).map((c) => c.Gateway).filter(Boolean);
	if (gateways.length) out.push(`IPAM Gateway ${gateways.join(',')}`);
	return out;
}

function docker(cmd, args) {
	const r = spawnSync(cmd, args, { encoding: 'utf8' });
	if (r.error) throw r.error;
	return r;
}

// Held for the network's whole life, so a signal at any point still reaches the removal
// below. The run is spawned, not spawnSync'd, so a signal is handled while it runs.
function trapSignals() {
	const trap = { signals: [], child: null };
	const stop = (s) => {
		trap.signals.push(s);
		if (trap.child) trap.child.kill('SIGTERM');
	};
	const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
	names.forEach((s) => process.on(s, stop));
	trap.release = () => names.forEach((s) => process.off(s, stop));
	return trap;
}

function timed(args, trap) {
	if (trap.signals.length) return Promise.resolve(1);
	return new Promise((resolve, reject) => {
		trap.child = spawn('timeout', args, { stdio: 'inherit' });
		trap.child.on('error', reject);
		trap.child.on('exit', (code) => resolve(code === null ? 1 : code));
	});
}

// The container is removed by name before the network on every path, because a forced
// timeout can kill the docker CLI while the container runs on, and a network with an
// endpoint attached cannot be removed. A stray from another run is never removed here.
async function onIsolatedNetwork(cmd, name, container, log, start) {
	const ls = docker(cmd, ['network', 'ls', '--filter', `name=${NET_PREFIX}`, '--format', '{{.Name}}']);
	const strays = ls.stdout.split('\n').filter((n) => n.startsWith(NET_PREFIX));
	for (const n of strays) log(`stranded network ${n}, left in place`);
	if (ls.status !== 0 || strays.includes(name)) {
		log(`bds record: cannot claim network ${name}`);
		return 1;
	}
	try {
		const made = docker(cmd, networkCreateArgs(name));
		if (made.status !== 0) throw new Error(`network create refused: ${made.stderr.trim()}`);
		const n = JSON.parse(docker(cmd, ['network', 'inspect', name]).stdout)[0] || {};
		const bad = networkProblems(n);
		if (bad.length) throw new Error(`network ${name} is not isolated: ${bad.join('; ')}`);
		log(`network ${name} ${JSON.stringify({ Internal: n.Internal, EnableIPv6: n.EnableIPv6, Options: n.Options, IPAM: n.IPAM && n.IPAM.Config })}`);
		return await start();
	} catch (e) {
		log(`bds record: ${e.message}`);
		return 1;
	} finally {
		docker(cmd, ['rm', '-f', container]);
		const rm = docker(cmd, ['network', 'rm', name]);
		if (rm.status !== 0) log(`network ${name} not removed: ${rm.stderr.trim()}`);
	}
}

async function fetchInputs(build, cacheDir, log) {
	await inspect.download(build, cacheDir, log);
	await nodeTarball(cacheDir, log);
}

async function main(argv, log = (s) => process.stdout.write(`${s}\n`), { seconds = SECONDS, fetchAll = fetchInputs } = {}) {
	const a = inspect.parseArgs(argv);
	const build = inspect.selectBuild(await inspect.readLinks(a), a.channel);
	const out = path.join(a.cache, 'captures', build.build);
	const me = os.userInfo();
	const run = dockerArgs(build, a.cache, out, `${me.uid}:${me.gid}`);
	const [container, net] = ['--name', '--network'].map((k) => run[run.indexOf(k) + 1]);
	const args = ['--kill-after=10', String(seconds), a.docker, ...run];
	log(`BDS Linux ${build.channel} ${build.build}: ${build.url}`);
	if (a.dry_run) {
		log(`would write ${path.join(out, 'capture.bin')}`);
		log(`would run timeout ${args.join(' ')}`);
		return 0;
	}
	await fetchAll(build, a.cache, log);
	const capture = path.join(out, 'capture.bin');
	fs.mkdirSync(out, { recursive: true });
	// A capture left by an earlier run would otherwise be reported as this run's.
	fs.rmSync(capture, { force: true });
	const trap = trapSignals();
	let status;
	try {
		status = await onIsolatedNetwork(a.docker, net, container, log, () => timed(args, trap));
	} finally {
		trap.release();
	}
	log(`exit ${status}, ${fs.existsSync(capture) ? `capture ${capture}` : 'no capture'}`);
	if (trap.signals.length) process.kill(process.pid, trap.signals[0]);
	return status;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`bds record: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { SECONDS, NODE, nodeTarball, dockerArgs, main };

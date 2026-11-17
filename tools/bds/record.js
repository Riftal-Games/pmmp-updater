#!/usr/bin/env node
'use strict';

// Records one client session against a Linux BDS. Downloads the build, the pinned Node and
// the locked packages into the cache, then runs run.sh in the pinned ubuntu:24.04
// container, alone on an internal network in isolated gateway mode and with no published
// port: BDS from the read-only cache mount, tracer.js beside it in the same container on
// the chosen transport, the capture written to <cache>/captures/<build>/capture.bin.
//
// Usage: node tools/bds/record.js [--channel release|preview] [--links-file <json> | --build <version>]
//   [--sha256 <hex>] [--cache <dir>] [--docker <command>] [--transport nethernet|raknet] [--dry-run]
// --build names a version in place of the one the links offer; --sha256 pins its zip.
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
const LOCK = require('./package-lock.json');
const LICENCES = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0'];
const NET_PREFIX = 'riftal_smoke_bds_net_';
const ISOLATED = 'com.docker.network.bridge.gateway_mode_ipv4';

// Root CLAUDE.md "The BDS job" admits BDS on the runners only for the 1.26.70 update's
// Stage 3 runs under pmmp-updater#10: the target on either channel, and on release the two
// builds the steward's ruling compares it with (issuecomment-6868986975), 1.26.60.6 for the
// old palette and 1.26.63.1 for item e's control. Any other build there pulls CI off the
// host, so it is refused before anything is fetched, whether named or read from the links.
const STAGE3 = { release: /^1\.26\.(?:70\.\d+|60\.6|63\.1)$/, preview: /^1\.26\.70\.\d+$/ };

function stage3Build(build) {
	const file = `bedrock-server-${build.build}.zip`;
	const ok = STAGE3[build.channel] && STAGE3[build.channel].test(String(build.build)) && build.file === file && String(build.url).endsWith(`/${file}`);
	if (!ok) throw new Error(`BDS ${JSON.stringify(build.build)} on ${build.channel} is not a Stage 3 build of #10: 1.26.70.<n>, or 1.26.60.6 or 1.26.63.1 on release`);
	return build;
}

const digest = (algo, body) => crypto.createHash(algo).update(body).digest('hex');

// The cached file is checked on every run, and a download is renamed into place only once
// its hash matches, so the container never sees a file that is not the pinned one.
async function pinnedFile(dest, url, algo, want, log, get) {
	if (fs.existsSync(dest)) {
		const got = digest(algo, fs.readFileSync(dest));
		if (got !== want) throw new Error(`cached ${dest} has ${algo} ${got}, expected ${want}`);
		log(`cached ${dest}`);
		return dest;
	}
	log(`downloading ${url}`);
	const res = await get(url, { signal: AbortSignal.timeout(300000) });
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	const body = Buffer.from(await res.arrayBuffer());
	const got = digest(algo, body);
	if (got !== want) throw new Error(`${url}: ${algo} ${got}, expected ${want}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(`${dest}.part`, body);
	fs.renameSync(`${dest}.part`, dest);
	log(`saved ${dest}, ${algo} ${got}`);
	return dest;
}

function nodeTarball(cacheDir, log, pin = NODE, get = fetch) {
	return pinnedFile(path.join(cacheDir, 'node', pin.file), pin.url, 'sha256', pin.sha256, log, get);
}

// Every way ADR 003 says a locked package may not reach the run.
function lockProblems(lock) {
	const out = lock.lockfileVersion === 3 ? [] : [`lockfileVersion ${lock.lockfileVersion}`];
	for (const [key, e] of Object.entries(lock.packages || {})) {
		if (!key) continue;
		if (!String(e.resolved).startsWith('https://registry.npmjs.org/')) out.push(`${key}: resolved ${e.resolved}`);
		if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity)) out.push(`${key}: no sha512 integrity`);
		if (e.hasInstallScript) out.push(`${key}: install script`);
		for (const f of ['os', 'cpu', 'optional']) if (f in e) out.push(`${key}: ${f}`);
		if (!LICENCES.includes(e.license)) out.push(`${key}: licence ${e.license}`);
	}
	return out;
}

// Each tarball is cached under the hex of its sha512, the name run.sh checks it by. None
// is required or unpacked here, so the dependency never runs on the host.
async function npmTarballs(cacheDir, log, lock = LOCK, get = fetch) {
	const bad = lockProblems(lock);
	if (bad.length) throw new Error(`package-lock.json: ${bad.join('; ')}`);
	for (const [key, e] of Object.entries(lock.packages)) {
		if (!key) continue;
		const hex = Buffer.from(e.integrity.slice(7), 'base64').toString('hex');
		await pinnedFile(path.join(cacheDir, 'npm', `${hex}.tgz`), e.resolved, 'sha512', hex, log, get);
	}
}

function dockerArgs(build, cacheDir, outDir, user, transport = 'nethernet') {
	return [
		'run', '--rm', '--init', '--name', `riftal_smoke_bds_record_${process.pid}`,
		'--network', `${NET_PREFIX}${process.pid}`, '-m', '2g', '--cpus', '2', '--user', user, '-e', 'HOME=/tmp',
		'-v', `${cacheDir}:/bds:ro`,
		'-v', `${path.join(cacheDir, 'node')}:/node:ro`,
		'-v', `${path.join(cacheDir, 'npm')}:/npm:ro`,
		'-v', `${__dirname}:/tool:ro`,
		'-v', `${PROTOCOL_INFO}:/proto/protocol_info.json:ro`,
		'-v', `${outDir}:/out`,
		inspect.IMAGE, 'bash', '/tool/run.sh', build.file, NODE.file, NODE.sha256, transport,
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
	await inspect.download(stage3Build(build), cacheDir, log);
	await nodeTarball(cacheDir, log);
	await npmTarballs(cacheDir, log);
}

async function main(argv, log = (s) => process.stdout.write(`${s}\n`), { seconds = SECONDS, fetchAll = fetchInputs } = {}) {
	const own = { transport: 'nethernet' };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (!['--transport', '--build', '--sha256'].includes(argv[i])) rest.push(argv[i]);
		else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
		else own[argv[i].slice(2)] = argv[++i];
	}
	if (!['nethernet', 'raknet'].includes(own.transport)) throw new Error('--transport must be nethernet or raknet');
	if ('sha256' in own && !/^[0-9a-f]{64}$/.test(own.sha256)) throw new Error('--sha256 must be 64 lowercase hex digits');
	const a = inspect.parseArgs(rest);
	if (own.build && a.links_file) throw new Error('--build and --links-file name the build twice');
	const build = stage3Build(own.build ? inspect.namedBuild(own.build, a.channel) : inspect.selectBuild(await inspect.readLinks(a), a.channel));
	if (own.sha256) build.sha256 = own.sha256;
	const out = path.join(a.cache, 'captures', build.build);
	const me = os.userInfo();
	const run = dockerArgs(build, a.cache, out, `${me.uid}:${me.gid}`, own.transport);
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

module.exports = { SECONDS, NODE, stage3Build, pinnedFile, nodeTarball, lockProblems, npmTarballs, dockerArgs, trapSignals, timed, fetchInputs, main };

#!/usr/bin/env node
'use strict';

// Builds ADR 004's Ghidra image: fetches the pinned JDK, Ghidra and Node into the cache,
// hash-checked, unpacks them with unpack.sh in a throwaway container with no network, and
// builds an image FROM inspect.IMAGE that only copies that tree. Nothing pulls.
// Usage, where docker is local as tools/bds/inspect.js says:
//   node tools/ghidra/analyze.js [--cache <dir>] [--docker <command>] [--dry-run]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const inspect = require('../bds/inspect');
const record = require('../bds/record');

const BDSTOOL = path.join(__dirname, '..', 'bds');
// Eclipse Temurin, which Ghidra's install guide names, and a JDK because Ghidra compiles
// Java scripts at run time. The hash is Adoptium's published .sha256.txt for this asset.
const JDK = {
	file: 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz',
	url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz',
	sha256: 'd7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c',
};
// The hash is the one the release's notes publish.
const GHIDRA = {
	file: 'ghidra_12.1.4_PUBLIC_20260921.zip',
	url: 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip',
	sha256: 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db',
};
const NODE = record.NODE;
const TAG = 'riftal_smoke_ghidra:12.1.4';
const SECONDS = 3600;
const GIB = 1024 ** 3;
// The free-memory floor riftal-pm devtools/container-limits.js holds, and room on disk
// for the unpacked tree, a project and its staging copy, beside the CI runners.
const MIN_FREE = 4 * GIB;
const MIN_DISK = 8 * GIB;

// The PC's cap for a build, no network and no port, on every container this tool starts.
function runArgs(step, user) {
	return [
		'run', '--rm', '--init', '--pull', 'never', '--name', `riftal_smoke_ghidra_${step}_${process.pid}`,
		'--network', 'none', '-m', '2g', '--cpus', '2', '--user', user, '-e', 'HOME=/tmp', '-e', 'MAXMEM=1400M',
	];
}

function unpackArgs(cacheDir, staging, user) {
	return [
		...runArgs('unpack', user), '-w', '/',
		'-v', `${path.join(cacheDir, 'ghidra', 'dist')}:/dist:ro`,
		'-v', `${path.join(cacheDir, 'node')}:/node:ro`,
		'-v', `${BDSTOOL}:/bdstool:ro`,
		'-v', `${__dirname}:/tool:ro`,
		'-v', `${staging}:/staging`,
		inspect.IMAGE, 'bash', '/tool/unpack.sh', NODE.file, NODE.sha256, JDK.file, JDK.sha256, GHIDRA.file, GHIDRA.sha256,
	];
}

// Only COPY and ENV, so no build step runs code and none needs a limit.
const dockerfile = () => `FROM ${inspect.IMAGE}
COPY node /opt/node
COPY jdk /opt/jdk
COPY ghidra /opt/ghidra
ENV JAVA_HOME=/opt/jdk PATH=/opt/node/bin:/opt/jdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
`;

const buildArgs = (staging, iidfile) => ['build', '--network', 'none', '--iidfile', iidfile, '-t', TAG, staging];

function headroom(cacheDir, free = os.freemem(), statfs = fs.statfsSync) {
	const s = statfs(cacheDir);
	const disk = s.bavail * s.bsize;
	const problems = [];
	if (free < MIN_FREE) problems.push(`${(free / GIB).toFixed(1)} GiB of memory free, under 4 GiB`);
	if (disk < MIN_DISK) problems.push(`${(disk / GIB).toFixed(1)} GiB free on the cache's filesystem, under 8 GiB`);
	return { free, disk, problems };
}

async function fetchDist(cacheDir, log, get = fetch, pins = { NODE, JDK, GHIDRA }) {
	await record.nodeTarball(cacheDir, log, pins.NODE, get);
	for (const p of [pins.JDK, pins.GHIDRA]) {
		await record.pinnedFile(path.join(cacheDir, 'ghidra', 'dist', p.file), p.url, 'sha256', p.sha256, log, get);
	}
}

function docker(cmd, args) {
	const r = spawnSync('timeout', ['--kill-after=10', '120', cmd, ...args], { encoding: 'utf8' });
	if (r.error) throw r.error;
	return r;
}

async function main(argv, log = (s) => process.stdout.write(`${s}\n`), { seconds = SECONDS, fetchAll = fetchDist, free = os.freemem(), statfs = fs.statfsSync } = {}) {
	const a = inspect.parseArgs(argv);
	const staging = path.join(a.cache, 'ghidra', 'staging', String(process.pid));
	const iidfile = path.join(a.cache, 'ghidra', 'image.iid');
	const me = os.userInfo();
	const unpack = unpackArgs(a.cache, staging, `${me.uid}:${me.gid}`);
	const container = unpack[unpack.indexOf('--name') + 1];
	const steps = [unpack, buildArgs(staging, `${iidfile}.part`)].map((s) => ['--kill-after=10', String(seconds), a.docker, ...s]);
	if (a.dry_run) {
		for (const s of steps) log(`would run timeout ${s.join(' ')}`);
		return 0;
	}
	if (docker(a.docker, ['image', 'inspect', inspect.IMAGE]).status !== 0) {
		log(`ghidra: ${inspect.IMAGE} is not present, and this tool pulls nothing`);
		return 1;
	}
	fs.mkdirSync(path.dirname(staging), { recursive: true });
	const room = headroom(a.cache, free, statfs);
	log(`free memory ${(room.free / GIB).toFixed(1)} GiB, free disk ${(room.disk / GIB).toFixed(1)} GiB`);
	if (room.problems.length) {
		log(`ghidra: refused, ${room.problems.join('; ')}`);
		return 1;
	}
	await fetchAll(a.cache, log);
	fs.mkdirSync(staging);
	const trap = record.trapSignals();
	let status;
	try {
		status = await record.timed(steps[0], trap);
		log(`unpack exit ${status}`);
		if (status === 0) {
			fs.writeFileSync(path.join(staging, 'Dockerfile'), dockerfile());
			status = await record.timed(steps[1], trap);
			log(`build exit ${status}`);
		}
		if (status === 0) {
			fs.renameSync(`${iidfile}.part`, iidfile);
			log(`image ${fs.readFileSync(iidfile, 'utf8').trim()}, tagged ${TAG}`);
		}
	} finally {
		trap.release();
		docker(a.docker, ['rm', '-f', container]);
		fs.rmSync(staging, { recursive: true, force: true });
		fs.rmSync(`${iidfile}.part`, { force: true });
	}
	if (trap.signals.length) process.kill(process.pid, trap.signals[0]);
	return status;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`ghidra: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { NODE, JDK, GHIDRA, TAG, SECONDS, unpackArgs, dockerfile, buildArgs, headroom, fetchDist, main };

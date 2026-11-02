#!/usr/bin/env node
'use strict';

// Builds the pmmp-core image with this checkout's packages/ in place of pmmp-core's
// deps/pmmp-updater submodule, then reports BUILDS, LOADS and REACHABLE separately.
//
// Usage: node tools/verify/verify.js --core <pmmp-core dir> [--engine docker|wslc] [--tag <image tag>]
//
// The pmmp-core commit built is the HEAD of --core. It is written blob by blob into a
// temporary tree, so the checkout itself is never touched and its uncommitted edits are
// not built. The packages are this checkout's working tree, uncommitted edits included,
// because that is what a version run needs to try before it commits.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../lib/packages');

const ENGINES = ['docker', 'wslc'];
const DISTRO = ['wsl', '-d', 'Ubuntu-26.04', '-u', 'runner', '--exec'];
const WSLC = 'C:\\Program Files\\WSL\\wslc.exe';
const PACKAGES_PREFIX = 'deps/pmmp-updater/packages/';
const SMOKE_SCRIPT = '.github/workflows/reachable-smoke.sh';
const MOTD = 'riftal-verify-probe';

// Passed exactly once each: the shipped pocketmine.yml posts crash dumps to a public
// archive and checks for updates on every boot, and a repeated flag reaches the server
// as an array, which casts back to true (pmmp-core #91, #96).
const POCKETMINE_ARGS = '--settings.enable-dev-builds=1 --auto-report.enabled=0 --auto-updater.enabled=0';

const MINUTE = 60 * 1000;
const TIMEOUTS = { build: 60 * MINUTE, server: 10 * MINUTE, cli: 2 * MINUTE };

class UsageError extends Error {}

function checkTag(tag) {
	const m = /^([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(tag);
	if (!m) throw new UsageError(`--tag ${tag}: give a repository and a tag, for example local-pocketmine-mp:verify-mine`);
	if (m[2] === 'latest') throw new UsageError(`--tag ${tag}: :latest is shared with every other build on the engine, pick a tag of your own`);
}

function parseArgs(argv) {
	const out = { core: null, engine: 'docker', tag: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') {
			out.help = true;
			continue;
		}
		if (!['--core', '--engine', '--tag'].includes(a)) throw new UsageError(`unknown argument: ${a}`);
		const v = argv[++i];
		if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
		out[a.slice(2)] = v;
	}
	if (out.help) return out;
	if (!out.core) throw new UsageError('--core <pmmp-core dir> is required');
	if (!ENGINES.includes(out.engine)) throw new UsageError(`--engine ${out.engine}: expected one of ${ENGINES.join(', ')}`);
	if (out.tag !== null) checkTag(out.tag);
	return out;
}

function readExpectedProtocol(src = pkg.PROTOCOL_SRC) {
	const info = pkg.readProtocolInfo(src);
	if (!Number.isInteger(info.protocol) || info.protocol <= 0) throw new Error(`no CURRENT_PROTOCOL in ${path.join(src, 'ProtocolInfo.php')}`);
	return { protocol: info.protocol, version: info.version };
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const DONE = /Done \(\d+(?:\.\d+)?s\)! For help, type "help" or "\?"/;
const BAD_LEVEL = /\[[^\]/]*\/(?:ERROR|CRITICAL|EMERGENCY|ALERT)\]/;
const THROWABLE = /\b[A-Z][A-Za-z0-9_]*(?:Exception|Error)\b|PHP (?:Fatal|Parse) error|Fatal error:|Uncaught /;
// The lines Server::crashDump() logs once it decides to post, as pmmp-core's
// check-no-crash-upload.sh reads them.
const CRASH_UPLOAD = [
	'automatically submitted to the Crash Archive',
	'Automatic crash report submission failed',
	'received from crash archive',
	'Failed to communicate with crash archive',
];

// WARNING and NOTICE lines are not problems: every boot logs the nethernet and RakNet
// deprecation warnings.
function parseLoadsLog(text) {
	const lines = text.replace(ANSI, '').split(/\r?\n/);
	let done = null;
	const problems = [];
	lines.forEach((line, i) => {
		if (done === null && DONE.test(line)) done = line.trim();
		if (BAD_LEVEL.test(line) || THROWABLE.test(line) || CRASH_UPLOAD.some((s) => line.includes(s))) problems.push({ line: i + 1, text: line.trim() });
	});
	return { done, problems };
}

function loadsVerdict({ output, code, timedOut }) {
	const { done, problems } = parseLoadsLog(output);
	const reasons = [];
	if (problems.length) reasons.push(`log line ${problems[0].line}: ${problems[0].text}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
	if (timedOut) reasons.push(`the server did not exit within ${TIMEOUTS.server / MINUTE} minutes of stop on stdin`);
	if (done === null) reasons.push('no Done line in the log');
	if (!timedOut && code !== 0) reasons.push(`the server exited ${code} after stop on stdin, expected 0`);
	return reasons.length ? { pass: false, evidence: reasons.join('; ') } : { pass: true, evidence: `${done}, exit 0 after stop` };
}

// The commit must resolve the packages from deps/pmmp-updater by composer path, and its
// Dockerfile must copy them into the build stage, or this checkout's packages would not
// be the ones built. Returns the package folders the commit resolves.
function checkCoreCommit({ composerJson, dockerfile, sha }) {
	let repos;
	try {
		repos = JSON.parse(composerJson).repositories || [];
	} catch (e) {
		throw new Error(`pmmp-core ${sha}: composer.json does not parse: ${e.message}`);
	}
	const names = repos
		.filter((r) => r && r.type === 'path' && typeof r.url === 'string' && r.url.startsWith(PACKAGES_PREFIX))
		.map((r) => r.url.slice(PACKAGES_PREFIX.length).replace(/\/+$/, ''));
	if (!names.length) throw new Error(`pmmp-core ${sha} resolves no package from deps/pmmp-updater: composer.json has no path repository under ${PACKAGES_PREFIX}, so the commit predates the switch-over (Riftal-Games/PocketMine-MP#281) and would build its Packagist packages, not these`);
	if (!/^COPY\s+(?:--\S+\s+)*(?:\.\/)?deps\/pmmp-updater\/packages\/?\s/m.test(dockerfile)) throw new Error(`pmmp-core ${sha}: docker/Dockerfile does not COPY deps/pmmp-updater/packages, so composer could not find the packages in the build stage`);
	return names;
}

// reachable-smoke.sh pins the protocol pmmp-core's lock gives. Here the expected
// protocol is the one these packages speak, so the copy in the build tree gets it.
function pinProtocol(script, protocol) {
	const re = /^EXPECTED_PROTOCOL="(\d+)"$/gm;
	const hits = [...script.matchAll(re)];
	if (hits.length !== 1) throw new Error(`expected one EXPECTED_PROTOCOL="<n>" line in ${SMOKE_SCRIPT}, found ${hits.length}`);
	return { text: script.replace(re, `EXPECTED_PROTOCOL="${protocol}"`), pinned: Number(hits[0][1]) };
}

function toWslPath(p) {
	const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(path.win32.resolve(p));
	if (!m) throw new Error(`${p} is not on a Windows drive, so the distro cannot see it under /mnt`);
	return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

// The docker engine is the Docker inside the Ubuntu-26.04 distro. From Windows it is
// reached with --exec, never --, so the distro's shell never re-parses an argument
// (riftal-pm#293). bash is null where reachable-smoke.sh cannot run.
function engine(name, platform = process.platform) {
	if (name === 'wslc') {
		if (platform !== 'win32') throw new UsageError('--engine wslc exists only on Windows');
		return { name, cli: [WSLC], bash: null, path: (p) => p };
	}
	if (platform === 'win32') return { name, cli: [...DISTRO, 'docker'], bash: [...DISTRO, 'bash'], path: toWslPath };
	return { name, cli: ['docker'], bash: ['bash'], path: (p) => p };
}

function git(dir, args, opts = {}) {
	return execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function gitText(dir, args) {
	return git(dir, args).toString('utf8').trim();
}

function lsTree(dir, rev) {
	const out = git(dir, ['ls-tree', '-r', '-z', '--full-tree', rev]).toString('utf8');
	return out.split('\0').filter(Boolean).map((entry) => {
		const tab = entry.indexOf('\t');
		const [mode, type, sha] = entry.slice(0, tab).split(' ');
		return { mode, type, sha, path: entry.slice(tab + 1) };
	});
}

// Writes the committed bytes of every blob at rev into dest. No checkout runs, so no
// eol or filter setting in either repository can change a byte. Returns the gitlinks,
// path to commit, which the caller fills or leaves empty.
function writeCommitTree(dir, rev, dest) {
	const entries = lsTree(dir, rev);
	const links = new Map();
	const blobs = [];
	for (const e of entries) {
		if (e.type === 'commit') {
			links.set(e.path, e.sha);
			fs.mkdirSync(path.join(dest, e.path), { recursive: true });
		} else if (e.mode === '120000') {
			throw new Error(`${dir} at ${rev}: ${e.path} is a symlink, which this copy does not reproduce`);
		} else if (e.type === 'blob') {
			blobs.push(e);
		}
	}
	if (!blobs.length) return links;
	const out = git(dir, ['cat-file', '--batch'], { input: blobs.map((b) => b.sha).join('\n') + '\n' });
	let at = 0;
	for (const b of blobs) {
		const nl = out.indexOf(0x0a, at);
		const header = out.slice(at, nl).toString('utf8').split(' ');
		if (header[0] !== b.sha || header[1] !== 'blob') throw new Error(`git cat-file returned "${header.join(' ')}" for ${b.path}`);
		const size = Number(header[2]);
		const file = path.join(dest, b.path);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, out.subarray(nl + 1, nl + 1 + size), { mode: b.mode === '100755' ? 0o755 : 0o644 });
		at = nl + 1 + size + 1;
	}
	return links;
}

function gitConfig(dir, key) {
	try {
		return gitText(dir, ['config', '--get', key]);
	} catch {
		return null;
	}
}

// A clone that converts eol on checkout hands the build CRLF bytes the packages'
// commits never had (docs/lessons.md, 2026-11-01).
function checkEol(updater) {
	if (gitConfig(updater, 'core.autocrlf') === 'true' || gitConfig(updater, 'core.eol') === 'crlf') {
		throw new Error(`${updater} converts line endings on checkout, so packages/ does not hold its committed bytes: run git config core.autocrlf false and git config core.eol lf, then check packages/ out again (docs/lessons.md)`);
	}
}

function copyPackages(updater, dest) {
	const files = git(updater, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', 'packages']).toString('utf8').split('\0').filter(Boolean);
	let copied = 0;
	for (const rel of files) {
		const src = path.join(updater, rel);
		if (!fs.existsSync(src)) continue;
		const file = path.join(dest, rel.slice('packages/'.length));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.copyFileSync(src, file);
		copied++;
	}
	return copied;
}

// Fills tmp with the build tree. Throws with the reason when the commit cannot be
// built against these packages.
function prepareTree({ core, coreSha, updater, tmp, protocol }) {
	const composerJson = git(core, ['show', `${coreSha}:composer.json`]).toString('utf8');
	let dockerfile;
	try {
		dockerfile = git(core, ['show', `${coreSha}:docker/Dockerfile`]).toString('utf8');
	} catch {
		throw new Error(`pmmp-core ${coreSha} has no docker/Dockerfile`);
	}
	const names = checkCoreCommit({ composerJson, dockerfile, sha: coreSha });
	checkEol(updater);

	const links = writeCommitTree(core, coreSha, tmp);
	const phpSha = links.get('build/php');
	if (!phpSha) throw new Error(`pmmp-core ${coreSha} has no build/php submodule, and docker/Dockerfile compiles PHP from it`);
	const phpDir = path.join(core, 'build', 'php');
	let phpTop = null;
	try {
		phpTop = gitText(phpDir, ['rev-parse', '--show-toplevel']);
	} catch {
		phpTop = null;
	}
	const initialised = phpTop !== null && path.resolve(phpTop) === path.resolve(phpDir);
	let hasCommit = false;
	if (initialised) {
		try {
			git(phpDir, ['cat-file', '-e', `${phpSha}^{commit}`]);
			hasCommit = true;
		} catch {
			hasCommit = false;
		}
	}
	if (!hasCommit) throw new Error(`build/php in ${core} does not have commit ${phpSha}, which pmmp-core ${coreSha} pins: run git -C ${core} submodule update --init build/php`);
	writeCommitTree(phpDir, phpSha, path.join(tmp, 'build', 'php'));

	const packagesDest = path.join(tmp, ...PACKAGES_PREFIX.split('/').filter(Boolean));
	const copied = copyPackages(updater, packagesDest);
	for (const name of names) {
		if (!fs.existsSync(path.join(packagesDest, name, 'composer.json'))) throw new Error(`pmmp-core ${coreSha} resolves ${PACKAGES_PREFIX}${name}, which this checkout's packages/ does not have`);
	}

	const scriptFile = path.join(tmp, ...SMOKE_SCRIPT.split('/'));
	if (!fs.existsSync(scriptFile)) throw new Error(`pmmp-core ${coreSha} has no ${SMOKE_SCRIPT} to run REACHABLE with`);
	const pinned = pinProtocol(fs.readFileSync(scriptFile, 'utf8'), protocol);
	fs.writeFileSync(scriptFile, pinned.text, { mode: 0o755 });
	return { names, copied, pinned: pinned.pinned };
}

function spawnRunner(argv, { input = null, timeoutMs = TIMEOUTS.cli, echo = false } = {}) {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		const chunks = [];
		const finish = (code, extra = '') => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, output: Buffer.concat(chunks).toString('utf8') + extra, timedOut });
		};
		const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		const take = (c) => {
			chunks.push(c);
			if (echo) process.stderr.write(c);
		};
		child.stdout.on('data', take);
		child.stderr.on('data', take);
		child.on('error', (e) => finish(null, `\n${e.message}`));
		child.on('close', (code) => finish(code));
		child.stdin.on('error', () => {});
		child.stdin.end(input === null ? undefined : input);
	});
}

function lastMatching(output, re) {
	const lines = output.replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const hit = lines.filter((l) => re.test(l)).pop();
	return hit || lines.pop() || '(no output)';
}

function fail(name, evidence) {
	return { name, pass: false, evidence };
}

async function exists(run, eng, args) {
	return (await run([...eng.cli, ...args], { timeoutMs: TIMEOUTS.cli })).code === 0;
}

async function builds({ run, eng, tmp, coreSha, tag, identity }) {
	const r = await run([...eng.cli, 'build', '-f', eng.path(path.join(tmp, 'docker', 'Dockerfile')), '--build-arg', `GIT_HASH=${coreSha}`, '--label', `org.opencontainers.image.revision=${coreSha}`, '-t', tag, eng.path(tmp)], { timeoutMs: TIMEOUTS.build, echo: true });
	if (r.timedOut) return { verdict: fail('BUILDS', `the build did not finish within ${TIMEOUTS.build / MINUTE} minutes`) };
	if (r.code !== 0) return { verdict: fail('BUILDS', `build exited ${r.code}: ${lastMatching(r.output, /error/i)}`) };
	const inspect = await run([...eng.cli, 'image', 'inspect', tag], { timeoutMs: TIMEOUTS.cli });
	let id = null;
	try {
		id = JSON.parse(inspect.output)[0].Id;
	} catch {
		id = null;
	}
	if (inspect.code !== 0 || !id) return { verdict: fail('BUILDS', `build exited 0 but ${tag} does not inspect: ${lastMatching(inspect.output, /./)}`) };
	return { id, verdict: { name: 'BUILDS', pass: true, evidence: `${tag} is ${id}, built from ${identity}` } };
}

async function loads({ run, eng, id, base }) {
	const container = `${base}_loads`;
	const volumes = [`${container}_data`, `${container}_plugins`];
	const leftovers = [];
	let setup = null;
	let r = { code: null, output: '', timedOut: false };
	try {
		for (const vol of volumes) {
			const created = await run([...eng.cli, 'volume', 'create', vol], { timeoutMs: TIMEOUTS.cli });
			if (created.code !== 0) {
				setup = `volume create ${vol} failed: ${lastMatching(created.output, /./)}`;
				break;
			}
		}
		if (setup === null) r = await run([...eng.cli, 'run', '--name', container, '-i', '-v', `${volumes[0]}:/data`, '-v', `${volumes[1]}:/plugins`, '-e', `POCKETMINE_ARGS=${POCKETMINE_ARGS}`, id], { input: 'stop\n', timeoutMs: TIMEOUTS.server });
	} finally {
		if (r.timedOut) await run([...eng.cli, 'stop', container], { timeoutMs: TIMEOUTS.cli });
		await run([...eng.cli, 'rm', '-v', container], { timeoutMs: TIMEOUTS.cli });
		for (const vol of volumes) await run([...eng.cli, 'volume', 'rm', vol], { timeoutMs: TIMEOUTS.cli });
		if (await exists(run, eng, ['inspect', container])) leftovers.push(`container ${container}`);
		for (const vol of volumes) if (await exists(run, eng, ['volume', 'inspect', vol])) leftovers.push(`volume ${vol}`);
	}
	const v = setup === null ? loadsVerdict(r) : { pass: false, evidence: setup };
	if (!v.pass && r.output) process.stderr.write(`--- LOADS server log ---\n${r.output}\n--- end LOADS server log ---\n`);
	if (leftovers.length) return fail('LOADS', `${v.pass ? '' : `${v.evidence}; `}left behind: ${leftovers.join(', ')}`);
	return { name: 'LOADS', ...v };
}

async function reachable({ run, eng, id, base, tmp, protocol }) {
	if (!eng.bash) return fail('REACHABLE', `not run: ${SMOKE_SCRIPT} needs bash, docker and python3, which the ${eng.name} host has none of; rerun with --engine docker`);
	const container = `${base}_reachable`;
	const r = await run([...eng.bash, eng.path(path.join(tmp, ...SMOKE_SCRIPT.split('/'))), id, container, MOTD], { timeoutMs: TIMEOUTS.server });
	const leftovers = [];
	if (await exists(run, eng, ['inspect', container])) {
		await run([...eng.cli, 'stop', container], { timeoutMs: TIMEOUTS.cli });
		await run([...eng.cli, 'rm', '-v', container], { timeoutMs: TIMEOUTS.cli });
		leftovers.push(`${SMOKE_SCRIPT} left container ${container} behind, removed with rm -v`);
	}
	const answered = lastMatching(r.output, /^REACHABLE: /);
	let v;
	if (r.timedOut) v = fail('REACHABLE', `${SMOKE_SCRIPT} did not finish within ${TIMEOUTS.server / MINUTE} minutes`);
	else if (r.code !== 0) v = fail('REACHABLE', `${SMOKE_SCRIPT} exited ${r.code}: ${lastMatching(r.output, /::error::|assertion failed/)}`);
	else if (!/REACHABLE confirmed/.test(r.output) || !answered.startsWith('REACHABLE: ') || !answered.includes(`protocol=${protocol} `)) v = fail('REACHABLE', `${SMOKE_SCRIPT} exited 0 without a pong advertising protocol ${protocol}: ${answered}`);
	else v = { name: 'REACHABLE', pass: true, evidence: answered };
	if (!v.pass) process.stderr.write(`--- REACHABLE output ---\n${r.output}\n--- end REACHABLE output ---\n`);
	if (leftovers.length) return fail('REACHABLE', `${v.pass ? '' : `${v.evidence}; `}${leftovers.join('; ')}`);
	return v;
}

async function verify(opts, deps = {}) {
	const d = {
		run: spawnRunner,
		out: (line) => process.stdout.write(`${line}\n`),
		platform: process.platform,
		tmpRoot: os.tmpdir(),
		nonce: `${process.pid}${Date.now().toString(36)}`,
		updater: pkg.REPO,
		...deps,
	};
	const eng = engine(opts.engine, d.platform);
	const core = path.resolve(opts.core);
	const coreSha = gitText(core, ['rev-parse', 'HEAD']);
	const short = coreSha.slice(0, 9);
	const tag = opts.tag || `local-pocketmine-mp:verify-${short}`;
	const updaterSha = gitText(d.updater, ['rev-parse', 'HEAD']);
	const dirty = gitText(d.updater, ['status', '--porcelain', '--', 'packages']) !== '';
	const identity = `pmmp-core ${short} with pmmp-updater packages at ${updaterSha.slice(0, 9)}${dirty ? ' plus uncommitted changes' : ''}`;
	const base = `riftal_smoke_verify_${short}_${d.nonce}`;
	const verdicts = [];

	d.out(`verify: pmmp-core ${coreSha}, the HEAD of ${core}; uncommitted changes there are not built`);
	d.out(`verify: packages/ from pmmp-updater ${updaterSha}${dirty ? ', with uncommitted changes, which are built' : ''}`);

	const tmp = fs.mkdtempSync(path.join(d.tmpRoot, 'pmmp-updater-verify-'));
	try {
		let expected;
		try {
			expected = readExpectedProtocol(path.join(d.updater, 'packages', 'bedrock-protocol', 'src'));
			d.out(`verify: expected protocol ${expected.protocol} (${expected.version}) from packages/bedrock-protocol/src/ProtocolInfo.php`);
			const prep = prepareTree({ core, coreSha, updater: d.updater, tmp, protocol: expected.protocol });
			d.out(`verify: build tree ${tmp}: pmmp-core ${short}, its build/php, and ${prep.copied} files of packages/ as ${PACKAGES_PREFIX} (${prep.names.join(', ')})`);
			d.out(`verify: REACHABLE runs pmmp-core's ${SMOKE_SCRIPT} copied into the build tree, with its EXPECTED_PROTOCOL="${prep.pinned}" replaced by "${expected.protocol}" from these packages`);
		} catch (e) {
			verdicts.push(fail('BUILDS', `not built: ${e.message}`));
		}
		let id = null;
		if (!verdicts.length) {
			d.out(`verify: building ${tag} with the ${eng.name} engine`);
			const b = await builds({ run: d.run, eng, tmp, coreSha, tag, identity });
			id = b.id || null;
			verdicts.push(b.verdict);
		}
		if (id) {
			verdicts.push(await loads({ run: d.run, eng, id, base }));
			verdicts.push(await reachable({ run: d.run, eng, id, base, tmp, protocol: expected.protocol }));
		} else {
			verdicts.push(fail('LOADS', 'not run, BUILDS failed'), fail('REACHABLE', 'not run, BUILDS failed'));
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	for (const v of verdicts) d.out(`${v.name} ${v.pass ? 'PASS' : 'FAIL'} | ${v.evidence}`);
	return verdicts;
}

const USAGE = 'usage: node tools/verify/verify.js --core <pmmp-core dir> [--engine docker|wslc] [--tag <image tag>]';

async function main(argv, deps = {}) {
	let opts;
	try {
		opts = parseArgs(argv);
		if (opts.help) {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}
		engine(opts.engine, deps.platform || process.platform);
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		process.stderr.write(`verify: ${e.message}\n${USAGE}\n`);
		return 2;
	}
	const verdicts = await verify(opts, deps);
	return verdicts.every((v) => v.pass) ? 0 : 1;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`verify: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { UsageError, TIMEOUTS, POCKETMINE_ARGS, MOTD, parseArgs, readExpectedProtocol, parseLoadsLog, loadsVerdict, checkCoreCommit, pinProtocol, toWslPath, engine, writeCommitTree, prepareTree, verify, main };

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
//
// LOADS boots with no plugins, so it is not the LOADS a protocol update owes with every
// riftal-game plugin enabled.

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

const LOADS = 'LOADS (no plugins)';
const SIGNALS = ['SIGINT', 'SIGTERM'];
// Docker answers "No such object" for a container and "no such volume" for a volume.
// Any other failure, a timeout included, says nothing about whether the thing is gone.
const GONE = /no such/i;

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

// Every image a build of this Dockerfile would pull: FROM and --from references that
// are not one of its own stages, and the syntax frontend. A reference built from an ARG
// cannot be resolved without building, so it is returned as unresolved.
function baseImages(dockerfile) {
	const lines = dockerfile.split(/\r?\n/);
	const stages = new Set();
	const images = new Set();
	const unresolved = new Set();
	const want = (ref) => {
		if (ref.includes('$')) unresolved.add(ref);
		else if (ref.toLowerCase() !== 'scratch' && !stages.has(ref.toLowerCase()) && !/^\d+$/.test(ref)) images.add(ref);
	};
	for (const line of lines) {
		if (!line.startsWith('#')) break;
		const syntax = /^#\s*syntax\s*=\s*(\S+)/i.exec(line);
		if (syntax) want(syntax[1]);
	}
	for (const line of lines) {
		const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
		if (from) {
			want(from[1]);
			if (from[2]) stages.add(from[2].toLowerCase());
			continue;
		}
		for (const m of line.matchAll(/--from=([^\s,]+)/g)) want(m[1]);
		for (const m of line.matchAll(/--mount=\S*?\bfrom=([^\s,]+)/g)) want(m[1]);
	}
	return { images: [...images], unresolved: [...unresolved] };
}

function normaliseRepo(repo) {
	return repo.replace(/^docker\.io\//, '').replace(/^library\//, '');
}

function parseRef(ref) {
	const at = ref.indexOf('@');
	const digest = at === -1 ? null : ref.slice(at + 1);
	const named = at === -1 ? ref : ref.slice(0, at);
	const colon = named.lastIndexOf(':');
	const hasTag = colon > named.lastIndexOf('/');
	return { repo: normaliseRepo(hasTag ? named.slice(0, colon) : named), tag: hasTag ? named.slice(colon + 1) : (digest ? null : 'latest'), digest };
}

// Reads a docker-style `images --digests` table. Returns null when the header does not
// name the columns, because then nothing in it can be trusted.
function parseImageTable(text) {
	const lines = text.replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return null;
	const head = lines[0].trim().split(/\s{2,}/);
	const col = { repo: head.indexOf('REPOSITORY'), tag: head.indexOf('TAG'), digest: head.indexOf('DIGEST') };
	if (col.repo === -1 || col.tag === -1) return null;
	const rows = lines.slice(1).map((l) => {
		const c = l.trim().split(/\s{2,}/);
		return { repo: normaliseRepo(c[col.repo] || ''), tag: c[col.tag] || '', digest: col.digest === -1 ? null : c[col.digest] || '' };
	});
	return { rows, digests: col.digest !== -1 };
}

// Returns one reason per image the listing does not prove present. A digest-pinned
// reference is present only under that digest: the same tag at another digest is pulled.
function missingImages(table, refs) {
	const missing = [];
	for (const ref of refs) {
		const want = parseRef(ref);
		if (want.digest && !table.digests) {
			missing.push(`${ref}: the listing has no DIGEST column to confirm it`);
			continue;
		}
		const hit = table.rows.some((r) => r.repo === want.repo && (want.digest ? r.digest === want.digest : r.tag === want.tag));
		if (!hit) missing.push(`${ref}: not listed`);
	}
	return missing;
}

// wslc wedged the whole container service on 2026-09-27 while pulling an image it did not
// have, so it builds only when every image the Dockerfile names is already local.
async function checkWslcImages({ run, eng, dockerfile }) {
	const { images, unresolved } = baseImages(dockerfile);
	if (unresolved.length) return `docker/Dockerfile names ${unresolved.join(', ')}, which cannot be checked without building`;
	const r = await run([...eng.cli, 'images', '--digests'], { timeoutMs: TIMEOUTS.cli });
	if (r.timedOut) return `wslc images --digests did not answer within ${TIMEOUTS.cli / MINUTE} minutes`;
	if (r.code !== 0) return `wslc images --digests exited ${r.code}: ${lastMatching(r.output, /./)}`;
	const table = parseImageTable(r.output);
	if (!table) return `wslc images --digests printed no REPOSITORY and TAG header: ${lastMatching(r.output, /./)}`;
	const missing = missingImages(table, images);
	if (missing.length) return `the build would pull what wslc does not have: ${missing.join('; ')}`;
	return null;
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
// built against these packages. A smoke script that cannot be pinned stops only
// REACHABLE, so it comes back as smoke.error instead.
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
	let smoke;
	if (!fs.existsSync(scriptFile)) {
		smoke = { error: `pmmp-core ${coreSha} has no ${SMOKE_SCRIPT} to run REACHABLE with` };
	} else {
		try {
			const pinned = pinProtocol(fs.readFileSync(scriptFile, 'utf8'), protocol);
			fs.writeFileSync(scriptFile, pinned.text, { mode: 0o755 });
			smoke = { pinned: pinned.pinned };
		} catch (e) {
			smoke = { error: e.message };
		}
	}
	return { names, copied, dockerfile, smoke };
}

// Every call has a timeout, so a wedged engine costs minutes, not the machine. An
// aborted signal terminates the child.
function spawnRunner(argv, { input = null, timeoutMs = TIMEOUTS.cli, echo = false, signal = null } = {}) {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		const chunks = [];
		const onAbort = () => child.kill();
		const finish = (code, extra = '') => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onAbort);
			resolve({ code, output: Buffer.concat(chunks).toString('utf8') + extra, timedOut });
		};
		const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		if (signal) {
			if (signal.aborted) child.kill();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
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

async function presence(run, eng, args) {
	const r = await run([...eng.cli, ...args], { timeoutMs: TIMEOUTS.cli });
	if (r.code === 0) return { state: 'present' };
	if (!r.timedOut && GONE.test(r.output)) return { state: 'gone' };
	return { state: 'unknown', why: r.timedOut ? `${args.join(' ')} did not answer within ${TIMEOUTS.cli / MINUTE} minutes` : `${args.join(' ')} exited ${r.code}: ${lastMatching(r.output, /./)}` };
}

// Removes the containers, then the volumes, then asks the engine about each one. Only an
// explicit "no such" counts as gone.
async function removeAll(run, eng, { containers = [], volumes = [], stop = false }) {
	for (const c of containers) {
		if (stop) await run([...eng.cli, 'stop', c], { timeoutMs: TIMEOUTS.cli });
		await run([...eng.cli, 'rm', '-v', c], { timeoutMs: TIMEOUTS.cli });
	}
	for (const v of volumes) await run([...eng.cli, 'volume', 'rm', v], { timeoutMs: TIMEOUTS.cli });
	const left = { present: [], unsure: [] };
	const checks = [...containers.map((c) => ['container', c, ['inspect', c]]), ...volumes.map((v) => ['volume', v, ['volume', 'inspect', v]])];
	for (const [kind, name, args] of checks) {
		const p = await presence(run, eng, args);
		if (p.state === 'present') left.present.push(`${kind} ${name}`);
		else if (p.state === 'unknown') left.unsure.push(`${kind} ${name} (${p.why})`);
	}
	return left;
}

function leftText({ present, unsure }) {
	const parts = [];
	if (present.length) parts.push(`left behind: ${present.join(', ')}`);
	if (unsure.length) parts.push(`possibly left behind, could not check: ${unsure.join(', ')}`);
	return parts.join('; ');
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

async function loads({ run, eng, id, base, s }) {
	const container = `${base}_loads`;
	const volumes = [`${container}_data`, `${container}_plugins`];
	let left = { present: [], unsure: [] };
	let setup = null;
	let r = { code: null, output: '', timedOut: false };
	try {
		for (const vol of volumes) {
			s.made.volumes.add(vol);
			const created = await run([...eng.cli, 'volume', 'create', vol], { timeoutMs: TIMEOUTS.cli });
			if (created.code !== 0) {
				setup = `volume create ${vol} failed: ${lastMatching(created.output, /./)}`;
				break;
			}
		}
		if (setup === null) {
			s.made.containers.add(container);
			r = await run([...eng.cli, 'run', '--name', container, '-i', '-v', `${volumes[0]}:/data`, '-v', `${volumes[1]}:/plugins`, '-e', `POCKETMINE_ARGS=${POCKETMINE_ARGS}`, id], { input: 'stop\n', timeoutMs: TIMEOUTS.server });
		}
	} finally {
		left = await removeAll(run, eng, { containers: [container], volumes, stop: r.timedOut });
	}
	const v = setup === null ? loadsVerdict(r) : { pass: false, evidence: setup };
	if (!v.pass && r.output && !s.aborted) process.stderr.write(`--- LOADS server log ---\n${r.output}\n--- end LOADS server log ---\n`);
	const leftovers = leftText(left);
	if (leftovers) return fail(LOADS, `${v.pass ? '' : `${v.evidence}; `}${leftovers}`);
	return { name: LOADS, ...v };
}

async function reachable({ run, eng, id, base, tmp, protocol, s }) {
	if (!eng.bash) return fail('REACHABLE', `not run: ${SMOKE_SCRIPT} needs bash, docker and python3, which the ${eng.name} host has none of; rerun with --engine docker`);
	const container = `${base}_reachable`;
	s.made.containers.add(container);
	const r = await run([...eng.bash, eng.path(path.join(tmp, ...SMOKE_SCRIPT.split('/'))), id, container, MOTD], { timeoutMs: TIMEOUTS.server });
	const leftovers = [];
	const after = await presence(run, eng, ['inspect', container]);
	if (after.state === 'present') {
		const left = await removeAll(run, eng, { containers: [container], stop: true });
		const still = leftText(left);
		leftovers.push(`${SMOKE_SCRIPT} left container ${container} behind, ${still ? `and rm -v did not clear it: ${still}` : 'removed with rm -v'}`);
	} else if (after.state === 'unknown') {
		leftovers.push(`container ${container} possibly left behind, could not check: ${after.why}`);
	}
	const answered = lastMatching(r.output, /^REACHABLE: /);
	let v;
	if (r.timedOut) v = fail('REACHABLE', `${SMOKE_SCRIPT} did not finish within ${TIMEOUTS.server / MINUTE} minutes`);
	else if (r.code !== 0) v = fail('REACHABLE', `${SMOKE_SCRIPT} exited ${r.code}: ${lastMatching(r.output, /::error::|assertion failed/)}`);
	else if (!/REACHABLE confirmed/.test(r.output) || !answered.startsWith('REACHABLE: ') || !answered.includes(`protocol=${protocol} `)) v = fail('REACHABLE', `${SMOKE_SCRIPT} exited 0 without a pong advertising protocol ${protocol}: ${answered}`);
	else v = { name: 'REACHABLE', pass: true, evidence: answered };
	if (!v.pass && !s.aborted) process.stderr.write(`--- REACHABLE output ---\n${r.output}\n--- end REACHABLE output ---\n`);
	if (leftovers.length) return fail('REACHABLE', `${v.pass ? '' : `${v.evidence}; `}${leftovers.join('; ')}`);
	return v;
}

// On SIGINT or SIGTERM the running command is terminated, every later engine call becomes
// a no-op, and this removes what the run made with calls of its own, then exits 130.
function interruptible(d, eng) {
	const ac = new AbortController();
	const s = { aborted: null, made: { containers: new Set(), volumes: new Set() }, tmp: null, teardown: null };
	s.run = (argv, opts = {}) => (s.aborted ? Promise.resolve({ code: null, output: `not run, ${s.aborted} received`, timedOut: false }) : d.run(argv, { ...opts, signal: ac.signal }));
	const onSignal = (sig) => {
		if (s.aborted) {
			d.err(`verify: ${sig} again, still removing what this run made\n`);
			return;
		}
		s.aborted = sig;
		ac.abort();
		d.err(`verify: ${sig}, terminating the running command and removing what this run made\n`);
		s.teardown = (async () => {
			const lines = [];
			try {
				const left = await removeAll(d.run, eng, { containers: [...s.made.containers], volumes: [...s.made.volumes], stop: true });
				const text = leftText(left);
				if (text) lines.push(text);
			} catch (e) {
				lines.push(`teardown failed: ${e.message}; possibly left behind: ${[...s.made.containers, ...s.made.volumes].join(', ') || 'nothing was created'}`);
			}
			if (s.tmp) {
				try {
					fs.rmSync(s.tmp, { recursive: true, force: true });
				} catch (e) {
					lines.push(`build tree ${s.tmp} not removed: ${e.message}`);
				}
				if (fs.existsSync(s.tmp) && !lines.some((l) => l.includes(s.tmp))) lines.push(`left behind: build tree ${s.tmp}`);
			}
			d.err(`verify: interrupted by ${sig}; ${lines.length ? lines.join('; ') : 'nothing left behind'}\n`);
			d.exit(130);
		})();
	};
	const handlers = SIGNALS.map((sig) => [sig, () => onSignal(sig)]);
	for (const [sig, h] of handlers) d.signals.on(sig, h);
	s.release = () => {
		for (const [sig, h] of handlers) d.signals.removeListener(sig, h);
	};
	return s;
}

// Returns the verdicts, or null when a signal interrupted the run.
async function verify(opts, deps = {}) {
	const d = {
		run: spawnRunner,
		out: (line) => process.stdout.write(`${line}\n`),
		err: (text) => process.stderr.write(text),
		exit: (code) => process.exit(code),
		signals: process,
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

	const s = interruptible(d, eng);
	const tmp = fs.mkdtempSync(path.join(d.tmpRoot, 'pmmp-updater-verify-'));
	s.tmp = tmp;
	try {
		let expected;
		let prep;
		try {
			expected = readExpectedProtocol(path.join(d.updater, 'packages', 'bedrock-protocol', 'src'));
			d.out(`verify: expected protocol ${expected.protocol} (${expected.version}) from packages/bedrock-protocol/src/ProtocolInfo.php`);
			prep = prepareTree({ core, coreSha, updater: d.updater, tmp, protocol: expected.protocol });
			d.out(`verify: build tree ${tmp}: pmmp-core ${short}, its build/php, and ${prep.copied} files of packages/ as ${PACKAGES_PREFIX} (${prep.names.join(', ')})`);
			if (prep.smoke.error) d.out(`verify: REACHABLE cannot run: ${prep.smoke.error}`);
			else d.out(`verify: REACHABLE runs pmmp-core's ${SMOKE_SCRIPT} copied into the build tree, with its EXPECTED_PROTOCOL="${prep.smoke.pinned}" replaced by "${expected.protocol}" from these packages`);
		} catch (e) {
			verdicts.push(fail('BUILDS', `not built: ${e.message}`));
		}
		if (!verdicts.length && eng.name === 'wslc') {
			const refused = await checkWslcImages({ run: s.run, eng, dockerfile: prep.dockerfile });
			if (refused) verdicts.push(fail('BUILDS', `not built: --engine wslc refused: ${refused}`));
		}
		let id = null;
		if (!verdicts.length && !s.aborted) {
			d.out(`verify: building ${tag} with the ${eng.name} engine`);
			const b = await builds({ run: s.run, eng, tmp, coreSha, tag, identity });
			id = b.id || null;
			verdicts.push(b.verdict);
		}
		if (id && !s.aborted) {
			verdicts.push(await loads({ run: s.run, eng, id, base, s }));
			if (prep.smoke.error) verdicts.push(fail('REACHABLE', `not run: ${prep.smoke.error}`));
			else if (!s.aborted) verdicts.push(await reachable({ run: s.run, eng, id, base, tmp, protocol: expected.protocol, s }));
		} else {
			verdicts.push(fail(LOADS, 'not run, BUILDS failed'), fail('REACHABLE', 'not run, BUILDS failed'));
		}
	} finally {
		if (s.teardown) await s.teardown;
		else fs.rmSync(tmp, { recursive: true, force: true });
		s.release();
	}
	if (s.aborted) return null;
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
	if (verdicts === null) return 130;
	return verdicts.every((v) => v.pass) ? 0 : 1;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`verify: ${e.message}\n`);
		process.exitCode = 1;
	});
}

module.exports = { UsageError, TIMEOUTS, POCKETMINE_ARGS, MOTD, LOADS, parseArgs, readExpectedProtocol, parseLoadsLog, loadsVerdict, checkCoreCommit, pinProtocol, baseImages, parseImageTable, missingImages, toWslPath, engine, spawnRunner, writeCommitTree, prepareTree, verify, main };

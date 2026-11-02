'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const verify = require('../verify');

const SHA = '2c49e7e57a6d2b1c0f3e4d5a6b7c8d9e0f1a2b3c';

// A boot of the pmmp-core image fed stop on stdin, cut to the lines that matter.
const CLEAN_LOG = `Preparing PocketMine-MP.phar decompressed cache...
[18:08:43.555] [Server thread/INFO]: Loading server configuration
[18:08:43.583] [Server thread/INFO]: Starting Minecraft: Bedrock Edition server version v26.60
[18:08:45.401] [AsyncWorker#0 thread/INFO]: [Cyclic Garbage Collector] Run #1 took 19.98 ms (72738 -> 0 roots, 0 cycles collected) - cumulative GC time: 19.98 ms
[18:08:46.016] [Server thread/WARNING]: Transport nethernet is unavailable and will be skipped: the axolotl-pm/ext-webrtc extension is not loaded
[18:08:46.016] [Server thread/WARNING]: RakNet is deprecated and will be removed in a future release. Please use NetherNet instead.
[18:08:46.047] [Server thread/INFO]: Minecraft network interface running on 0.0.0.0:19132
[18:08:46.056] [Server thread/INFO]: Done (2.506s)! For help, type "help" or "?"
Command output | Stopping the server
[18:08:46.222] [Server thread/INFO]: [CONSOLE: Stopping the server]
[18:08:46.494] [Server thread/INFO]: Unloading world "world"
[18:08:47.159] [Server thread/INFO]: Stopping other threads
`;

const CRASH_LOG = `[18:08:43.555] [Server thread/INFO]: Loading server configuration
[18:08:44.100] [Server thread/CRITICAL]: pocketmine\\network\\mcpe\\convert\\TypeConverter: BlockStateDictionary: unknown block state
[18:08:44.101] [Server thread/CRITICAL]: InvalidArgumentException: "Missing block state" (EXCEPTION) in "pmsrc/vendor/axolotl-pm/bedrock-data" at line 42
[18:08:44.102] [Server thread/EMERGENCY]: An unrecoverable error has occurred and the server has crashed.
`;

const SMOKE = `#!/usr/bin/env bash
set -euo pipefail
# Advertised Bedrock protocol.
EXPECTED_PROTOCOL="2225"
echo "$EXPECTED_PROTOCOL"
`;

const DOCKERFILE = `FROM ubuntu:24.04 AS build-php
COPY --chmod=700 ./build/php/compile.sh /opt/pocketmine
FROM ubuntu:24.04 AS build-pocketmine
COPY ./composer.json ./composer.lock /opt/pocketmine/repo/
COPY ./deps/pmmp-updater/packages /opt/pocketmine/repo/deps/pmmp-updater/packages
`;

const NAMES = ['bedrock-protocol', 'bedrock-data'];

function composerJson(names = NAMES) {
	return JSON.stringify({
		name: 'axolotl-pm/pocketmine-mp',
		repositories: names.map((n) => ({ type: 'path', url: `deps/pmmp-updater/packages/${n}`, options: { symlink: false } })),
	}, null, 3);
}

function sh(dir, args) {
	return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'advice.addEmbeddedRepo=false', ...args], { stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8').trim();
}

function repo(prefix, files) {
	const dir = fx.writeTree(fx.tempDir(prefix), files);
	sh(dir, ['init', '-q']);
	sh(dir, ['config', 'core.autocrlf', 'false']);
	sh(dir, ['config', 'core.eol', 'lf']);
	sh(dir, ['add', '-A']);
	sh(dir, ['commit', '-q', '-m', 'fixture']);
	return dir;
}

// A pmmp-core commit with build/php as an initialised submodule, as a clone after
// git submodule update --init has it.
function coreFixture({ composer = composerJson(), dockerfile = DOCKERFILE, smoke = SMOKE } = {}) {
	const dir = fx.writeTree(fx.tempDir('verify-core'), {
		'composer.json': composer,
		'composer.lock': '{}',
		'docker/Dockerfile': dockerfile,
		'docker/start.sh': '#!/bin/bash\nexec php PocketMine-MP.phar\n',
		[`.github/workflows/reachable-smoke.sh`]: smoke,
		'src/Server.php': '<?php\r\n// CRLF kept as committed\r\n',
	});
	sh(dir, ['init', '-q']);
	sh(dir, ['config', 'core.autocrlf', 'false']);
	const php = path.join(dir, 'build', 'php');
	fx.writeTree(php, { 'compile.sh': '#!/bin/bash\necho compile\n', 'README.md': 'php build scripts\n' });
	sh(php, ['init', '-q']);
	sh(php, ['config', 'core.autocrlf', 'false']);
	sh(php, ['add', '-A']);
	sh(php, ['commit', '-q', '-m', 'php']);
	sh(dir, ['add', '-A']);
	sh(dir, ['update-index', '--chmod=+x', 'docker/start.sh', '.github/workflows/reachable-smoke.sh']);
	sh(dir, ['commit', '-q', '-m', 'core']);
	return dir;
}

function updaterFixture(protocol = 2239) {
	const files = {
		'packages/bedrock-protocol/composer.json': '{"name":"axolotl-pm/bedrock-protocol"}\n',
		'packages/bedrock-protocol/src/ProtocolInfo.php': fx.protocolInfoPhp(protocol, '1.26.70', { LOGIN: 1 }),
		'packages/bedrock-data/composer.json': '{"name":"axolotl-pm/bedrock-data"}\n',
		'packages/bedrock-data/canonical_block_states.nbt': Buffer.from([0x0a, 0x00, 0x0d, 0x0a, 0xff]),
		'packages/bedrock-data/.gitignore': 'vendor/\n',
		'tools/other.js': '',
	};
	const dir = repo('verify-updater', files);
	fx.writeTree(dir, { 'packages/bedrock-data/vendor/ignored.php': 'ignored', 'packages/bedrock-data/local-edit.json': '{}' });
	return dir;
}

function ok(output = '') {
	return { code: 0, output, timedOut: false };
}

const MISSING = { code: 1, output: 'Error: No such object', timedOut: false };
const IMAGE_ID = 'sha256:' + 'ab'.repeat(32);
const UBUNTU_DIGEST = 'sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac';
// The distro Docker's `images --digests` table, as it printed on 2026-11-02.
const IMAGES = `REPOSITORY   TAG       DIGEST                                                                    IMAGE ID       CREATED       SIZE
ubuntu       24.04     ${UBUNTU_DIGEST}   68ee22004a91   4 weeks ago   119MB
ubuntu       <none>    sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3   008173c23f95   7 weeks ago   119MB
`;
const PONG ='REACHABLE: 127.0.0.1:32768/udp answered with edition=MCPE motd=\'riftal-verify-probe\' protocol=2239 version=1.26.70';

// Records every engine command and answers it the way a healthy engine would, unless
// an override for that verb says otherwise. At build time it snapshots the build tree,
// which verify removes before it returns.
function fakeEngine(overrides = {}) {
	const calls = [];
	const seen = {};
	const run = async (argv, opts = {}) => {
		calls.push({ argv, opts });
		const docker = argv.indexOf('docker');
		const verb = argv[0] === 'bash' ? 'bash' : argv.slice(docker + 1, docker + 3).join(' ');
		const key = Object.keys(overrides).find((k) => verb.startsWith(k));
		if (key) return overrides[key](argv, opts, seen);
		if (verb.startsWith('build')) {
			const ctx = argv[argv.length - 1];
			seen.tree = {
				protocolInfo: fs.readFileSync(path.join(ctx, 'deps/pmmp-updater/packages/bedrock-protocol/src/ProtocolInfo.php'), 'utf8'),
				nbt: fs.readFileSync(path.join(ctx, 'deps/pmmp-updater/packages/bedrock-data/canonical_block_states.nbt')),
				localEdit: fs.existsSync(path.join(ctx, 'deps/pmmp-updater/packages/bedrock-data/local-edit.json')),
				vendor: fs.existsSync(path.join(ctx, 'deps/pmmp-updater/packages/bedrock-data/vendor')),
				compile: fs.readFileSync(path.join(ctx, 'build/php/compile.sh'), 'utf8'),
				server: fs.readFileSync(path.join(ctx, 'src/Server.php')),
				smoke: fs.readFileSync(path.join(ctx, '.github/workflows/reachable-smoke.sh'), 'utf8'),
				startMode: fs.statSync(path.join(ctx, 'docker/start.sh')).mode,
			};
			return ok('#12 naming to docker.io/library/local-pocketmine-mp:verify done');
		}
		if (verb === 'image inspect') return ok(JSON.stringify([{ Id: IMAGE_ID }]));
		if (verb.startsWith('images')) return ok(IMAGES);
		if (verb === 'volume create' || verb === 'volume rm') return ok(argv[argv.length - 1]);
		if (verb.startsWith('run')) return ok(CLEAN_LOG);
		if (verb.startsWith('rm') || verb.startsWith('stop')) return ok();
		if (verb.startsWith('inspect') || verb === 'volume inspect') return MISSING;
		if (verb === 'bash') return ok(`server is up, pinging 127.0.0.1:32768/udp\n${PONG}\nREACHABLE confirmed on 32768/udp\n`);
		throw new Error(`unexpected engine call: ${argv.join(' ')}`);
	};
	return { run, calls, seen };
}

async function runVerify({ core = coreFixture(), updater = updaterFixture(), engine = 'docker', tag = null, platform = 'linux', fake = fakeEngine(), signals = new EventEmitter() } = {}) {
	const lines = [];
	const errs = [];
	const exits = [];
	const tmpRoot = fx.tempDir('verify-tmp');
	const verdicts = await verify.verify({ core, engine, tag }, { run: fake.run, out: (l) => lines.push(l), err: (t) => errs.push(t), exit: (c) => exits.push(c), signals, platform, tmpRoot, nonce: 'n1', updater });
	return { verdicts, lines, errs, exits, calls: fake.calls, seen: fake.seen, core, tmpRoot, signals };
}

const byName = (verdicts) => Object.fromEntries(verdicts.map((v) => [v.name.split(' ')[0], v]));

test('parseArgs takes --core and defaults the engine to docker', () => {
	assert.deepEqual(verify.parseArgs(['--core', '../pmmp-core']), { core: '../pmmp-core', engine: 'docker', tag: null, help: false });
	assert.deepEqual(verify.parseArgs(['--core', 'c', '--engine', 'wslc', '--tag', 'local-pocketmine-mp:verify-x']), { core: 'c', engine: 'wslc', tag: 'local-pocketmine-mp:verify-x', help: false });
	assert.equal(verify.parseArgs(['--help']).help, true);
});

test('parseArgs refuses what it cannot run', () => {
	assert.throws(() => verify.parseArgs([]), /--core <pmmp-core dir> is required/);
	assert.throws(() => verify.parseArgs(['--core']), /--core needs a value/);
	assert.throws(() => verify.parseArgs(['--core', '--engine', 'docker']), /--core needs a value/);
	assert.throws(() => verify.parseArgs(['--core', 'c', '--engine', 'podman']), /expected one of docker, wslc/);
	assert.throws(() => verify.parseArgs(['--core', 'c', '--ref', 'HEAD']), /unknown argument: --ref/);
	assert.throws(() => verify.parseArgs(['--core', 'c', '--tag', 'local-pocketmine-mp']), /give a repository and a tag/);
	assert.throws(() => verify.parseArgs(['--core', 'c', '--tag', 'local-pocketmine-mp:latest']), /:latest is shared/);
	for (const bad of [['--core'], ['--core', 'c', '--tag', 'x:latest']]) {
		assert.throws(() => verify.parseArgs(bad), verify.UsageError);
	}
});

test('main exits 2 on a usage error before touching anything', async () => {
	const code = await verify.main(['--core', 'c', '--engine', 'wslc'], { platform: 'linux', run: () => assert.fail('no engine call') });
	assert.equal(code, 2);
});

test('readExpectedProtocol reads CURRENT_PROTOCOL from the package', () => {
	const src = fx.writeTree(fx.tempDir('verify-pi'), { 'ProtocolInfo.php': fx.protocolInfoPhp(2225, '1.26.60', { LOGIN: 1 }) });
	assert.deepEqual(verify.readExpectedProtocol(src), { protocol: 2225, version: '1.26.60' });
	const none = fx.writeTree(fx.tempDir('verify-pi'), { 'ProtocolInfo.php': '<?php\nfinal class ProtocolInfo{}\n' });
	assert.throws(() => verify.readExpectedProtocol(none), /no CURRENT_PROTOCOL/);
});

test('the real packages give a protocol', () => {
	assert.ok(verify.readExpectedProtocol().protocol > 2000);
});

test('parseLoadsLog finds Done and passes deprecation warnings', () => {
	const r = verify.parseLoadsLog(CLEAN_LOG);
	assert.equal(r.done, '[18:08:46.056] [Server thread/INFO]: Done (2.506s)! For help, type "help" or "?"');
	assert.deepEqual(r.problems, []);
});

test('parseLoadsLog reads through ANSI colour codes', () => {
	const r = verify.parseLoadsLog('\x1b[1m\x1b[37m[18:08:46.056] \x1b[0m[Server thread/INFO]: Done (0.9s)! For help, type "help" or "?"\x1b[0m\n');
	assert.match(r.done, /^\[18:08:46\.056\] \[Server thread\/INFO\]: Done \(0\.9s\)!/);
});

test('parseLoadsLog reports error levels, throwables and crash uploads', () => {
	const r = verify.parseLoadsLog(CRASH_LOG);
	assert.equal(r.done, null);
	assert.deepEqual(r.problems.map((p) => p.line), [2, 3, 4]);
	const each = [
		'[12:00:00.000] [Server thread/ERROR]: Could not load plugin "X"',
		'[12:00:00.000] [Server thread/ALERT]: something',
		'PHP Fatal error:  Uncaught Error: Class "Foo" not found',
		'#0 pmsrc/src/Server.php(10): pocketmine\\utils\\AssumptionFailedError->__construct()',
		'TypeError: Argument #1 must be of type int',
		'[12:00:00.000] [Server thread/INFO]: This crash dump has been automatically submitted to the Crash Archive.',
	];
	for (const line of each) assert.equal(verify.parseLoadsLog(line).problems.length, 1, line);
	const benign = [
		'[12:00:00.000] [Server thread/WARNING]: RakNet is deprecated',
		'[12:00:00.000] [Server thread/NOTICE]: Spawn terrain for world "world" is being generated in the background',
		'[12:00:00.000] [Server thread/INFO]: Enabling ErrorHandlerPlugin v1.0',
		'[12:00:00.000] [Server thread/INFO]: Error reporting is off',
	];
	for (const line of benign) assert.deepEqual(verify.parseLoadsLog(line).problems, [], line);
});

test('loadsVerdict passes only on Done, a clean log and exit 0', () => {
	assert.deepEqual(verify.loadsVerdict({ output: CLEAN_LOG, code: 0, timedOut: false }), { pass: true, evidence: '[18:08:46.056] [Server thread/INFO]: Done (2.506s)! For help, type "help" or "?", exit 0 after stop' });
	const crashed = verify.loadsVerdict({ output: CRASH_LOG, code: 1, timedOut: false });
	assert.equal(crashed.pass, false);
	assert.match(crashed.evidence, /^log line 2: .*TypeConverter.* \(and 2 more\); no Done line in the log; the server exited 1/);
	const exit1 = verify.loadsVerdict({ output: CLEAN_LOG, code: 1, timedOut: false });
	assert.deepEqual(exit1, { pass: false, evidence: 'the server exited 1 after stop on stdin, expected 0' });
	const hung = verify.loadsVerdict({ output: CLEAN_LOG, code: null, timedOut: true });
	assert.deepEqual(hung, { pass: false, evidence: 'the server did not exit within 10 minutes of stop on stdin' });
	assert.equal(verify.loadsVerdict({ output: '', code: 0, timedOut: false }).evidence, 'no Done line in the log');
});

test('checkCoreCommit returns the packages a switched-over commit resolves', () => {
	assert.deepEqual(verify.checkCoreCommit({ composerJson: composerJson(), dockerfile: DOCKERFILE, sha: SHA }), NAMES);
});

test('checkCoreCommit refuses a commit that still resolves from Packagist', () => {
	const packagist = JSON.stringify({ name: 'axolotl-pm/pocketmine-mp', require: { 'axolotl-pm/bedrock-protocol': '64.0.0+bedrock-1.26.60' } });
	assert.throws(() => verify.checkCoreCommit({ composerJson: packagist, dockerfile: DOCKERFILE, sha: SHA }), /resolves no package from deps\/pmmp-updater.*predates the switch-over/);
	const otherPath = JSON.stringify({ repositories: [{ type: 'path', url: 'vendor-local/bedrock-protocol' }] });
	assert.throws(() => verify.checkCoreCommit({ composerJson: otherPath, dockerfile: DOCKERFILE, sha: SHA }), /resolves no package/);
	assert.throws(() => verify.checkCoreCommit({ composerJson: composerJson(), dockerfile: 'FROM ubuntu:24.04\nCOPY ./src /src\n', sha: SHA }), /does not COPY deps\/pmmp-updater\/packages/);
	assert.throws(() => verify.checkCoreCommit({ composerJson: '{', dockerfile: DOCKERFILE, sha: SHA }), /composer.json does not parse/);
});

test('pinProtocol replaces the one assignment and nothing else', () => {
	const r = verify.pinProtocol(SMOKE, 2239);
	assert.equal(r.pinned, 2225);
	assert.equal(r.text, SMOKE.replace('EXPECTED_PROTOCOL="2225"', 'EXPECTED_PROTOCOL="2239"'));
	assert.throws(() => verify.pinProtocol('#!/bin/bash\n', 2239), /found 0/);
	assert.throws(() => verify.pinProtocol(`${SMOKE}EXPECTED_PROTOCOL="1"\n`, 2239), /found 2/);
});

test('toWslPath maps a Windows path under /mnt', () => {
	assert.equal(verify.toWslPath('C:\\Users\\nasir\\AppData\\Local\\Temp\\x'), '/mnt/c/Users/nasir/AppData/Local/Temp/x');
	assert.equal(verify.toWslPath('D:/work/pmmp-core'), '/mnt/d/work/pmmp-core');
});

test('engine reaches the distro Docker from Windows with --exec, never --', () => {
	const win = verify.engine('docker', 'win32');
	assert.deepEqual(win.cli, ['wsl', '-d', 'Ubuntu-26.04', '-u', 'runner', '--exec', 'docker']);
	assert.deepEqual(win.bash, ['wsl', '-d', 'Ubuntu-26.04', '-u', 'runner', '--exec', 'bash']);
	assert.ok(!win.cli.includes('--'));
	const linux = verify.engine('docker', 'linux');
	assert.deepEqual(linux.cli, ['docker']);
	assert.equal(linux.path('/tmp/x'), '/tmp/x');
	const wslc = verify.engine('wslc', 'win32');
	assert.deepEqual(wslc.cli, ['C:\\Program Files\\WSL\\wslc.exe']);
	assert.equal(wslc.bash, null);
	assert.throws(() => verify.engine('wslc', 'linux'), /only on Windows/);
});

test('writeCommitTree writes committed bytes and leaves gitlinks empty', () => {
	const core = coreFixture();
	const dest = fx.tempDir('verify-tree');
	const links = verify.writeCommitTree(core, 'HEAD', dest);
	assert.deepEqual([...links.keys()], ['build/php']);
	assert.deepEqual(fs.readdirSync(path.join(dest, 'build', 'php')), []);
	assert.deepEqual(fs.readFileSync(path.join(dest, 'src', 'Server.php')), Buffer.from('<?php\r\n// CRLF kept as committed\r\n'));
	assert.equal(fs.readFileSync(path.join(dest, '.github', 'workflows', 'reachable-smoke.sh'), 'utf8'), SMOKE);
	if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dest, 'docker', 'start.sh')).mode & 0o111, 0o111);
});

test('verify builds the core commit with these packages, then runs LOADS and REACHABLE', async () => {
	const r = await runVerify();
	const coreSha = sh(r.core, ['rev-parse', 'HEAD']);
	const short = coreSha.slice(0, 9);
	const v = byName(r.verdicts);
	assert.deepEqual(r.verdicts.map((x) => [x.name, x.pass]), [['BUILDS', true], ['LOADS (no plugins)', true], ['REACHABLE', true]]);
	assert.match(v.BUILDS.evidence, new RegExp(`^local-pocketmine-mp:verify-${short} is ${IMAGE_ID}, built from pmmp-core ${short} with pmmp-updater packages at [0-9a-f]{9} plus uncommitted changes$`));
	assert.match(v.LOADS.evidence, /Done \(2\.506s\)!.*exit 0 after stop$/);
	assert.equal(v.REACHABLE.evidence, PONG);

	const argv = r.calls.map((c) => c.argv);
	const build = argv[0];
	assert.deepEqual(build.slice(0, 2), ['docker', 'build']);
	assert.ok(build.includes(`GIT_HASH=${coreSha}`));
	assert.equal(build[build.indexOf('-t') + 1], `local-pocketmine-mp:verify-${short}`);
	assert.equal(r.calls[0].opts.timeoutMs, verify.TIMEOUTS.build);
	assert.deepEqual(argv[1], ['docker', 'image', 'inspect', `local-pocketmine-mp:verify-${short}`]);

	const base = `riftal_smoke_verify_${short}_n1`;
	const run = r.calls.find((c) => c.argv[1] === 'run');
	assert.deepEqual(run.argv, ['docker', 'run', '--name', `${base}_loads`, '-i', '-v', `${base}_loads_data:/data`, '-v', `${base}_loads_plugins:/plugins`, '-e', `POCKETMINE_ARGS=${verify.POCKETMINE_ARGS}`, IMAGE_ID]);
	assert.equal(run.opts.input, 'stop\n');
	for (const cleanup of [['docker', 'rm', '-v', `${base}_loads`], ['docker', 'volume', 'rm', `${base}_loads_data`], ['docker', 'volume', 'rm', `${base}_loads_plugins`], ['docker', 'inspect', `${base}_reachable`]]) {
		assert.ok(argv.some((a) => JSON.stringify(a) === JSON.stringify(cleanup)), cleanup.join(' '));
	}
	const bash = argv.find((a) => a[0] === 'bash');
	assert.match(bash[1], /[\\/]\.github[\\/]workflows[\\/]reachable-smoke\.sh$/);
	assert.deepEqual(bash.slice(2), [IMAGE_ID, `${base}_reachable`, verify.MOTD]);
	for (const a of argv) {
		for (const name of a.filter((x) => x.includes(base))) assert.match(name, /^riftal_smoke_/);
	}

	assert.match(r.seen.tree.protocolInfo, /CURRENT_PROTOCOL = 2239;/);
	assert.deepEqual(r.seen.tree.nbt, Buffer.from([0x0a, 0x00, 0x0d, 0x0a, 0xff]));
	assert.equal(r.seen.tree.localEdit, true);
	assert.equal(r.seen.tree.vendor, false);
	assert.equal(r.seen.tree.compile, '#!/bin/bash\necho compile\n');
	assert.deepEqual(r.seen.tree.server, Buffer.from('<?php\r\n// CRLF kept as committed\r\n'));
	assert.match(r.seen.tree.smoke, /^EXPECTED_PROTOCOL="2239"$/m);
	assert.ok(r.lines.some((l) => l.includes('EXPECTED_PROTOCOL="2225" replaced by "2239"')));
	assert.deepEqual(fs.readdirSync(r.tmpRoot), [], 'the build tree is removed');
	assert.deepEqual(r.lines.slice(-3).map((l) => l.split(' |')[0]), ['BUILDS PASS', 'LOADS (no plugins) PASS', 'REACHABLE PASS']);
	assert.equal(r.signals.listenerCount('SIGINT') + r.signals.listenerCount('SIGTERM'), 0, 'the signal handlers are released');
	assert.deepEqual(r.exits, []);
});

test('verify leaves the pmmp-core checkout untouched', async () => {
	const core = coreFixture();
	const before = sh(core, ['status', '--porcelain', '--ignored']);
	await runVerify({ core });
	assert.equal(sh(core, ['status', '--porcelain', '--ignored']), before);
	assert.deepEqual(sh(core, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree')).length, 1);
});

test('verify honours --tag', async () => {
	const r = await runVerify({ tag: 'local-pocketmine-mp:verify-mine' });
	const build = r.calls[0].argv;
	assert.equal(build[build.indexOf('-t') + 1], 'local-pocketmine-mp:verify-mine');
});

test('a commit before the switch-over fails BUILDS clearly and runs nothing', async () => {
	const packagist = JSON.stringify({ name: 'axolotl-pm/pocketmine-mp', require: {} });
	const r = await runVerify({ core: coreFixture({ composer: packagist }) });
	assert.deepEqual(r.calls, []);
	const v = byName(r.verdicts);
	assert.equal(v.BUILDS.pass, false);
	assert.match(v.BUILDS.evidence, /^not built: pmmp-core [0-9a-f]{40} resolves no package from deps\/pmmp-updater/);
	assert.deepEqual([v.LOADS, v.REACHABLE].map((x) => x.evidence), ['not run, BUILDS failed', 'not run, BUILDS failed']);
	assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test('a package the commit resolves but this checkout lacks fails BUILDS', async () => {
	const r = await runVerify({ core: coreFixture({ composer: composerJson([...NAMES, 'bedrock-item-upgrade-schema']) }) });
	assert.deepEqual(r.calls, []);
	assert.match(byName(r.verdicts).BUILDS.evidence, /resolves deps\/pmmp-updater\/packages\/bedrock-item-upgrade-schema, which this checkout's packages\/ does not have/);
});

test('an uninitialised build/php fails BUILDS with the command that fixes it', async () => {
	const core = coreFixture();
	fs.rmSync(path.join(core, 'build', 'php'), { recursive: true, force: true });
	fs.mkdirSync(path.join(core, 'build', 'php'));
	const r = await runVerify({ core });
	assert.deepEqual(r.calls, []);
	assert.match(byName(r.verdicts).BUILDS.evidence, /build\/php in .* does not have commit [0-9a-f]{40}.*submodule update --init build\/php/);
});

test('a checkout that converts line endings fails BUILDS', async () => {
	const updater = updaterFixture();
	sh(updater, ['config', 'core.autocrlf', 'true']);
	const r = await runVerify({ updater });
	assert.deepEqual(r.calls, []);
	assert.match(byName(r.verdicts).BUILDS.evidence, /converts line endings on checkout/);
});

test('a failed build runs neither LOADS nor REACHABLE', async () => {
	const fake = fakeEngine({ build: async () => ({ code: 1, output: '#9 [build-pocketmine 12/14] RUN composer install\n#9 ERROR: process "/bin/sh -c composer install" did not complete successfully: exit code: 2\n', timedOut: false }) });
	const r = await runVerify({ fake });
	assert.equal(r.calls.length, 1);
	const v = byName(r.verdicts);
	assert.equal(v.BUILDS.evidence, 'build exited 1: #9 ERROR: process "/bin/sh -c composer install" did not complete successfully: exit code: 2');
	assert.equal(v.LOADS.evidence, 'not run, BUILDS failed');
});

test('a crashing boot fails LOADS and still removes its container and volumes', async () => {
	const fake = fakeEngine({ run: async () => ({ code: 1, output: CRASH_LOG, timedOut: false }) });
	const r = await runVerify({ fake });
	const v = byName(r.verdicts);
	assert.equal(v.LOADS.pass, false);
	assert.match(v.LOADS.evidence, /^log line 2: /);
	const argv = r.calls.map((c) => c.argv.join(' '));
	assert.ok(argv.some((a) => /^docker rm -v riftal_smoke_verify_\w+_n1_loads$/.test(a)));
	assert.equal(argv.filter((a) => a.startsWith('docker volume rm ')).length, 2);
	assert.equal(v.REACHABLE.pass, true, 'REACHABLE is its own verdict');
});

test('a hung boot is stopped and removed', async () => {
	const fake = fakeEngine({ run: async () => ({ code: null, output: CLEAN_LOG, timedOut: true }) });
	const r = await runVerify({ fake });
	assert.match(byName(r.verdicts).LOADS.evidence, /did not exit within 10 minutes/);
	const argv = r.calls.map((c) => c.argv.join(' '));
	const stop = argv.findIndex((a) => /^docker stop \S+_loads$/.test(a));
	const rm = argv.findIndex((a) => /^docker rm -v \S+_loads$/.test(a));
	assert.ok(stop !== -1 && stop < rm);
});

test('a volume that outlives cleanup fails LOADS', async () => {
	const fake = fakeEngine({ 'volume inspect': async (argv) => (argv[argv.length - 1].endsWith('_data') ? ok('[{}]') : MISSING) });
	const r = await runVerify({ fake });
	const v = byName(r.verdicts);
	assert.equal(v.LOADS.pass, false);
	assert.match(v.LOADS.evidence, /^left behind: volume riftal_smoke_verify_\w+_n1_loads_data$/);
});

test('REACHABLE fails on a pong with the wrong protocol', async () => {
	const fake = fakeEngine({ bash: async () => ({ code: 1, output: 'REACHABLE assertion failed: protocol field is 2225, expected 2239. The advertised protocol moved.\n::error::NOT REACHABLE: no valid RakNet unconnected pong on 32768/udp\n', timedOut: false }) });
	const r = await runVerify({ fake });
	assert.equal(byName(r.verdicts).REACHABLE.evidence, '.github/workflows/reachable-smoke.sh exited 1: ::error::NOT REACHABLE: no valid RakNet unconnected pong on 32768/udp');
});

test('REACHABLE fails when the script exits 0 without the expected pong', async () => {
	const fake = fakeEngine({ bash: async () => ok('REACHABLE: 127.0.0.1:1/udp answered with edition=MCPE motd=\'x\' protocol=2225 version=1.26.60\nREACHABLE confirmed on 1/udp\n') });
	const r = await runVerify({ fake });
	assert.match(byName(r.verdicts).REACHABLE.evidence, /without a pong advertising protocol 2239/);
});

test('a container the smoke script leaves behind is removed and fails REACHABLE', async () => {
	const removed = (f) => f.calls.some((c) => /^docker rm -v \S+_reachable$/.test(c.argv.join(' ')));
	const fake = fakeEngine({ inspect: async (argv) => (argv[argv.length - 1].endsWith('_reachable') && !removed(fake) ? ok('[{}]') : MISSING) });
	const r = await runVerify({ fake });
	assert.match(byName(r.verdicts).REACHABLE.evidence, /left container riftal_smoke_verify_\w+_n1_reachable behind, removed with rm -v$/);
	assert.ok(removed(fake));
});

test('a container that survives rm -v after the smoke script fails REACHABLE as still there', async () => {
	const fake = fakeEngine({ inspect: async (argv) => (argv[argv.length - 1].endsWith('_reachable') ? ok('[{}]') : MISSING) });
	const r = await runVerify({ fake });
	assert.match(byName(r.verdicts).REACHABLE.evidence, /left container \S+_reachable behind, and rm -v did not clear it: left behind: container \S+_reachable$/);
});

test('a cleanup check that times out or errors is reported as possibly left behind, never as gone', async () => {
	const hung = fakeEngine({ 'volume inspect': async (argv) => (argv[argv.length - 1].endsWith('_data') ? { code: null, output: '', timedOut: true } : MISSING) });
	const a = byName((await runVerify({ fake: hung })).verdicts).LOADS;
	assert.equal(a.pass, false);
	assert.match(a.evidence, /^possibly left behind, could not check: volume riftal_smoke_verify_\w+_n1_loads_data \(volume inspect \S+ did not answer within 2 minutes\)$/);

	const daemon = fakeEngine({ inspect: async () => ({ code: 1, output: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', timedOut: false }) });
	const b = byName((await runVerify({ fake: daemon })).verdicts);
	assert.match(b.LOADS.evidence, /^possibly left behind, could not check: container \S+_loads \(inspect \S+ exited 1: Cannot connect to the Docker daemon/);
	assert.match(b.REACHABLE.evidence, /^container \S+_reachable possibly left behind, could not check: inspect \S+ exited 1: Cannot connect/);

	const gone = fakeEngine({ 'volume inspect': async (argv) => ({ code: 1, output: `Error response from daemon: get ${argv[argv.length - 1]}: no such volume`, timedOut: false }) });
	assert.equal(byName((await runVerify({ fake: gone })).verdicts).LOADS.pass, true, 'the distro Docker\'s lower-case "no such volume" counts as gone');
});

function asWslc(fake) {
	return { ...fake, run: (argv, opts) => fake.run(argv[0].endsWith('wslc.exe') ? ['docker', ...argv.slice(1)] : argv, opts) };
}

test('the wslc engine checks its images first, builds and loads with wslc, and does not claim REACHABLE', async () => {
	const r = await runVerify({ engine: 'wslc', platform: 'win32', fake: asWslc(fakeEngine()) });
	const v = byName(r.verdicts);
	assert.deepEqual(r.calls[0].argv, ['docker', 'images', '--digests']);
	assert.equal(r.calls[1].argv[1], 'build');
	assert.equal(v.BUILDS.pass, true);
	assert.equal(v.LOADS.pass, true);
	assert.equal(v.REACHABLE.pass, false);
	assert.match(v.REACHABLE.evidence, /^not run: .*rerun with --engine docker$/);
	assert.ok(!r.calls.some((c) => c.argv[0] === 'bash'));
	for (const c of r.calls) assert.ok(c.opts.timeoutMs > 0, 'every wslc call has a timeout');
});

test('the wslc engine refuses to build when it would pull a base image', async () => {
	const pinned = DOCKERFILE.replace(/ubuntu:24\.04/g, `ubuntu:24.04@${UBUNTU_DIGEST.replace('68ee', '0000')}`);
	const cases = [
		[{}, pinned, /--engine wslc refused: the build would pull what wslc does not have: ubuntu:24\.04@sha256:0000\S+: not listed$/],
		[{ images: async () => ok(IMAGES.replace(/^ubuntu {7}24\.04 .*\n/m, '')) }, DOCKERFILE, /ubuntu:24\.04: not listed$/],
		[{ images: async () => ok('REPOSITORY   TAG   IMAGE ID\nubuntu   24.04   68ee22004a91\n') }, pinned, /the listing has no DIGEST column to confirm it$/],
		[{ images: async () => ({ code: null, output: '', timedOut: true }) }, DOCKERFILE, /wslc images --digests did not answer within 2 minutes$/],
		[{ images: async () => ({ code: 1, output: 'unknown flag: --digests', timedOut: false }) }, DOCKERFILE, /wslc images --digests exited 1: unknown flag: --digests$/],
		[{ images: async () => ok('ubuntu 24.04\n') }, DOCKERFILE, /printed no REPOSITORY and TAG header/],
		[{}, 'ARG BASE=ubuntu:24.04\nFROM ${BASE}\nCOPY ./deps/pmmp-updater/packages /p\n', /names \$\{BASE\}, which cannot be checked without building$/],
	];
	for (const [overrides, dockerfile, want] of cases) {
		const r = await runVerify({ engine: 'wslc', platform: 'win32', core: coreFixture({ dockerfile }), fake: asWslc(fakeEngine(overrides)) });
		const v = byName(r.verdicts);
		assert.match(v.BUILDS.evidence, want);
		assert.equal(v.LOADS.evidence, 'not run, BUILDS failed');
		assert.ok(!r.calls.some((c) => c.argv[1] === 'build'), 'nothing is built');
		assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
	}
});

test('the wslc engine builds a digest-pinned base it already has', async () => {
	const pinned = DOCKERFILE.replace(/ubuntu:24\.04/g, `ubuntu:24.04@${UBUNTU_DIGEST}`);
	const r = await runVerify({ engine: 'wslc', platform: 'win32', core: coreFixture({ dockerfile: pinned }), fake: asWslc(fakeEngine()) });
	assert.equal(byName(r.verdicts).BUILDS.pass, true);
});

test('baseImages lists what a build would pull and skips its own stages', () => {
	const real = `FROM ubuntu:24.04@${UBUNTU_DIGEST} AS build-php
COPY --chmod=700 ./build/php/compile.sh /opt/pocketmine
FROM ubuntu:24.04@${UBUNTU_DIGEST} AS build-pocketmine
COPY --from=build-php /opt/pocketmine/bin /opt/pocketmine/bin
FROM ubuntu:24.04@${UBUNTU_DIGEST}
COPY --from=build-pocketmine /opt/pocketmine/repo/PocketMine-MP.phar PocketMine-MP.phar
`;
	assert.deepEqual(verify.baseImages(real), { images: [`ubuntu:24.04@${UBUNTU_DIGEST}`], unresolved: [] });
	const other = '# syntax=docker/dockerfile:1.7\nFROM --platform=linux/amd64 php:8.3-cli AS a\nFROM scratch\nCOPY --from=0 /x /x\nCOPY --from=composer:2 /usr/bin/composer /c\nRUN --mount=type=cache,from=busybox:1,target=/b true\nFROM ${IMG}\n';
	assert.deepEqual(verify.baseImages(other), { images: ['docker/dockerfile:1.7', 'php:8.3-cli', 'composer:2', 'busybox:1'], unresolved: ['${IMG}'] });
});

test('missingImages reads the distro Docker table', () => {
	const table = verify.parseImageTable(IMAGES);
	assert.equal(table.digests, true);
	assert.deepEqual(verify.missingImages(table, [`ubuntu:24.04@${UBUNTU_DIGEST}`, 'ubuntu:24.04', 'docker.io/library/ubuntu:24.04', 'ubuntu']), ['ubuntu: not listed']);
	assert.equal(verify.parseImageTable(''), null);
});

test('a Done line does not excuse a CRITICAL line: LOADS fails', () => {
	const log = CLEAN_LOG.replace('[18:08:46.056] [Server thread/INFO]: Done', '[18:08:46.050] [Server thread/CRITICAL]: Could not load world "world"\n[18:08:46.056] [Server thread/INFO]: Done');
	const r = verify.parseLoadsLog(log);
	assert.match(r.done, /Done \(2\.506s\)!/);
	assert.deepEqual(r.problems.map((p) => p.text), ['[18:08:46.050] [Server thread/CRITICAL]: Could not load world "world"']);
	assert.deepEqual(verify.loadsVerdict({ output: log, code: 0, timedOut: false }), { pass: false, evidence: 'log line 8: [18:08:46.050] [Server thread/CRITICAL]: Could not load world "world"' });
});

test('a smoke script with no or two EXPECTED_PROTOCOL lines fails REACHABLE, not BUILDS', async () => {
	for (const [smoke, found] of [['#!/usr/bin/env bash\necho no pin\n', 0], [`${SMOKE}EXPECTED_PROTOCOL="1"\n`, 2]]) {
		const r = await runVerify({ core: coreFixture({ smoke }) });
		assert.deepEqual(r.verdicts.map((x) => [x.name, x.pass]), [['BUILDS', true], ['LOADS (no plugins)', true], ['REACHABLE', false]]);
		assert.equal(byName(r.verdicts).REACHABLE.evidence, `not run: expected one EXPECTED_PROTOCOL="<n>" line in .github/workflows/reachable-smoke.sh, found ${found}`);
		assert.ok(!r.calls.some((c) => c.argv[0] === 'bash'), 'the unpinned script never runs');
		assert.ok(r.lines.some((l) => l.startsWith('verify: REACHABLE cannot run: ')));
	}
});

// Answers the verb with a command that runs until verify aborts it, raising the signal
// once the command is under way, the way Ctrl-C lands mid-build or mid-boot.
function interruptedAt(verb, signals, sig = 'SIGINT') {
	const seen = { signal: null };
	const hold = (argv, opts) => new Promise((resolve) => {
		seen.signal = opts.signal;
		opts.signal.addEventListener('abort', () => resolve({ code: null, output: 'terminated', timedOut: false }), { once: true });
		setImmediate(() => signals.emit(sig));
	});
	return { overrides: { [verb]: hold }, seen };
}

test('SIGINT during LOADS terminates the boot, stops and removes its container and volumes, removes the tree and exits 130', async () => {
	const signals = new EventEmitter();
	const at = interruptedAt('run', signals);
	const fake = fakeEngine(at.overrides);
	const r = await runVerify({ fake, signals });
	assert.equal(r.verdicts, null);
	assert.deepEqual(r.exits, [130]);
	assert.equal(at.seen.signal.aborted, true, 'the running command was terminated');
	const base = r.calls.find((c) => c.argv[1] === 'run').argv[3];
	const after = r.calls.slice(r.calls.findIndex((c) => c.argv[1] === 'run') + 1).map((c) => c.argv.join(' '));
	assert.deepEqual(after, [
		`docker stop ${base}`,
		`docker rm -v ${base}`,
		`docker volume rm ${base}_data`,
		`docker volume rm ${base}_plugins`,
		`docker inspect ${base}`,
		`docker volume inspect ${base}_data`,
		`docker volume inspect ${base}_plugins`,
	]);
	assert.ok(!r.calls.some((c) => c.argv[0] === 'bash'), 'REACHABLE never starts');
	assert.deepEqual(fs.readdirSync(r.tmpRoot), [], 'the build tree is removed');
	assert.match(r.errs.join(''), /verify: interrupted by SIGINT; nothing left behind\n$/);
	assert.ok(!r.lines.some((l) => /^(BUILDS|LOADS|REACHABLE) /.test(l)), 'no verdict is printed for an interrupted run');
	assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0);
});

test('SIGTERM during the build terminates it, removes the tree and exits 130', async () => {
	const signals = new EventEmitter();
	const at = interruptedAt('build', signals, 'SIGTERM');
	const r = await runVerify({ fake: fakeEngine(at.overrides), signals });
	assert.equal(r.verdicts, null);
	assert.deepEqual(r.exits, [130]);
	assert.equal(at.seen.signal.aborted, true);
	assert.deepEqual(r.calls.map((c) => c.argv[1]), ['build'], 'nothing runs after the build is terminated');
	assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
	assert.match(r.errs.join(''), /interrupted by SIGTERM; nothing left behind/);
});

test('SIGINT during REACHABLE stops and removes the smoke container', async () => {
	const signals = new EventEmitter();
	const r = await runVerify({ fake: fakeEngine(interruptedAt('bash', signals).overrides), signals });
	assert.deepEqual(r.exits, [130]);
	const after = r.calls.slice(r.calls.findIndex((c) => c.argv[0] === 'bash') + 1).map((c) => c.argv.join(' '));
	assert.ok(after.some((a) => /^docker stop \S+_reachable$/.test(a)));
	assert.ok(after.some((a) => /^docker rm -v \S+_reachable$/.test(a)));
	assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test('an interrupt prints what it could not remove', async () => {
	const signals = new EventEmitter();
	const at = interruptedAt('run', signals);
	const fake = fakeEngine({
		...at.overrides,
		'volume inspect': async (argv) => (argv[argv.length - 1].endsWith('_data') ? ok('[{}]') : { code: null, output: '', timedOut: true }),
	});
	const r = await runVerify({ fake, signals });
	assert.deepEqual(r.exits, [130]);
	assert.match(r.errs.join(''), /interrupted by SIGINT; left behind: volume \S+_loads_data; possibly left behind, could not check: volume \S+_loads_plugins \(volume inspect \S+ did not answer within 2 minutes\)\n$/);
});

test('a second signal during teardown does not cut it short', async () => {
	const signals = new EventEmitter();
	const at = interruptedAt('run', signals);
	const fake = fakeEngine({ ...at.overrides, stop: async () => { signals.emit('SIGINT'); return ok(); } });
	const r = await runVerify({ fake, signals });
	assert.deepEqual(r.exits, [130]);
	assert.match(r.errs.join(''), /SIGINT again, still removing what this run made/);
	assert.ok(r.calls.some((c) => /^docker volume inspect \S+_plugins$/.test(c.argv.join(' '))), 'teardown ran to the end');
});

test('main returns 130 for an interrupted run', async () => {
	const signals = new EventEmitter();
	const at = interruptedAt('build', signals);
	const code = await verify.main(['--core', coreFixture()], { run: fakeEngine(at.overrides).run, out: () => {}, err: () => {}, exit: () => {}, signals, platform: 'linux', tmpRoot: fx.tempDir('verify-tmp'), nonce: 'n1', updater: updaterFixture() });
	assert.equal(code, 130);
});

test('spawnRunner terminates its child when the signal aborts', async () => {
	const ac = new AbortController();
	const started = Date.now();
	const pending = verify.spawnRunner([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 120000, signal: ac.signal });
	setTimeout(() => ac.abort(), 200);
	const r = await pending;
	assert.notEqual(r.code, 0);
	assert.equal(r.timedOut, false);
	assert.ok(Date.now() - started < 30000, 'the child did not run to its 60 s end');
});

// Builds the real pmmp-core image, 20 to 40 minutes when the PHP stage is not cached.
test('live: verify against the sibling pmmp-core with the distro Docker', { skip: process.env.RIFTAL_LIVE_VERIFY !== '1' && 'set RIFTAL_LIVE_VERIFY=1' }, () => {
	const core = process.env.RIFTAL_VERIFY_CORE || path.join(__dirname, '..', '..', '..', '..', 'pmmp-core');
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'verify.js'), '--core', core, '--engine', 'docker'], { encoding: 'utf8', timeout: 75 * 60 * 1000, maxBuffer: 1 << 28 });
	const verdicts = r.stdout.split('\n').filter((l) => /^(BUILDS|LOADS|REACHABLE) /.test(l));
	assert.deepEqual(verdicts.map((l) => l.split(' |')[0]), ['BUILDS PASS', 'LOADS (no plugins) PASS', 'REACHABLE PASS'], `${r.stdout}\n${r.stderr}`);
	assert.equal(r.status, 0);
});

'use strict';

// The BDS job's terms, read from the workflow and run.sh as text: started by hand only,
// on the riftal runners, with nothing of Mojang's uploaded, cached or printed beyond a
// report's needs (pmmp-updater#10, issuecomment-6916686127 and issuecomment-6920397807).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('../../test-support/fixtures');

const REPO = path.join(__dirname, '..', '..', '..');
const JOB = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'bds.yml'), 'utf8');
const RUN = fs.readFileSync(path.join(__dirname, '..', 'run.sh'), 'utf8');
const code = JOB.split('\n').filter((l) => !/^\s*#/.test(l));

test('the job is started by hand, and the pull_request trigger only lists it, for this file alone', () => {
	const on = JOB.slice(JOB.indexOf('\non:\n'), JOB.indexOf('\npermissions:'));
	assert.deepEqual(on.split('\n').filter((l) => /^ {2}\S/.test(l)), ['  workflow_dispatch:', '  pull_request:']);
	assert.match(on, /\n {2}pull_request:\n {4}paths:\n {6}- \.github\/workflows\/bds\.yml\n?$/);
	assert.equal(code.filter((l) => /^\s+runs-on:/.test(l)).length, 1);
	assert.ok(code.includes("    if: github.event_name == 'workflow_dispatch'"));
	assert.ok(code.includes('    runs-on: [self-hosted, linux, riftal]'));
	assert.match(on, /\n {6}build:\n(?: {8}.*\n)* {8}required: true\n/);
});

test('the job runs no container itself, publishes nothing and uploads or caches nothing', () => {
	const text = code.join('\n');
	for (const banned of [/docker /, /--privileged/, /--device/, /--network/, /--net=/, /--pid/, /--cap-add/, /--publish/, /\s-p\s/, /upload-artifact/, /actions\/cache/, /secrets\./, /continue-on-error/]) {
		assert.doesNotMatch(text, banned);
	}
	assert.match(text, /\n {6}- uses: actions\/checkout@[0-9a-f]{40}\n {8}with:\n {10}persist-credentials: false\n/);
	assert.equal(code.filter((l) => /^\s+- uses:/.test(l)).length, 1);
});

test('inputs reach the run only through env, and BDS and its output live under RUNNER_TEMP, removed after every run', () => {
	for (const l of code.filter((x) => x.includes('${{'))) assert.match(l, /^ {10}[A-Z0-9_]+: \$\{\{ inputs\.[a-z0-9_]+ \}\}$/, l);
	assert.match(JOB, /\n {10}set -- --build "\$BUILD" --channel "\$CHANNEL" --cache "\$RUNNER_TEMP\/bds"\n(?: {10}.*\n)* {10}node tools\/bds\/record\.js "\$@"\n/);
	assert.match(JOB, /\n {6}- name: [^\n]+\n {8}if: always\(\)\n {8}run: rm -rf "\$RUNNER_TEMP\/bds"\n/);
	assert.match(JOB, /\n {4}timeout-minutes: \d+\n/);
});

test('run.sh prints none of bds.log but its line count, its version and its errors', () => {
	const reads = RUN.split('\n').filter((l) => l.includes('bds.log') && !/^\s*#/.test(l)).map((l) => l.trim());
	assert.deepEqual(reads, [
		'echo "== bds.log: $(wc -l <bds.log) lines, its version and errors only" >&2',
		"grep -aE 'Version: |ERROR\\]' bds.log >&2 || true",
		'LD_LIBRARY_PATH=. ./bedrock_server </dev/null >bds.log 2>&1 &',
		`if ! timeout 180 bash -c 'until grep -q "Server started" bds.log; do sleep 1; done'; then`,
	]);
	assert.equal(RUN.match(/^\s*bds_log$/gm).length, 2);
});

test('bds_log shows the version and error lines of a synthetic log and nothing else', { skip: process.platform === 'win32' && 'bash needs a POSIX shell' }, () => {
	const dir = fx.tempDir('bds-log');
	fx.writeTree(dir, {
		'bds.log': [
			'NO LOG FILE! - setting up server logging...',
			'[2026-01-01 00:00:00:001 INFO] Starting Server',
			'[2026-01-01 00:00:00:002 INFO] Version: 9.8.7.6',
			'[2026-01-01 00:00:00:003 INFO] Level Name: synthetic',
			'[2026-01-01 00:00:00:004 ERROR] synthetic failure',
			'[2026-01-01 00:00:00:005 INFO] Server started.',
			'',
		].join('\n'),
	});
	const start = RUN.indexOf('bds_log() {');
	const fn = RUN.slice(start, RUN.indexOf('\n}\n', start) + 3);
	const r = spawnSync('bash', ['-c', `set -euo pipefail; cd "$1"; ${fn}bds_log; echo ok`, 'bds_log', dir], { encoding: 'utf8' });
	assert.equal(r.stdout, 'ok\n');
	assert.equal(r.stderr, '== bds.log: 6 lines, its version and errors only\n[2026-01-01 00:00:00:002 INFO] Version: 9.8.7.6\n[2026-01-01 00:00:00:004 ERROR] synthetic failure\n');
	fx.writeTree(dir, { 'bds.log': 'nothing matches\n' });
	assert.equal(spawnSync('bash', ['-c', `set -euo pipefail; cd "$1"; ${fn}bds_log; echo ok`, 'bds_log', dir], { encoding: 'utf8' }).stdout, 'ok\n');
});

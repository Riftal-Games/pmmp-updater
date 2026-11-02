'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fx = require('../fixtures');

const FIXTURES = path.join(__dirname, '..', 'fixtures.js');
const TOOLS = path.join(__dirname, '..', '..');

// Each file creates temp dirs and then ends a different way: a test that fails, one
// that passes, and an exception thrown outside any test.
function endings(dir) {
	const req = `const test = require('node:test');\nconst fx = require(${JSON.stringify(FIXTURES)});\n`;
	return fx.writeTree(dir, {
		'fails.test.js': `${req}test('fails', () => { fx.writeTree(fx.tempDir('fails'), { 'a/b.txt': 'x' }); throw new Error('expected failure'); });\n`,
		'passes.test.js': `${req}test('passes', () => { fx.tempDir('passes'); fx.tempDir('passes'); });\n`,
		'throws.test.js': `${req}fx.tempDir('throws');\nthrow new Error('expected uncaught');\n`,
	});
}

test('a test run leaves no temp dirs behind, whether its tests pass, fail or throw', () => {
	const root = fx.tempDir('cleanup');
	const tmp = path.join(root, 'tmp');
	fs.mkdirSync(tmp);
	const suites = endings(path.join(root, 'suites'));
	const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
	delete env.NODE_TEST_CONTEXT;
	const files = [
		...['fails', 'passes', 'throws'].map((n) => path.join(suites, `${n}.test.js`)),
		path.join(TOOLS, 'docs-diff', 'test', 'diff.test.js'),
		path.join(TOOLS, 'lesson-guard', 'test', 'check.test.js'),
		path.join(TOOLS, 'skills-lint', 'test', 'lint.test.js'),
	];
	const r = spawnSync(process.execPath, ['--test', ...files], { env, encoding: 'utf8' });
	assert.equal(r.status, 1, 'the deliberate failures fail the run');
	assert.match(r.stdout, /expected failure/);
	assert.match(r.stdout, /expected uncaught/);
	assert.match(r.stdout, /fail 2\b/, r.stdout);
	assert.deepEqual(fs.readdirSync(tmp), []);
});

// Windows has no signal a test can send that a Node process can handle.
test('an interrupted test run removes its temp dirs too', { skip: process.platform === 'win32' }, async () => {
	const root = fx.tempDir('cleanup-signal');
	const tmp = path.join(root, 'tmp');
	fs.mkdirSync(tmp);
	const file = fx.writeTree(path.join(root, 'suites'), {
		'hangs.test.js': `const test = require('node:test');\nconst fx = require(${JSON.stringify(FIXTURES)});\ntest('hangs', async () => { fx.tempDir('hangs'); await new Promise((r) => setTimeout(r, 60000)); });\n`,
	});
	const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
	delete env.NODE_TEST_CONTEXT;
	for (const signal of ['SIGINT', 'SIGTERM']) {
		const child = spawn(process.execPath, ['--test', path.join(file, 'hangs.test.js')], { env, stdio: 'ignore' });
		const exited = new Promise((resolve) => child.on('exit', resolve));
		const deadline = Date.now() + 20000;
		while (fs.readdirSync(tmp).length === 0) {
			assert.ok(Date.now() < deadline, 'the test process never created its temp dir');
			await new Promise((r) => setTimeout(r, 50));
		}
		child.kill(signal);
		await exited;
		assert.deepEqual(fs.readdirSync(tmp), [], signal);
	}
});

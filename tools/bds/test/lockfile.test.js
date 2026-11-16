'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx = require('../../test-support/fixtures');
const record = require('../record');
const manifest = require('../package.json');
const lock = require('../package-lock.json');

const WERIFT = 'sha512-JgFfqVXZ4s3A+VE2DxMo5QympNAnravCuQdNqQeBiKIrojtpjghYahgnl5Vc+sh0Porsx/LHODNMdZKM/JbksA==';
const sri = (body) => `sha512-${crypto.createHash('sha512').update(body).digest('base64')}`;
const entry = (body) => ({ version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: sri(body), license: 'MIT' });
const withEntry = (e) => ({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': e } });

test('package.json is private, untyped, scriptless and declares exactly werift 0.27.0', () => {
	assert.equal(manifest.private, true);
	assert.ok(!('type' in manifest) && !('scripts' in manifest));
	assert.deepEqual(manifest.dependencies, { werift: '0.27.0' });
	assert.ok(!('devDependencies' in manifest) && !('optionalDependencies' in manifest));
});

test('the committed lockfile is v3, pins werift by the ADR\'s integrity and passes every check', () => {
	assert.equal(lock.lockfileVersion, 3);
	assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
	assert.equal(lock.packages['node_modules/werift'].version, '0.27.0');
	assert.equal(lock.packages['node_modules/werift'].integrity, WERIFT);
	assert.deepEqual(record.lockProblems(lock), []);
});

test('each way a locked package may not reach the run is refused', () => {
	const ok = entry('a');
	assert.deepEqual(record.lockProblems(withEntry(ok)), []);
	const cases = {
		'resolved http://registry.npmjs.org/a/-/a-1.0.0.tgz': { resolved: 'http://registry.npmjs.org/a/-/a-1.0.0.tgz' },
		'resolved https://registry.example/a/-/a-1.0.0.tgz': { resolved: 'https://registry.example/a/-/a-1.0.0.tgz' },
		'no sha512 integrity': { integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=' },
		'install script': { hasInstallScript: true },
		'os': { os: ['linux'] },
		'cpu': { cpu: ['x64'] },
		'optional': { optional: true },
		'licence GPL-3.0': { license: 'GPL-3.0' },
		'licence undefined': { license: undefined },
	};
	for (const [problem, change] of Object.entries(cases)) {
		const found = record.lockProblems(withEntry({ ...ok, ...change }));
		assert.deepEqual(found, [`node_modules/a: ${problem}`]);
	}
	const missing = { ...ok };
	delete missing.integrity;
	assert.match(record.lockProblems(withEntry(missing)).join(), /no sha512 integrity/);
	assert.match(record.lockProblems({ ...withEntry(ok), lockfileVersion: 2 }).join(), /lockfileVersion 2/);
});

test('a locked tarball is kept under its sha512 hex only when it matches, and rechecked when cached', async () => {
	const dir = fx.tempDir('bds-npm');
	const body = Buffer.from('synthetic tarball');
	const fake = withEntry(entry(body));
	const hex = crypto.createHash('sha512').update(body).digest('hex');
	const dest = path.join(dir, 'npm', `${hex}.tgz`);
	const serve = (b) => async () => ({ ok: true, status: 200, arrayBuffer: async () => b });
	await assert.rejects(record.npmTarballs(dir, () => {}, fake, serve(Buffer.from('tampered'))), /sha512 [0-9a-f]{128}, expected/);
	assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
	await record.npmTarballs(dir, () => {}, fake, serve(body));
	assert.deepEqual(fs.readFileSync(dest), body);
	fs.writeFileSync(dest, 'tampered');
	await assert.rejects(record.npmTarballs(dir, () => {}, fake, () => assert.fail('a cached file is not downloaded again')), /cached .* has sha512/);
	await assert.rejects(record.npmTarballs(dir, () => {}, withEntry({ ...entry(body), license: 'GPL-3.0' }), () => assert.fail('a refused lock fetches nothing')), /licence GPL-3.0/);
});

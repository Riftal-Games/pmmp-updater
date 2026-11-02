'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../packages');
const fx = require('../../test-support/fixtures');

function coreWithLock(entry) {
	return fx.writeTree(fx.tempDir('core'), { 'composer.lock': { packages: [{ name: 'axolotl-pm/bedrock-data', version: '1.0.0' }, { name: 'axolotl-pm/bedrock-protocol', ...entry }] } });
}

test('a pmmp-core pin resolved from git reports its source url', () => {
	const dir = coreWithLock({
		version: '62.0.0+bedrock-1.26.50',
		source: { type: 'git', url: 'https://github.com/axolotl-pm/BedrockProtocol.git', reference: 'abc' },
		dist: { type: 'zip', url: 'https://api.github.com/repos/axolotl-pm/BedrockProtocol/zipball/abc', reference: 'abc' },
	});
	assert.deepEqual(pkg.corePin(dir), { package_version: '62.0.0+bedrock-1.26.50', version: '1.26.50', source: 'https://github.com/axolotl-pm/BedrockProtocol.git' });
});

test('a pmmp-core pin resolved from a path repository reports the dist type and url', () => {
	const dir = coreWithLock({
		version: '64.0.0+bedrock-1.26.60',
		dist: { type: 'path', url: 'deps/pmmp-updater/packages/bedrock-protocol', reference: 'c66056e6b0943f26d008abf3dd6e9cf1f3182cde' },
	});
	assert.deepEqual(pkg.corePin(dir), { package_version: '64.0.0+bedrock-1.26.60', version: '1.26.60', source: 'path deps/pmmp-updater/packages/bedrock-protocol' });
});

test('no sibling pmmp-core checkout, or no protocol package in its lock, is no pin', () => {
	assert.equal(pkg.corePin(fx.tempDir('no-core')), null);
	assert.equal(pkg.corePin(fx.writeTree(fx.tempDir('core'), { 'composer.lock': { packages: [] } })), null);
});

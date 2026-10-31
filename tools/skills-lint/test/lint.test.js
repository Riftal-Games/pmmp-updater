'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lint } = require('../lint');
const fx = require('../../test-support/fixtures');

const REAL = path.join(__dirname, '..', '..', '..', '.claude', 'skills');
const BLOCK = fs.readFileSync(path.join(REAL, 'FAILURE-BLOCK.md'), 'utf8');
const canonical = BLOCK.slice(BLOCK.indexOf('<!-- failure-block:start -->'));

function skills(files) {
	return fx.writeTree(fx.tempDir('skills'), { 'FAILURE-BLOCK.md': BLOCK, ...files });
}

const good = (name) => `---\nname: ${name}\ndescription: Does a thing.\n---\n\n# ${name}\n\nSteps.\n\n${canonical.trimEnd()}\n`;

test('the repository skills pass', () => {
	assert.deepEqual(lint(REAL), []);
});

test('a skill without the failure block fails', () => {
	const dir = skills({ 'alpha/SKILL.md': good('alpha'), 'beta/SKILL.md': '---\nname: beta\ndescription: x\n---\n\nNo block.\n' });
	assert.deepEqual(lint(dir), ['beta: missing the shared failure block']);
});

test('an edited failure block fails', () => {
	const dir = skills({ 'alpha/SKILL.md': good('alpha').replace('Do not retry blindly', 'Retry freely') });
	assert.deepEqual(lint(dir), ['alpha: failure block differs from FAILURE-BLOCK.md']);
});

test('a block followed by more text fails', () => {
	const dir = skills({ 'alpha/SKILL.md': good('alpha') + '\n## Afterthought\n' });
	assert.deepEqual(lint(dir), ['alpha: failure block is not the last thing in the file']);
});

test('frontmatter must name the folder', () => {
	const dir = skills({ 'alpha/SKILL.md': good('gamma') });
	assert.deepEqual(lint(dir), ['alpha: frontmatter name is "gamma"']);
});

test('skill-incident is exempt from the block but not from frontmatter', () => {
	const dir = skills({ 'skill-incident/SKILL.md': '---\nname: skill-incident\ndescription: x\n---\n\nHandler.\n' });
	assert.deepEqual(lint(dir), []);
});

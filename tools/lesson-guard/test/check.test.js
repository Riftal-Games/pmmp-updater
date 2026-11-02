'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, isLesson, isProtected, parseNameStatus } = require('../check');
const fx = require('../../test-support/fixtures');

const CHECK = path.join(__dirname, '..', 'check.js');
const z = (...pairs) => pairs.map(([s, p]) => `${s}\0${p}\0`).join('');

test('an ordinary lesson passes', () => {
	const changes = parseNameStatus(z(['M', '.claude/skills/docs-diff/SKILL.md'], ['M', 'tools/docs-diff/diff.js'], ['A', 'tools/docs-diff/test/new.test.js'], ['M', 'docs/lessons.md'], ['A', 'docs/incidents/2026-11-02-x.md']));
	assert.deepEqual(check(changes), []);
});

test('NUL-separated paths keep spaces and non-ASCII characters exact', () => {
	assert.deepEqual(parseNameStatus(z(['A', '.github/workflows/évil.yml'], ['M', 'tools/my x.test.js'])), [
		{ status: 'A', path: '.github/workflows/évil.yml' },
		{ status: 'M', path: 'tools/my x.test.js' },
	]);
});

test('protected paths are refused in any letter case', () => {
	const paths = [
		'CLAUDE.md', 'tools/CLAUDE.md', 'CLAUDE.local.md', '.gitattributes', 'tools/x/.gitattributes', '.gitignore',
		'.mcp.json', '.claude/settings.json', '.Claude/Settings.json', '.claude/hooks/guard.py', '.claude/agents/reviewer.md',
		'.claude/commands/x.md', '.claude/skills/skill-incident/SKILL.md', '.claude/skills/Skill-Incident/SKILL.md',
		'.claude/skills/FAILURE-BLOCK.md', 'tools/skills-lint/lint.js', 'tools/lesson-guard/check.js',
		'tools/test-support/fixtures.js', '.github/workflows/ci.yml', '.github/workflows/évil.yml', 'packages/bedrock-data/README.md',
	];
	for (const p of paths) assert.ok(isProtected(p), p);
	assert.ok(!isProtected('.claude/skills/docs-diff/SKILL.md'));
	assert.ok(!isProtected('tools/docs-diff/diff.js'));
});

test('deleting any file is refused', () => {
	assert.deepEqual(check(parseNameStatus(z(['D', 'tools/docs-diff/test/fixture.json']))), ['tools/docs-diff/test/fixture.json: deleted, which a lesson may not do']);
});

test('any change to an existing test file is refused, in any status but A', () => {
	for (const status of ['M', 'T']) {
		assert.deepEqual(check([{ status, path: 'tools/x/test/x.test.js' }]), ['tools/x/test/x.test.js: changes an existing test file; a lesson adds tests in new files only']);
	}
	assert.deepEqual(check([{ status: 'A', path: 'tools/x/test/new.test.js' }]), []);
});

test('lessons are recognised by branch, label or the files they touch, in any case', () => {
	const none = [{ status: 'M', path: 'tools/docs-diff/diff.js' }];
	assert.ok(isLesson({ branch: 'updater/9-lesson-x', labels: [], changes: none }));
	assert.ok(isLesson({ branch: 'updater/9-Lesson-x', labels: [], changes: none }));
	assert.ok(isLesson({ branch: 'updater/9-x', labels: ['Lesson'], changes: none }));
	assert.ok(isLesson({ branch: 'updater/9-x', labels: [], changes: [{ status: 'M', path: 'docs/lessons.md' }] }));
	assert.ok(isLesson({ branch: 'x', labels: [], changes: [{ status: 'A', path: 'docs/incidents/2026-11-02-x.md' }] }));
	assert.ok(!isLesson({ branch: 'bedrock-1.26.70', labels: ['prep'], changes: none }));
});

function repoWith(files) {
	const dir = fx.tempDir('guard');
	const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'test@example.invalid');
	git('config', 'user.name', 'test');
	git('config', 'core.autocrlf', 'false');
	fx.writeTree(dir, files);
	fx.writeTree(dir, { '.gitignore': '!CLAUDE.md\n!.claude/\n' });
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	git('switch', '-q', '-c', 'updater/9-lesson-x');
	return { dir, git };
}

function runGuard(dir) {
	try {
		execFileSync('node', [CHECK, '--base', 'main', '--head', 'HEAD', '--branch', 'updater/9-lesson-x'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
		return { code: 0, err: '' };
	} catch (e) {
		return { code: e.status, err: e.stderr };
	}
}

const EXISTING_TEST = { 'tools/x/test/x.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('a', () => {\n\tassert.ok(true);\n});\n" };

test('a rename that moves a protected file away is caught end to end', () => {
	const { dir, git } = repoWith({ 'CLAUDE.md': 'rules\n', 'docs/lessons.md': '# Lessons\n' });
	git('mv', 'CLAUDE.md', 'docs/old-instructions.md');
	fs.appendFileSync(path.join(dir, 'docs', 'lessons.md'), '- a lesson\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'move');
	const r = runGuard(dir);
	assert.equal(r.code, 1);
	assert.match(r.err, /CLAUDE\.md: protected path/);
	assert.match(r.err, /CLAUDE\.md: deleted/);
});

test('a protected path with a non-ASCII name is caught end to end', () => {
	const { dir, git } = repoWith({ 'README.md': 'x\n' });
	fx.writeTree(dir, { '.github/workflows/évil.yml': 'on: push\n' });
	git('add', '-A');
	git('commit', '-q', '-m', 'workflow');
	const r = runGuard(dir);
	assert.equal(r.code, 1);
	assert.match(r.err, /\.github\/workflows\/évil\.yml: protected path/);
});

for (const [name, body] of [
	['an emptied test runner', "const test = () => {};\ntest('a', () => {});\n"],
	['an early return', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('a', () => {\n\tif (true) return;\n\tassert.ok(true);\n});\n"],
	['commented-out assertions', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('a', () => {\n/*\n\tassert.ok(true);\n*/\n});\n"],
	['a NUL byte that makes git treat the file as binary', "const test = require('node:test');\ntest('a', () => {});\n// \0\n"],
]) {
	test(`${name} in an existing test file is caught end to end`, () => {
		const { dir, git } = repoWith(EXISTING_TEST);
		fs.writeFileSync(path.join(dir, 'tools/x/test/x.test.js'), body);
		git('commit', '-q', '-am', name);
		const r = runGuard(dir);
		assert.equal(r.code, 1);
		assert.match(r.err, /x\.test\.js: changes an existing test file/);
	});
}

test('a new test file in a lesson passes end to end', () => {
	const { dir, git } = repoWith({ ...EXISTING_TEST, 'docs/lessons.md': '# Lessons\n' });
	fx.writeTree(dir, { 'tools/x/test/regression.test.js': "const test = require('node:test');\ntest('b', () => {});\n" });
	fs.appendFileSync(path.join(dir, 'docs', 'lessons.md'), '- a lesson\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'lesson');
	assert.deepEqual(runGuard(dir), { code: 0, err: '' });
});

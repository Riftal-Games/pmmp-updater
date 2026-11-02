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

test('a PR that is not a lesson is refused for protected paths other than packages/', () => {
	const changes = [
		{ status: 'M', path: 'tools/lesson-guard/check.js' },
		{ status: 'M', path: '.claude/skills/Skill-Incident/SKILL.md' },
		{ status: 'M', path: 'packages/bedrock-protocol/src/ProtocolInfo.php' },
		{ status: 'D', path: 'packages/bedrock-data/old.json' },
		{ status: 'M', path: 'tools/x/test/x.test.js' },
		{ status: 'D', path: 'tools/x/test/fixture.json' },
	];
	assert.deepEqual(check(changes, { lesson: false }), [
		'tools/lesson-guard/check.js: protected path, needs a steward merge',
		'.claude/skills/Skill-Incident/SKILL.md: protected path, needs a steward merge',
	]);
	assert.ok(!isProtected('packages/bedrock-data/README.md', { lesson: false }));
	assert.ok(isProtected('.github/workflows/ci.yml', { lesson: false }));
});

test('any change to an existing file under a test/ directory is refused in a lesson', () => {
	for (const p of ['tools/x/test/helpers.js', 'tools/x/test/fixtures/schema.json', 'tools/x/Test/data.bin', 'test/top.js']) {
		assert.deepEqual(check([{ status: 'M', path: p }]), [`${p}: changes an existing test file; a lesson adds tests in new files only`], p);
	}
	assert.deepEqual(check([{ status: 'A', path: 'tools/x/test/fixtures/new.json' }]), []);
	assert.deepEqual(check([{ status: 'M', path: 'tools/latest/x.js' }, { status: 'M', path: 'tools/x/testing.js' }]), []);
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

function guard(dir, branch) {
	try {
		const out = execFileSync('node', [CHECK, '--base', 'main', '--head', 'HEAD', '--branch', branch], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
		return { code: 0, out, err: '' };
	} catch (e) {
		return { code: e.status, out: e.stdout, err: e.stderr };
	}
}

function runGuard(dir) {
	const { code, err } = guard(dir, 'updater/9-lesson-x');
	return { code, err };
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

test('a PR that is not a lesson and rewrites the guard is refused end to end, naming the steward', () => {
	const { dir, git } = repoWith({ 'tools/lesson-guard/check.js': 'process.exit(1);\n' });
	fs.writeFileSync(path.join(dir, 'tools/lesson-guard/check.js'), 'process.exit(0);\n');
	git('commit', '-q', '-am', 'guard');
	const r = guard(dir, 'updater/10-tidy');
	assert.equal(r.code, 1);
	assert.match(r.err, /tools\/lesson-guard\/check\.js: protected path, needs a steward merge/);
	assert.match(r.out, /needs a steward merge/);
});

test('a version run that changes packages/ and existing tests passes end to end', () => {
	const { dir, git } = repoWith({ ...EXISTING_TEST, 'packages/bedrock-protocol/src/ProtocolInfo.php': '<?php\n', 'packages/bedrock-data/old.json': '{}\n' });
	fs.writeFileSync(path.join(dir, 'packages/bedrock-protocol/src/ProtocolInfo.php'), '<?php\n// 2225\n');
	fs.writeFileSync(path.join(dir, 'tools/x/test/x.test.js'), "const test = require('node:test');\ntest('a', () => {});\n");
	git('rm', '-q', 'packages/bedrock-data/old.json');
	git('commit', '-q', '-am', 'version');
	const r = guard(dir, 'bedrock-1.26.70');
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /Not a lesson PR, and it touches no protected path/);
});

test('a weakened fixture under test/ in a lesson is caught end to end', () => {
	const { dir, git } = repoWith({ 'tools/x/test/fixtures/schema.json': '{"id": 7}\n', 'docs/lessons.md': '# Lessons\n' });
	fs.writeFileSync(path.join(dir, 'tools/x/test/fixtures/schema.json'), '{}\n');
	fs.appendFileSync(path.join(dir, 'docs', 'lessons.md'), '- a lesson\n');
	git('commit', '-q', '-am', 'lesson');
	const r = runGuard(dir);
	assert.equal(r.code, 1);
	assert.match(r.err, /tools\/x\/test\/fixtures\/schema\.json: changes an existing test file/);
});

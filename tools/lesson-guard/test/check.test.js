'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, isLesson, isProtected, parseNameStatus, parseFileDiff } = require('../check');
const fx = require('../../test-support/fixtures');

const CHECK = path.join(__dirname, '..', 'check.js');
const z = (...pairs) => pairs.map(([s, p]) => `${s}\0${p}\0`).join('');

test('an ordinary lesson passes', () => {
	const changes = parseNameStatus(z(['M', '.claude/skills/docs-diff/SKILL.md'], ['M', 'tools/docs-diff/diff.js'], ['A', 'tools/docs-diff/test/new.test.js'], ['M', 'docs/lessons.md'], ['A', 'docs/incidents/2026-11-02-x.md']));
	assert.deepEqual(check(changes, [], []), []);
});

test('NUL-separated paths keep spaces and non-ASCII characters exact', () => {
	assert.deepEqual(parseNameStatus(z(['A', '.github/workflows/évil.yml'], ['M', 'tools/my x.test.js'])), [
		{ status: 'A', path: '.github/workflows/évil.yml' },
		{ status: 'M', path: 'tools/my x.test.js' },
	]);
});

test('protected paths are refused in any letter case', () => {
	const paths = [
		'CLAUDE.md', 'tools/CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.claude/settings.json', '.Claude/Settings.json',
		'.claude/hooks/guard.py', '.claude/agents/reviewer.md', '.claude/commands/x.md',
		'.claude/skills/skill-incident/SKILL.md', '.claude/skills/Skill-Incident/SKILL.md', '.claude/skills/FAILURE-BLOCK.md',
		'tools/skills-lint/lint.js', 'tools/lesson-guard/check.js', 'tools/test-support/fixtures.js',
		'.github/workflows/ci.yml', '.github/workflows/évil.yml', 'packages/bedrock-data/README.md',
	];
	for (const p of paths) assert.ok(isProtected(p), p);
	assert.ok(!isProtected('.claude/skills/docs-diff/SKILL.md'));
	assert.ok(!isProtected('tools/docs-diff/diff.js'));
});

test('deleting any file is refused', () => {
	assert.deepEqual(check(parseNameStatus(z(['D', 'tools/docs-diff/test/fixture.json'])), [], []), ['tools/docs-diff/test/fixture.json: deleted, which a lesson may not do']);
});

test('removing a test, an assertion or the runner import is refused', () => {
	const diff = [
		'--- a/tools/x/test/x.test.js',
		'+++ b/tools/x/test/x.test.js',
		'@@ -1,4 +0,0 @@',
		"-const test = require('node:test');",
		"-test('old behaviour holds', () => {",
		'-\tassert.equal(1, 1);',
		'-\tconst unrelated = 1;',
	].join('\n');
	const { removed } = parseFileDiff('tools/x/test/x.test.js', diff);
	const problems = check([{ status: 'M', path: 'tools/x/test/x.test.js' }], removed, []);
	assert.deepEqual(problems.map((p) => p.split(': ')[1]), ['removes the test runner import', 'removes a test', 'removes or changes an assertion']);
});

test('a content line beginning with -- is content, not a header', () => {
	const { removed } = parseFileDiff('t.test.js', '--- a/t.test.js\n+++ b/t.test.js\n@@ -1 +0,0 @@\n--- assert.ok(x);');
	assert.deepEqual(removed, [{ path: 't.test.js', line: '-- assert.ok(x);' }]);
});

test('short-circuiting an existing test file is refused, a new file may skip itself', () => {
	const added = [
		{ path: 'tools/x/test/x.test.js', line: '\treturn;' },
		{ path: 'tools/x/test/x.test.js', line: "test.skip('a', () => {});" },
		{ path: 'tools/x/test/x.test.js', line: "test('b', { skip: true }, () => {});" },
		{ path: 'tools/x/test/x.test.js', line: '\tprocess.exit(0);' },
		{ path: 'tools/x/test/x.test.js', line: 'assert.equal = () => {};' },
		{ path: 'tools/y/test/new.test.js', line: "test('live', { skip: !process.env.RIFTAL_LIVE }, () => {});" },
	];
	const changes = [{ status: 'M', path: 'tools/x/test/x.test.js' }, { status: 'A', path: 'tools/y/test/new.test.js' }];
	const problems = check(changes, [], added);
	assert.equal(problems.length, 5);
	assert.ok(problems.every((p) => p.startsWith('tools/x/test/x.test.js')));
	assert.deepEqual(check(changes, [], [{ path: 'tools/x/test/x.test.js', line: '\tassert.equal(a === b, true);' }]), []);
});

test('lessons are recognised by branch, label or the files they touch', () => {
	const none = [{ status: 'M', path: 'tools/docs-diff/diff.js' }];
	assert.ok(isLesson({ branch: 'updater/9-lesson-x', labels: [], changes: none }));
	assert.ok(isLesson({ branch: 'updater/9-x', labels: ['lesson'], changes: none }));
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

test('an emptied test runner is caught end to end', () => {
	const { dir, git } = repoWith({ 'tools/x/test/x.test.js': "const test = require('node:test');\ntest('a', () => {});\n" });
	fs.writeFileSync(path.join(dir, 'tools/x/test/x.test.js'), "const test = () => {};\ntest('a', () => {});\n");
	git('commit', '-q', '-am', 'vacuous');
	const r = runGuard(dir);
	assert.equal(r.code, 1);
	assert.match(r.err, /removes the test runner import/);
});

test('an early return in a test file with a space in its name is caught end to end', () => {
	const { dir, git } = repoWith({ 'tools/x/test/my x.test.js': "test('a', () => {\n\tassert.ok(true);\n});\n" });
	fs.writeFileSync(path.join(dir, 'tools/x/test/my x.test.js'), "test('a', () => {\n\treturn;\n\tassert.ok(true);\n});\n");
	git('commit', '-q', '-am', 'short-circuit');
	const r = runGuard(dir);
	assert.equal(r.code, 1);
	assert.match(r.err, /my x\.test\.js: adds an early return/);
});

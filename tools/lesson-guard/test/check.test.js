'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, isLesson, isProtected, parseNameStatus, parseRemovedLines } = require('../check');
const fx = require('../../test-support/fixtures');

const CHECK = path.join(__dirname, '..', 'check.js');

test('an ordinary lesson passes', () => {
	const changes = parseNameStatus('M\t.claude/skills/docs-diff/SKILL.md\nM\ttools/docs-diff/diff.js\nA\ttools/docs-diff/test/new.test.js\nM\tdocs/lessons.md\nA\tdocs/incidents/2026-11-02-x.md');
	assert.deepEqual(check(changes, []), []);
});

test('protected paths are refused in any letter case', () => {
	const paths = [
		'CLAUDE.md', 'tools/CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.claude/settings.json', '.Claude/Settings.json',
		'.claude/hooks/guard.py', '.claude/agents/reviewer.md', '.claude/commands/x.md',
		'.claude/skills/skill-incident/SKILL.md', '.claude/skills/Skill-Incident/SKILL.md', '.claude/skills/FAILURE-BLOCK.md',
		'tools/skills-lint/lint.js', 'tools/lesson-guard/check.js', 'tools/test-support/fixtures.js',
		'.github/workflows/ci.yml', 'packages/bedrock-data/README.md',
	];
	for (const p of paths) assert.ok(isProtected(p), p);
	assert.ok(!isProtected('.claude/skills/docs-diff/SKILL.md'));
	assert.ok(!isProtected('tools/docs-diff/diff.js'));
});

test('deleting any file is refused', () => {
	assert.deepEqual(check(parseNameStatus('D\ttools/docs-diff/test/fixture.json'), []), ['tools/docs-diff/test/fixture.json: deleted, which a lesson may not do']);
});

test('removing a test, an assertion or the runner import is refused', () => {
	const diff = [
		'--- a/tools/x/test/x.test.js',
		'+++ b/tools/x/test/x.test.js',
		"-const test = require('node:test');",
		"-test('old behaviour holds', () => {",
		'-\tassert.equal(1, 1);',
		'-\tconst unrelated = 1;',
	].join('\n');
	const problems = check([], parseRemovedLines(diff));
	assert.deepEqual(problems.map((p) => p.split(': ')[1]), ['removes the test runner import', 'removes a test', 'removes or changes an assertion']);
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

test('an emptied test runner is caught end to end', () => {
	const { dir, git } = repoWith({ 'tools/x/test/x.test.js': "const test = require('node:test');\ntest('a', () => {});\n" });
	fs.writeFileSync(path.join(dir, 'tools/x/test/x.test.js'), "const test = () => {};\ntest('a', () => {});\n");
	git('commit', '-q', '-am', 'vacuous');
	const r = runGuard(dir);
	assert.equal(r.code, 1);
	assert.match(r.err, /removes the test runner import/);
});

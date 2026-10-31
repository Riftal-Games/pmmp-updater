'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { check, parseNameStatus, parseRemovedLines } = require('../check');

test('an ordinary lesson passes', () => {
	const changes = parseNameStatus('M\t.claude/skills/docs-diff/SKILL.md\nM\ttools/docs-diff/diff.js\nA\ttools/docs-diff/test/new.test.js\nM\tdocs/lessons.md\nA\tdocs/incidents/2026-11-02-x.md');
	assert.deepEqual(check(changes, []), []);
});

test('protected paths are refused', () => {
	const paths = [
		'CLAUDE.md', 'tools/CLAUDE.md', '.claude/settings.json', '.claude/hooks/guard.py', '.claude/agents/reviewer.md',
		'.claude/skills/skill-incident/SKILL.md', '.claude/skills/FAILURE-BLOCK.md', 'tools/skills-lint/lint.js',
		'tools/lesson-guard/check.js', '.github/workflows/ci.yml', 'packages/bedrock-data/README.md',
	];
	const problems = check(paths.map((p) => ({ status: 'M', path: p })), []);
	assert.equal(problems.length, paths.length);
	assert.ok(problems.every((p) => p.endsWith('protected path, a steward decision')));
});

test('deleting any file is refused', () => {
	assert.deepEqual(check(parseNameStatus('D\ttools/docs-diff/test/fixture.json'), []), ['tools/docs-diff/test/fixture.json: deleted, which a lesson may not do']);
});

test('a rename reports the new path', () => {
	assert.deepEqual(parseNameStatus('R100\ttools/a.js\ttools/b.js'), [{ status: 'R', path: 'tools/b.js' }]);
});

test('removing a test declaration is refused, editing its body is not', () => {
	const diff = [
		'diff --git a/tools/x/test/x.test.js b/tools/x/test/x.test.js',
		'--- a/tools/x/test/x.test.js',
		'+++ b/tools/x/test/x.test.js',
		"-test('old behaviour holds', () => {",
		'-\tassert.equal(1, 1);',
		'+\tassert.equal(2, 2);',
	].join('\n');
	const removed = parseRemovedLines(diff);
	assert.deepEqual(check([], removed), ["tools/x/test/x.test.js: removes a test: test('old behaviour holds', () => {"]);
});

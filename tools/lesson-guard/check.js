#!/usr/bin/env node
'use strict';

// Fails a lesson PR that reaches past what /skill-incident allows: a protected path, a
// deleted or renamed-away file, or any change to a test file that already existed.
// Lessons add tests only in new files, so no reading of a diff is needed to tell
// whether an existing test was weakened. CI runs the copy of this file on the base
// branch, from a pull_request_target workflow, so a PR cannot change the guard that
// judges it. It reads only the list of changed paths and never runs PR code.
//
// Usage: node tools/lesson-guard/check.js --base <ref> --head <ref> [--branch <name>] [--labels <a,b>]

const { execFileSync } = require('child_process');

const PROTECTED = [
	/(^|\/)claude(\.local)?\.md$/,
	/(^|\/)\.gitattributes$/,
	/(^|\/)\.gitignore$/,
	/^\.mcp\.json$/,
	/^\.claude\/settings(\.local)?\.json$/,
	/^\.claude\/hooks\//,
	/^\.claude\/agents\//,
	/^\.claude\/commands\//,
	/^\.claude\/skills\/skill-incident\//,
	/^\.claude\/skills\/failure-block\.md$/,
	/^tools\/skills-lint\//,
	/^tools\/lesson-guard\//,
	/^tools\/test-support\//,
	/^\.github\//,
	/^packages\//,
];

const TEST_FILE = /\.test\.js$/i;

// Paths are compared lowercased, because a Windows checkout treats .Claude and .claude
// as the same folder.
function isProtected(path) {
	const p = path.toLowerCase();
	return PROTECTED.some((re) => re.test(p));
}

function isLesson({ branch, labels, changes }) {
	if (branch && branch.toLowerCase().includes('-lesson-')) return true;
	if (labels && labels.some((l) => l.toLowerCase() === 'lesson')) return true;
	return changes.some(({ path }) => /^docs\/(lessons\.md|incidents\/)/i.test(path));
}

function check(changes) {
	const problems = [];
	for (const { status, path } of changes) {
		if (isProtected(path)) problems.push(`${path}: protected path, a steward decision`);
		if (status === 'D') problems.push(`${path}: deleted, which a lesson may not do`);
		else if (status !== 'A' && TEST_FILE.test(path)) problems.push(`${path}: changes an existing test file; a lesson adds tests in new files only`);
	}
	return problems;
}

// Parses `git diff --name-status -z --no-renames`. NUL separation keeps paths with
// spaces or non-ASCII characters exact, where the line format would quote them. Without
// renames, a rename arrives as a deletion of the old path plus an addition of the new
// one, and both are judged.
function parseNameStatus(text) {
	const fields = text.split('\0');
	const out = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		if (!fields[i]) break;
		out.push({ status: fields[i][0], path: fields[i + 1] });
	}
	return out;
}

function parseArgs(argv) {
	const a = {};
	for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
	return a;
}

if (require.main === module) {
	const args = parseArgs(process.argv.slice(2));
	if (!args.base || !args.head) {
		process.stderr.write('usage: check.js --base <ref> --head <ref> [--branch <name>] [--labels <a,b>]\n');
		process.exit(2);
	}
	const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', `${args.base}...${args.head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const changes = parseNameStatus(out);
	const labels = (args.labels || '').split(',').map((s) => s.trim()).filter(Boolean);
	if (!isLesson({ branch: args.branch, labels, changes })) {
		process.stdout.write('Not a lesson PR: no -lesson- branch, no lesson label, no change under docs/lessons.md or docs/incidents/.\n');
		process.exit(0);
	}
	const problems = check(changes);
	for (const p of problems) process.stderr.write(`${p}\n`);
	process.stdout.write(problems.length ? `Lesson bounds: ${problems.length} problem(s).\n` : 'Lesson bounds hold.\n');
	process.exit(problems.length ? 1 : 0);
}

module.exports = { check, isLesson, isProtected, parseNameStatus, PROTECTED };

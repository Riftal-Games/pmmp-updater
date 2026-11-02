#!/usr/bin/env node
'use strict';

// Judges a lesson PR against what /skill-incident allows, and fails it for reaching
// past that: a protected path, packages/, a deleted or renamed-away file, or any change
// to a file that already existed as a *.test.js or under a test/ directory, which holds
// the helpers and fixtures tests depend on. Lessons add tests and fixtures only in new
// files, so no reading of a diff is needed to tell whether an existing one was weakened.
//
// Every other PR passes. Each protected path it touches is printed as a GitHub Actions
// notice that the PR needs a steward merge. Nothing under packages/ is flagged, because
// version runs change it. The check does not fail such a PR, because the steward merges
// only on fully green CI. What keeps the PR out of the approver's lane is the approver's
// own gated-path list.
//
// CI runs the copy of this file on the base branch, from a pull_request_target
// workflow, so a PR cannot change the guard that judges it. It reads only the list of
// changed paths and never runs PR code.
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
];

const LESSON_PROTECTED = [/^packages\//];

const TEST_FILE = /(^|\/)test\/|\.test\.js$/i;

// Paths are compared lowercased, because a Windows checkout treats .Claude and .claude
// as the same folder. Outside a lesson nothing under packages/ is protected, not even a
// package's own .gitattributes or .gitignore, because a version run imports them.
function isProtected(path, { lesson = true } = {}) {
	const p = path.toLowerCase();
	if (LESSON_PROTECTED.some((re) => re.test(p))) return lesson;
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

function stewardPaths(changes) {
	return changes.map(({ path }) => path).filter((path) => isProtected(path, { lesson: false }));
}

// A workflow command ends at a newline, so a path is escaped the way GitHub Actions
// expects or a file name could start a command of its own.
function notice(path) {
	const msg = `${path}: steward path, this PR needs a steward merge`;
	return `::notice::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
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
	if (isLesson({ branch: args.branch, labels, changes })) {
		const problems = check(changes);
		for (const p of problems) process.stderr.write(`${p}\n`);
		process.stdout.write(problems.length ? `Lesson bounds: ${problems.length} problem(s).\n` : 'Lesson bounds hold.\n');
		process.exit(problems.length ? 1 : 0);
	}
	const paths = stewardPaths(changes);
	for (const p of paths) process.stdout.write(`${notice(p)}\n`);
	process.stdout.write(paths.length ? `Not a lesson PR. It touches ${paths.length} steward path(s), so it needs a steward merge; this check does not block it.\n` : 'Not a lesson PR, and it touches no steward path.\n');
	process.exit(0);
}

module.exports = { check, isLesson, isProtected, notice, parseNameStatus, stewardPaths, PROTECTED, LESSON_PROTECTED };

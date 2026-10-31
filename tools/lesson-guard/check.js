#!/usr/bin/env node
'use strict';

// Fails a lesson PR that reaches past what /skill-incident allows: a protected path, a
// deleted or renamed-away file, a removed test, or a weakened assertion. CI runs the
// copy of this file on the base branch, from a pull_request_target workflow, so a PR
// cannot change the guard that judges it. It reads the diff and never runs PR code.
//
// Usage: node tools/lesson-guard/check.js --base <ref> --head <ref> [--branch <name>] [--labels <a,b>]

const { execFileSync } = require('child_process');

const PROTECTED = [
	/(^|\/)claude(\.local)?\.md$/,
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
const WEAKENING = [
	{ re: /^\s*test\(/, what: 'removes a test' },
	{ re: /\bassert\b/, what: 'removes or changes an assertion' },
	{ re: /require\(['"]node:test['"]\)/, what: 'removes the test runner import' },
];

// Paths are compared lowercased, because a Windows checkout treats .Claude and .claude
// as the same folder.
function isProtected(path) {
	const p = path.toLowerCase();
	return PROTECTED.some((re) => re.test(p));
}

function isLesson({ branch, labels, changes }) {
	if (branch && branch.includes('-lesson-')) return true;
	if (labels && labels.includes('lesson')) return true;
	return changes.some(({ path }) => /^docs\/(lessons\.md|incidents\/)/i.test(path));
}

function check(changes, removedLines) {
	const problems = [];
	for (const { status, path } of changes) {
		if (isProtected(path)) problems.push(`${path}: protected path, a steward decision`);
		if (status === 'D') problems.push(`${path}: deleted, which a lesson may not do`);
	}
	for (const { path, line } of removedLines) {
		if (!TEST_FILE.test(path)) continue;
		const hit = WEAKENING.find((w) => w.re.test(line));
		if (hit) problems.push(`${path}: ${hit.what}: ${line.trim()}`);
	}
	return problems;
}

// Run with --no-renames, so a rename arrives as a deletion of the old path plus an
// addition of the new one, and both are judged.
function parseNameStatus(text) {
	return text.split(/\r?\n/).filter(Boolean).map((l) => {
		const parts = l.split('\t');
		return { status: parts[0][0], path: parts[parts.length - 1] };
	});
}

function parseRemovedLines(diff) {
	const out = [];
	let file = null;
	for (const line of diff.split(/\r?\n/)) {
		const m = /^--- a\/(.*)$/.exec(line);
		if (m) file = m[1];
		else if (line.startsWith('--- ')) file = null;
		else if (line.startsWith('-') && !line.startsWith('---') && file) out.push({ path: file, line: line.slice(1) });
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
	const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const range = `${args.base}...${args.head}`;
	const changes = parseNameStatus(git('diff', '--name-status', '--no-renames', range));
	const labels = (args.labels || '').split(',').map((s) => s.trim()).filter(Boolean);
	if (!isLesson({ branch: args.branch, labels, changes })) {
		process.stdout.write('Not a lesson PR: no -lesson- branch, no lesson label, no change under docs/lessons.md or docs/incidents/.\n');
		process.exit(0);
	}
	const removed = parseRemovedLines(git('diff', '--no-renames', '--unified=0', range));
	const problems = check(changes, removed);
	for (const p of problems) process.stderr.write(`${p}\n`);
	process.stdout.write(problems.length ? `Lesson bounds: ${problems.length} problem(s).\n` : 'Lesson bounds hold.\n');
	process.exit(problems.length ? 1 : 0);
}

module.exports = { check, isLesson, isProtected, parseNameStatus, parseRemovedLines, PROTECTED };

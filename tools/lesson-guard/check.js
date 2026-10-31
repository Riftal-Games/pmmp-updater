#!/usr/bin/env node
'use strict';

// Fails a lesson PR that reaches past what /skill-incident allows: a protected path, a
// deleted file, or a removed test. Run by CI on branches named *-lesson-*.
//
// Usage: node tools/lesson-guard/check.js <base ref>

const { execFileSync } = require('child_process');

const PROTECTED = [
	/(^|\/)CLAUDE\.md$/,
	/^\.claude\/settings(\.local)?\.json$/,
	/^\.claude\/hooks\//,
	/^\.claude\/agents\//,
	/^\.claude\/skills\/skill-incident\//,
	/^\.claude\/skills\/FAILURE-BLOCK\.md$/,
	/^tools\/skills-lint\//,
	/^tools\/lesson-guard\//,
	/^\.github\//,
	/^packages\//,
];

const TEST_DECLARATION = /^\s*test\(/;

function check(changes, removedLines) {
	const problems = [];
	for (const { status, path } of changes) {
		if (PROTECTED.some((re) => re.test(path))) problems.push(`${path}: protected path, a steward decision`);
		if (status === 'D') problems.push(`${path}: deleted, which a lesson may not do`);
	}
	for (const { path, line } of removedLines) {
		if (/\.test\.js$/.test(path) && TEST_DECLARATION.test(line)) problems.push(`${path}: removes a test: ${line.trim()}`);
	}
	return problems;
}

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
		else if (line.startsWith('-') && !line.startsWith('---') && file) out.push({ path: file, line: line.slice(1) });
	}
	return out;
}

if (require.main === module) {
	const base = process.argv[2];
	if (!base) {
		process.stderr.write('usage: check.js <base ref>\n');
		process.exit(2);
	}
	const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const changes = parseNameStatus(git('diff', '--name-status', '--find-renames', `${base}...HEAD`));
	const removed = parseRemovedLines(git('diff', '--unified=0', `${base}...HEAD`, '--', '*.test.js'));
	const problems = check(changes, removed);
	for (const p of problems) process.stderr.write(`${p}\n`);
	process.exit(problems.length ? 1 : 0);
}

module.exports = { check, parseNameStatus, parseRemovedLines, PROTECTED };

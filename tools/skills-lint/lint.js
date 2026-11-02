#!/usr/bin/env node
'use strict';

// Checks every skill under .claude/skills: frontmatter names the skill after its folder
// and carries a description, and the body ends with the shared failure block exactly as
// FAILURE-BLOCK.md defines it. skill-incident is the handler itself and is exempt from
// the block.

const fs = require('fs');
const path = require('path');

const EXEMPT = new Set(['skill-incident']);
const START = '<!-- failure-block:start -->';
const END = '<!-- failure-block:end -->';

function block(text) {
	const s = text.indexOf(START);
	const e = text.indexOf(END);
	return s === -1 || e === -1 || e < s ? null : text.slice(s, e + END.length).replace(/\r\n/g, '\n');
}

function frontmatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return null;
	const out = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([a-z_-]+):\s*(.*)$/.exec(line);
		if (kv) out[kv[1]] = kv[2];
	}
	return out;
}

function lint(skillsDir) {
	const canonical = block(fs.readFileSync(path.join(skillsDir, 'FAILURE-BLOCK.md'), 'utf8'));
	if (!canonical) return [`${path.join(skillsDir, 'FAILURE-BLOCK.md')}: no failure block markers`];
	const problems = [];
	for (const name of fs.readdirSync(skillsDir).filter((n) => fs.statSync(path.join(skillsDir, n)).isDirectory()).sort()) {
		const file = path.join(skillsDir, name, 'SKILL.md');
		if (!fs.existsSync(file)) {
			problems.push(`${name}: no SKILL.md`);
			continue;
		}
		const text = fs.readFileSync(file, 'utf8');
		const fm = frontmatter(text);
		if (!fm) problems.push(`${name}: no frontmatter`);
		else {
			if (fm.name !== name) problems.push(`${name}: frontmatter name is "${fm.name}"`);
			if (!fm.description) problems.push(`${name}: frontmatter has no description`);
		}
		if (EXEMPT.has(name)) continue;
		const b = block(text);
		if (!b) problems.push(`${name}: missing the shared failure block`);
		else if (b !== canonical) problems.push(`${name}: failure block differs from FAILURE-BLOCK.md`);
		else if (text.replace(/\r\n/g, '\n').trimEnd().slice(-END.length) !== END) problems.push(`${name}: failure block is not the last thing in the file`);
	}
	return problems;
}

if (require.main === module) {
	const dir = process.argv[2] || path.join(__dirname, '..', '..', '.claude', 'skills');
	const problems = lint(dir);
	for (const p of problems) process.stderr.write(`${p}\n`);
	process.exit(problems.length ? 1 : 0);
}

module.exports = { lint, block, frontmatter };

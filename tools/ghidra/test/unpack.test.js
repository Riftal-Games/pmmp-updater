'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('../../test-support/fixtures');

const SCRIPT = path.join(__dirname, '..', 'unpack.sh');
const unix = { skip: process.platform === 'win32' && 'unpack.sh needs bash and coreutils' };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const HEADLESS = 'support/analyzeHeadless';
const DECOMPILE = 'Ghidra/Features/Decompiler/os/linux_x86_64/decompile';

// Stands in for tools/bds/unzip.js: writes the tree FAKE_UNZIP names under one top
// directory, with the modes it gives, and reports the entry count it gives.
const FAKE_UNZIP = `const fs = require('fs');
const path = require('path');
const { count, files } = JSON.parse(process.env.FAKE_UNZIP);
for (const [rel, [mode, body]] of Object.entries(files)) {
	const f = path.join(process.argv[3], 'ghidra_0.0_PUBLIC', rel);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, body);
	fs.chmodSync(f, mode);
}
console.log(\`unzipped \${count} entries from \${path.basename(process.argv[2])}\`);
`;

// A fixture tree laid out as the unpack container's / is, with real tarballs whose Node
// is a shell stand-in for the real one.
function unpack(fake, { tamper = false } = {}) {
	const root = fx.tempDir('ghidra-unpack');
	fx.writeTree(root, { 'src/n/bin/node': `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 'src/j/bin/java': '', 'bdstool/unzip.js': FAKE_UNZIP, 'dist/g.zip': 'zip', 'staging/.keep': '' });
	fs.chmodSync(path.join(root, 'src/n/bin/node'), 0o755);
	fs.mkdirSync(path.join(root, 'node'));
	for (const [out, top] of [['node/n.tar.gz', 'n'], ['dist/j.tar.gz', 'j']]) assert.equal(spawnSync('tar', ['-czf', path.join(root, out), '-C', path.join(root, 'src'), top]).status, 0);
	fs.rmSync(path.join(root, 'staging/.keep'));
	const hashes = ['node/n.tar.gz', 'dist/j.tar.gz', 'dist/g.zip'].map((f) => sha(path.join(root, f)));
	if (tamper) hashes[1] = '0'.repeat(64);
	const args = [SCRIPT, 'n.tar.gz', hashes[0], 'j.tar.gz', hashes[1], 'g.zip', hashes[2]];
	const r = spawnSync('bash', args, { cwd: root, encoding: 'utf8', env: { ...process.env, FAKE_UNZIP: JSON.stringify(fake) } });
	return { ...r, root };
}

const tree = (headless = [0o755, '#MAXMEM=2G\n'], decompile = [0o755, '']) => ({ [HEADLESS]: headless, [DECOMPILE]: decompile, 'Ghidra/x.jar': [0o644, ''] });

test('a Ghidra tree whose only MAXMEM= is commented unpacks into staging', unix, () => {
	const r = unpack({ count: 4000, files: tree() });
	assert.equal(r.status, 0, r.stderr);
	for (const f of ['node/bin/node', 'jdk/bin/java', `ghidra/${HEADLESS}`, `ghidra/${DECOMPILE}`]) assert.ok(fs.existsSync(path.join(r.root, 'staging', f)), f);
	assert.ok(!fs.existsSync(path.join(r.root, 'staging/zip')));
	assert.match(r.stdout, /^unzipped 4000 entries from g\.zip$/m);
	assert.match(r.stdout, /^support\/analyzeHeadless -rwxr-xr-x$/m);
	assert.match(r.stdout, /has no uncommented MAXMEM= line\n$/);
});

test('unpack.sh refuses 65535 entries, a launcher or decompiler without the owner exec bit, an uncommented MAXMEM= and a wrong hash', unix, () => {
	const cases = [
		[{ count: 65535, files: tree() }, /65535 entries, at or over the 16-bit ceiling/],
		[{ count: 4000, files: tree([0o644, '']) }, /support\/analyzeHeadless has no owner exec bit/],
		[{ count: 4000, files: tree(undefined, [0o655, '']) }, /decompile has no owner exec bit/],
		[{ count: 4000, files: tree([0o755, 'MAXMEM=2G\n']) }, /sets MAXMEM itself/],
		[{ count: 4000, files: tree([0o755, '#MAXMEM=2G\n  MAXMEM=4G\n']) }, /sets MAXMEM itself/],
	];
	for (const [fake, re] of cases) {
		const r = unpack(fake);
		assert.notEqual(r.status, 0, JSON.stringify(fake));
		assert.match(r.stderr, re);
	}
	assert.notEqual(unpack({ count: 4000, files: tree() }, { tamper: true }).status, 0);
});

test('unpack.sh parses', unix, () => {
	assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
});

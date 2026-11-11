'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'run.sh');
const RUN = fs.readFileSync(SCRIPT, 'utf8');

test('run.sh refuses a node_modules Node would load before the locked packages, before it unpacks any', () => {
	const guard = RUN.indexOf('for d in /tool/node_modules /node_modules; do');
	assert.ok(guard > 0 && guard < RUN.indexOf('tar -xzf'));
	assert.match(RUN.slice(guard, RUN.indexOf('done', guard)), /if \[ -e "\$d" \]; then[\s\S]*exit 1/);
});

test('run.sh sets BDS and the tracer to the transport record.js names, with LAN visibility off', () => {
	assert.match(RUN, /^for kv in online-mode=false allow-list=false "transport=\$4" enable-lan-visibility=false; do$/m);
	assert.match(RUN, /tracer\.js --protocol-info \/proto\/protocol_info\.json --out \/out --transport "\$4"/);
});

test('run.sh parses', { skip: process.platform === 'win32' && 'bash -n needs a POSIX shell' }, () => {
	assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
});

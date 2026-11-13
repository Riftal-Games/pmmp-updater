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

test('run.sh sets BDS and the tracer to the transport record.js names, with LAN visibility off and hashed block network IDs', () => {
	assert.match(RUN, /^for kv in online-mode=false allow-list=false "transport=\$4" enable-lan-visibility=false block-network-ids-are-hashes=true; do$/m);
	assert.match(RUN, /tracer\.js --protocol-info \/proto\/protocol_info\.json --out \/out --transport "\$4"/);
});

test('run.sh, after Server started, dumps each socket with its peer, then stops BDS and exits 1 before the session on IPv6, an outside connect or an outside name', { skip: process.platform === 'win32' && 'bash needs a POSIX shell' }, () => {
	const p3 = (stub) => spawnSync('bash', ['-c', `set -euo pipefail; ${RUN.slice(RUN.indexOf('sockets() {'), RUN.indexOf('LD_LIBRARY_PATH'))}kill() { echo "kill $*"; }; grep() { [ "$*" = "-qx 1 /proc/sys/net/ipv6/conf/eth0/disable_ipv6" ]; }; timeout() { false; }; ${stub}\n${RUN.slice(RUN.indexOf('sockets "after Server started"'), RUN.indexOf('status=0'))}echo session`], { encoding: 'utf8' });
	assert.match(p3('').stderr, /^== sockets after Server started\n(\/proc\/net\/(tcp|udp)6? [0-9A-F]+:[0-9A-F]{4} [0-9A-F]+:[0-9A-F]{4} [0-9A-F]{2}\n)+== eth0 disable_ipv6=1\n== a TCP connect to 1\.1\.1\.1:443 failed\n== example\.com resolves to no address\n$/);
	assert.deepEqual(['', 'grep() { false; }', 'timeout() { [ "$*" = "5 bash -c : >/dev/tcp/1.1.1.1/443" ]; }', 'timeout() { [ "$*" = "10 getent ahosts example.com" ]; }'].map((s) => [p3(s).status, p3(s).stdout]), [[0, 'session\n'], [1, 'kill %1\n'], [1, 'kill %1\n'], [1, 'kill %1\n']]);
});

test('run.sh parses', { skip: process.platform === 'win32' && 'bash -n needs a POSIX shell' }, () => {
	assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
});

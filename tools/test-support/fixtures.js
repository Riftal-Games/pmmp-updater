'use strict';

// Builds throwaway fixture trees for tests. Fixtures are written here from small
// invented schemas, because Mojang's own JSON may not be committed to this repository.

const fs = require('fs');
const os = require('os');
const path = require('path');

// node --test runs each test file in its own process, so removing every directory on
// that process's exit covers a passing test, a failing one and an uncaught exception
// alike, without each call site having to clean up after itself.
const created = new Set();

function removeCreated() {
	for (const dir of created) {
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
			created.delete(dir);
		} catch (e) {
			process.stderr.write(`test-support: could not remove ${dir}: ${e.message}\n`);
		}
	}
}

process.on('exit', removeCreated);

// A signal ends the process without 'exit', and the test runner sends one to every test
// process when it receives SIGINT or SIGTERM itself. The signal is raised again once the
// directories are gone, so the process still ends the way the sender meant.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.once(signal, () => {
		removeCreated();
		process.kill(process.pid, signal);
	});
}

function tempDir(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pmmp-updater-${prefix}-`));
	created.add(dir);
	return dir;
}

function writeTree(root, files) {
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(root, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, '\t'));
	}
	return root;
}

function schema(title, protocol, body) {
	return { title, $schema: 'http://json-schema.org/draft-07/schema#', 'x-minecraft-version': `v-${protocol}`, 'x-protocol-version': protocol, ...body };
}

function packet(name, id, protocol) {
	return schema(name, protocol, { $ref: `./${name}Payload.json`, $metaProperties: { '[cereal:packet]': id, '[cereal:packet_details]': `${name} details` } });
}

function docsTree(protocol, files) {
	const out = {};
	for (const [name, body] of Object.entries(files)) {
		out[`json/${name}.json`] = body.title ? body : schema(name, protocol, body);
	}
	return out;
}

function protocolInfoPhp(protocol, version, ids) {
	const consts = Object.entries(ids).map(([stem, id]) => `\tpublic const ${stem}_PACKET = 0x${id.toString(16).padStart(2, '0')};`).join('\n');
	return `<?php\nfinal class ProtocolInfo{\n\tpublic const CURRENT_PROTOCOL = ${protocol};\n\tpublic const MINECRAFT_VERSION_NETWORK = '${version}';\n${consts}\n}\n`;
}

module.exports = { tempDir, writeTree, schema, packet, docsTree, protocolInfoPhp };

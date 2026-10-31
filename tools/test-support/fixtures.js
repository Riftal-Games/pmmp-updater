'use strict';

// Builds throwaway fixture trees for tests. Fixtures are written here from small
// invented schemas, because Mojang's own JSON may not be committed to this repository.

const fs = require('fs');
const os = require('os');
const path = require('path');

function tempDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `riftal-protocol-${prefix}-`));
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

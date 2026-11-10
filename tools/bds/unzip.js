#!/usr/bin/env node
'use strict';

// Unpacks a zip with Node's own zlib, so the BDS container needs no unzip binary, neither
// one of its own nor the host's. Sizes and modes come from the central directory, because
// a BDS zip defers them to a data descriptor after each entry's data. Stored and deflated
// entries only, no zip64, no symlinks: anything else stops the run with an error.
//
// Usage: node unzip.js <zip> <dir>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function entries(zip) {
	const eocd = zip.lastIndexOf(Buffer.from('504b0506', 'hex'));
	if (eocd < 0) throw new Error('not a zip: no end of central directory');
	const count = zip.readUInt16LE(eocd + 10);
	const out = [];
	for (let i = 0, at = zip.readUInt32LE(eocd + 16); i < count; i++) {
		if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} is malformed`);
		const nameLength = zip.readUInt16LE(at + 28);
		const e = { method: zip.readUInt16LE(at + 10), crc: zip.readUInt32LE(at + 16), packed: zip.readUInt32LE(at + 20), size: zip.readUInt32LE(at + 24), mode: zip.readUInt32LE(at + 38) >>> 16, offset: zip.readUInt32LE(at + 42), name: zip.toString('utf8', at + 46, at + 46 + nameLength) };
		if ([e.packed, e.size, e.offset].includes(0xffffffff)) throw new Error(`${e.name}: zip64 is not supported`);
		if ((e.mode & 0o170000) === 0o120000) throw new Error(`${e.name}: symlinks are not supported`);
		out.push(e);
		at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return out;
}

function extract(zip, dir) {
	const root = path.resolve(dir);
	const list = entries(zip);
	for (const e of list) {
		const dest = path.resolve(root, e.name);
		if (!dest.startsWith(root + path.sep)) throw new Error(`${e.name} would land outside ${dir}`);
		if (e.name.endsWith('/')) {
			fs.mkdirSync(dest, { recursive: true });
			continue;
		}
		if (zip.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`${e.name}: no local header at ${e.offset}`);
		const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
		const packed = zip.subarray(start, start + e.packed);
		if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: compression method ${e.method} is not supported`);
		const data = e.method === 8 ? zlib.inflateRawSync(packed) : packed;
		if (data.length !== e.size || zlib.crc32(data) !== e.crc) throw new Error(`${e.name}: length or CRC does not match the central directory`);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, data, { mode: e.mode & 0o777 || 0o644 });
	}
	return list.length;
}

if (require.main === module) {
	const [zip, dir] = process.argv.slice(2);
	try {
		if (!zip || !dir) throw new Error('usage: unzip.js <zip> <dir>');
		process.stdout.write(`unzipped ${extract(fs.readFileSync(zip), dir)} entries from ${path.basename(zip)}\n`);
	} catch (e) {
		process.stderr.write(`unzip: ${e.message}\n`);
		process.exitCode = 1;
	}
}

module.exports = { entries, extract };

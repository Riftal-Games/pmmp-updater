'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fx = require('../../test-support/fixtures');
const unzip = require('../unzip');

// Writes a zip the way BDS's is laid out: unix modes, deflated files, stored directories,
// and local headers that leave CRC and sizes to a data descriptor (flag bit 3).
function makeZip(files) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const { name, data = Buffer.alloc(0), mode = 0o100644, method = name.endsWith('/') ? 0 : 8 } of files) {
		const packed = method === 8 ? zlib.deflateRawSync(data) : data;
		const crc = zlib.crc32(data);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 6); head.writeUInt16LE(method, 8); head.writeUInt16LE(name.length, 26);
		const descriptor = Buffer.alloc(16);
		descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(packed.length, 8); descriptor.writeUInt32LE(data.length, 12);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x031e, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 8); entry.writeUInt16LE(method, 10);
		entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(mode * 0x10000, 38); entry.writeUInt32LE(offset, 42);
		locals.push(head, Buffer.from(name), packed, descriptor);
		central.push(entry, Buffer.from(name));
		offset += 30 + name.length + packed.length + 16;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const SERVER = Buffer.from('#!/bin/sh\necho synthetic server\n'.repeat(50));
const FILES = [
	{ name: 'server_binary', data: SERVER, mode: 0o100755 },
	{ name: 'packs/', mode: 0o040755 },
	{ name: 'packs/a/manifest.json', data: Buffer.from('{"synthetic":true}') },
	{ name: 'notes.txt', data: Buffer.from('stored, not deflated'), method: 0 },
];

test('every entry is unpacked with its bytes and its unix mode', { skip: process.platform === 'win32' && 'unix modes' }, () => {
	const dir = fx.tempDir('bds-unzip');
	assert.equal(unzip.extract(makeZip(FILES), dir), 4);
	assert.deepEqual(fs.readFileSync(path.join(dir, 'server_binary')), SERVER);
	assert.equal(fs.statSync(path.join(dir, 'server_binary')).mode & 0o777, 0o755);
	assert.equal(fs.statSync(path.join(dir, 'packs', 'a', 'manifest.json')).mode & 0o777, 0o644);
	assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'stored, not deflated');
});

test('a corrupted entry is refused by its CRC', () => {
	const zip = makeZip(FILES);
	const at = zip.indexOf(Buffer.from('stored, not deflated'));
	zip[at] ^= 0x20;
	assert.throws(() => unzip.extract(zip, fx.tempDir('bds-unzip')), /notes\.txt: length or CRC does not match/);
});

test('an entry that would land outside the target is refused', () => {
	const zip = makeZip([{ name: '../escape.txt', data: Buffer.from('x') }]);
	const dir = fx.tempDir('bds-unzip');
	assert.throws(() => unzip.extract(zip, path.join(dir, 'inner')), /would land outside/);
	assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')));
});

test('symlinks and anything that is not a zip are refused', () => {
	assert.throws(() => unzip.entries(makeZip([{ name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }])), /symlinks are not supported/);
	assert.throws(() => unzip.entries(Buffer.from('not a zip at all')), /no end of central directory/);
});

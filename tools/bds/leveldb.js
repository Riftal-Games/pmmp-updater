'use strict';

// Reads what BDS saved of a level: the live keys of its LevelDB directory, any NBT value
// stored there, such as a structure template with its block palette, and its sub-chunks
// with each block's palette entry, little-endian NBT as BDS writes it. The same storage
// reader takes a sub-chunk BDS sent, whose palette holds network IDs.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const fail = (m) => { throw new Error(`leveldb: ${m}`); };

function uvarint(buf, at) {
	let v = 0;
	for (let shift = 0; shift < 64; shift += 7) {
		if (at >= buf.length) fail('varint runs past the end');
		const b = buf[at++];
		v += (b & 0x7f) * 2 ** shift;
		if (!(b & 0x80)) return [v, at];
	}
	return fail('varint longer than 10 bytes');
}

const slice = (buf, at, n) => (at + n <= buf.length ? buf.subarray(at, at + n) : fail(`${n} bytes at ${at} run past the end`));

// Mojang's LevelDB compresses a table block with zlib, 2, or raw deflate, 4.
function block(buf, at, size) {
	const raw = slice(buf, at, size + 1);
	const kind = raw[size];
	if (kind === 0) return raw.subarray(0, size);
	if (kind === 2) return zlib.inflateSync(raw.subarray(0, size));
	if (kind === 4) return zlib.inflateRawSync(raw.subarray(0, size));
	return fail(`block compression ${kind}`);
}

function entries(b) {
	const out = [];
	const end = b.length - 4 - 4 * b.readUInt32LE(b.length - 4);
	let key = Buffer.alloc(0);
	for (let at = 0, shared, own, size; at < end; at += size) {
		[shared, at] = uvarint(b, at);
		[own, at] = uvarint(b, at);
		[size, at] = uvarint(b, at);
		key = Buffer.concat([key.subarray(0, shared), slice(b, at, own)]);
		at += own;
		out.push([key, slice(b, at, size)]);
	}
	return out;
}

// A table's key ends in 8 bytes: its sequence number, then its kind, 1 a value, 0 a deletion.
function table(buf, put) {
	if (buf.length < 48 || buf.readBigUInt64LE(buf.length - 8) !== 0xdb4775248b80fb57n) fail('a table has no footer');
	const f = buf.subarray(buf.length - 48);
	const [index, at] = uvarint(f, uvarint(f, uvarint(f, 0)[1])[1]);
	for (const [, handle] of entries(block(buf, index, uvarint(f, at)[0]))) {
		const [o, n] = uvarint(handle, 0);
		for (const [k, v] of entries(block(buf, o, uvarint(handle, n)[0]))) {
			const tag = k.readBigUInt64LE(k.length - 8);
			put(k.subarray(0, -8), tag >> 8n, Number(tag & 0xffn), v);
		}
	}
}

// A log is 32 KiB blocks of fragments, each with a 7-byte header, joined into write
// batches: a sequence number, a count, then each key with its value or its deletion.
function log(buf, put) {
	let parts = [];
	for (let at = 0; at + 7 <= buf.length;) {
		const left = 32768 - (at % 32768);
		const kind = buf[at + 6];
		if (left < 7 || kind === 0) {
			at += left;
			continue;
		}
		const size = buf.readUInt16LE(at + 4);
		parts.push(slice(buf, at + 7, size));
		at += 7 + size;
		if (kind !== 1 && kind !== 4) continue;
		const w = Buffer.concat(parts);
		parts = [];
		let seq = w.readBigUInt64LE(0);
		for (let i = 0, p = 12, n = w.readUInt32LE(8); i < n; i++, seq++) {
			const op = w[p];
			const [kl, k] = uvarint(w, p + 1);
			const key = slice(w, k, kl);
			let value = null;
			p = k + kl;
			if (op === 1) {
				const [vl, v] = uvarint(w, p);
				value = slice(w, v, vl);
				p = v + vl;
			} else if (op !== 0) fail(`write batch op ${op}`);
			put(key, seq, op, value);
		}
	}
	if (parts.length) fail('the log ends inside a record');
}

// The newest write of each key wins, in whichever file it is, and a deletion drops the key.
function read(dir) {
	const all = new Map();
	const put = (key, seq, kind, value) => {
		const k = key.toString('latin1');
		if (!all.has(k) || all.get(k).seq < seq) all.set(k, { seq, kind, value });
	};
	for (const f of fs.readdirSync(dir).sort()) {
		if (f.endsWith('.ldb')) table(fs.readFileSync(path.join(dir, f)), put);
		else if (f.endsWith('.log')) log(fs.readFileSync(path.join(dir, f)), put);
	}
	return new Map([...all].filter(([, e]) => e.kind === 1).map(([k, e]) => [k, e.value]));
}

// One root compound, each value kept with its tag type: a compound as [[key, type, value],
// ...], a list as [its tag type, [values]], an int array as [ints].
function nbt(buf, at) {
	const str = () => {
		const n = slice(buf, at, 2).readUInt16LE(0);
		at += 2 + n;
		return slice(buf, at - n, n).toString('utf8');
	};
	const fixed = { 1: [1, 'readInt8'], 2: [2, 'readInt16LE'], 3: [4, 'readInt32LE'], 4: [8, 'readBigInt64LE'], 5: [4, 'readFloatLE'], 6: [8, 'readDoubleLE'] };
	const read = (n, f) => {
		at += n;
		return slice(buf, at - n, n)[f](0);
	};
	const value = (t) => {
		if (fixed[t]) return read(...fixed[t]);
		if (t === 8) return str();
		if (t === 9) {
			const tt = read(1, 'readUInt8');
			return [tt, Array.from({ length: read(4, 'readInt32LE') }, () => value(tt))];
		}
		if (t === 11) return Array.from({ length: read(4, 'readInt32LE') }, () => read(4, 'readInt32LE'));
		if (t !== 10) fail(`tag type ${t} at byte ${at - 1}`);
		const c = [];
		for (let tt = read(1, 'readUInt8'); tt !== 0; tt = read(1, 'readUInt8')) c.push([str(), tt, value(tt)]);
		return c;
	};
	if (slice(buf, at++, 1)[0] !== 10) fail(`the NBT at byte ${at - 1} is not a compound`);
	str();
	return [value(10), at];
}

// The value at a path of keys through nested compounds.
function get(c, ...keys) {
	for (const k of keys) {
		const e = Array.isArray(c) && c.find((x) => x[0] === k);
		if (!e) fail(`no ${keys.join('.')}`);
		c = e[2];
	}
	return c;
}

const zigzag = (buf, at) => {
	const [u, next] = uvarint(buf, at);
	return [u % 2 ? -(u + 1) / 2 : u / 2, next];
};

// On disk the palette is a little-endian count and NBT; sent, a zigzag count and IDs. A
// storage of one entry has 0 bits per block, no words and, on disk, no count.
const PALETTES = {
	disk: (buf, at, bits) => {
		const n = bits ? slice(buf, at, 4).readInt32LE(0) : 1;
		at += bits ? 4 : 0;
		const out = [];
		for (let i = 0; i < n; i++) {
			const [c, next] = nbt(buf, at);
			out.push(c);
			at = next;
		}
		return [out, at];
	},
	network: (buf, at, bits) => {
		let n = 1;
		if (bits) [n, at] = zigzag(buf, at);
		const out = [];
		for (let i = 0; i < n; i++) {
			const [id, next] = zigzag(buf, at);
			out.push(id);
			at = next;
		}
		return [out, at];
	},
};

// A sub-chunk, versions 8 and 9: its storages, one per layer, each as 4096 palette entries
// by index (x << 8) | (z << 4) | y. A storage's header byte holds its bits per block.
function storages(buf, palette) {
	const v = buf[0];
	if (v !== 8 && v !== 9) fail(`sub-chunk version ${v}`);
	const out = [];
	for (let s = 0, at = v === 9 ? 3 : 2; s < buf[1]; s++) {
		const bits = slice(buf, at++, 1)[0] >> 1;
		const per = bits ? Math.floor(32 / bits) : 1;
		const words = bits ? slice(buf, at, 4 * Math.ceil(4096 / per)) : null;
		at += bits ? words.length : 0;
		let entries;
		[entries, at] = PALETTES[palette](buf, at, bits);
		out.push(Array.from({ length: 4096 }, (_, i) => {
			const e = bits ? (words.readUInt32LE(4 * Math.floor(i / per)) >>> ((i % per) * bits)) & ((1 << bits) - 1) : 0;
			return e < entries.length ? entries[e] : fail(`palette entry ${e} of ${entries.length}`);
		}));
	}
	return out;
}

// Overworld sub-chunk keys: chunk x and z as int32 LE, tag 0x2f, then the sub-chunk's y.
function subChunks(db) {
	const out = new Map();
	for (const [k, v] of db) {
		const b = Buffer.from(k, 'latin1');
		if (b.length === 10 && b[8] === 0x2f) out.set(`${b.readInt32LE(0)},${b.readInt8(9)},${b.readInt32LE(4)}`, storages(v, 'disk'));
	}
	return out;
}

module.exports = { read, nbt, get, storages, subChunks };

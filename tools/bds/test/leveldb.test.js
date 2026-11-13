'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const fx = require('../../test-support/fixtures');
const leveldb = require('../leveldb');

// Every file here is built by these writers from invented keys and blocks.
const varint = (n) => {
	const out = [];
	for (; n > 0x7f; n = Math.floor(n / 128)) out.push((n & 0x7f) | 0x80);
	return Buffer.from([...out, n]);
};
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const zigzag = (n) => varint(n < 0 ? -2 * n - 1 : 2 * n);

const leStr = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length & 0xff, b.length >> 8]), b]); };
const leInt = (t, v) => { const b = Buffer.alloc({ 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 }[t]); b[{ 1: 'writeInt8', 2: 'writeInt16LE', 3: 'writeInt32LE', 4: 'writeBigInt64LE', 5: 'writeFloatLE', 6: 'writeDoubleLE' }[t]](v); return b; };
const leValue = (t, v) => {
	if (t === 8) return leStr(v);
	if (t === 9) return Buffer.concat([Buffer.from([v[0]]), u32(v[1].length), ...v[1].map((x) => leValue(v[0], x))]);
	if (t === 11) return Buffer.concat([u32(v.length), ...v.map((x) => leInt(3, x))]);
	if (t === 10) return Buffer.concat([...v.map(([k, tt, x]) => Buffer.concat([Buffer.from([tt]), leStr(k), leValue(tt, x)])), Buffer.from([0])]);
	return leInt(t, v);
};
const leRoot = (c) => Buffer.concat([Buffer.from([10]), leStr(''), leValue(10, c)]);
const state = (name, states, version = 7) => [['name', 8, name], ['states', 10, states], ['version', 3, version]];

// A LevelDB block: prefix-shared keys, one restart point.
function block(pairs) {
	let prev = Buffer.alloc(0);
	const parts = pairs.map(([k, v]) => {
		let shared = 0;
		while (shared < prev.length && shared < k.length && prev[shared] === k[shared]) shared++;
		prev = k;
		return Buffer.concat([varint(shared), varint(k.length - shared), varint(v.length), k.subarray(shared), v]);
	});
	return Buffer.concat([...parts, u32(0), u32(1)]);
}
const ikey = (k, seq, kind = 1) => Buffer.concat([Buffer.from(k, 'latin1'), u64((BigInt(seq) << 8n) | BigInt(kind))]);
const handle = (o, n) => Buffer.concat([varint(o), varint(n)]);

function tableFile(pairs, kind) {
	const raw = block(pairs);
	const data = kind === 4 ? zlib.deflateRawSync(raw) : kind === 2 ? zlib.deflateSync(raw) : raw;
	const trailer = (b, k) => Buffer.concat([b, Buffer.from([k]), u32(0)]);
	const index = block([[pairs[pairs.length - 1][0], handle(0, data.length)]]);
	const meta = block([]);
	const body = Buffer.concat([trailer(data, kind), trailer(index, 0), trailer(meta, 0)]);
	const at = [0, data.length + 5, data.length + index.length + 10];
	const footer = Buffer.concat([handle(at[2], meta.length), handle(at[1], index.length)]);
	return Buffer.concat([body, footer, Buffer.alloc(40 - footer.length), u64(0xdb4775248b80fb57n)]);
}

// A log: write batches cut into fragments, full 1, first 2, middle 3, last 4, never
// across a 32 KiB block, and a block's last 6 bytes or fewer left as padding.
function logFile(batches) {
	const out = [];
	let used = 0;
	for (const [seq, ops] of batches) {
		let rest = Buffer.concat([u64(seq), u32(ops.length), ...ops.map(([k, v]) => Buffer.concat(v === null ? [Buffer.from([0]), varint(k.length), Buffer.from(k, 'latin1')] : [Buffer.from([1]), varint(k.length), Buffer.from(k, 'latin1'), varint(v.length), v]))]);
		for (let first = true; rest.length || first; first = false) {
			if (32768 - (used % 32768) < 7) {
				out.push(Buffer.alloc(32768 - (used % 32768)));
				used += out[out.length - 1].length;
			}
			const n = Math.min(rest.length, 32768 - (used % 32768) - 7);
			const last = n === rest.length;
			const header = Buffer.concat([u32(0), Buffer.from([n & 0xff, n >> 8]), Buffer.from([first ? (last ? 1 : 2) : last ? 4 : 3])]);
			out.push(header, rest.subarray(0, n));
			used += 7 + n;
			rest = rest.subarray(n);
		}
	}
	return Buffer.concat(out);
}

test('read takes the newest write of each key across tables and logs, drops a deleted key and joins a record split over blocks', () => {
	const big = Buffer.alloc(40000, 7);
	const dir = fx.writeTree(fx.tempDir('bds-leveldb'), {
		'000005.ldb': tableFile([[ikey('a', 1), Buffer.from('old')], [ikey('ab', 2), Buffer.from('gone')]], 4),
		'000006.ldb': tableFile([[ikey('c', 3), Buffer.from('zlib')]], 2),
		'000007.log': logFile([[10, [['a', Buffer.from('new')], ['ab', null]]], [12, [['d', Buffer.alloc(32700, 1)]]], [13, [['e', big]]]]),
		CURRENT: 'MANIFEST-000004\n',
	});
	const db = leveldb.read(dir);
	assert.deepEqual([...db.keys()].sort(), ['a', 'c', 'd', 'e']);
	assert.deepEqual([db.get('a').toString(), db.get('c').toString(), db.get('e').equals(big)], ['new', 'zlib', true]);
	const older = fx.writeTree(fx.tempDir('bds-leveldb-old'), { '000005.ldb': tableFile([[ikey('a', 20), Buffer.from('newer')]], 0), '000007.log': logFile([[10, [['a', Buffer.from('new')]]]]) });
	assert.equal(leveldb.read(older).get('a').toString(), 'newer');
});

test('read refuses a table without its footer, a block it cannot inflate and a log cut inside a record', () => {
	const bad = (files) => () => leveldb.read(fx.writeTree(fx.tempDir('bds-leveldb-bad'), files));
	const t = tableFile([[ikey('a', 1), Buffer.from('x')]], 4);
	assert.throws(bad({ '1.ldb': t.subarray(0, -1) }), /no footer/);
	assert.throws(bad({ '1.ldb': tableFile([[ikey('a', 1), Buffer.from('x')]], 9) }), /block compression 9/);
	assert.throws(bad({ '1.log': logFile([[1, [['a', Buffer.alloc(40000)]]]]).subarray(0, 32768) }), /ends inside a record/);
});

// index (x << 8) | (z << 4) | y. 3 bits per block packs 10 to a word, with 2 bits of padding.
function packed(bits, values) {
	const per = Math.floor(32 / bits);
	const words = Buffer.alloc(4 * Math.ceil(4096 / per));
	values.forEach((v, i) => words.writeUInt32LE((words.readUInt32LE(4 * Math.floor(i / per)) | (v << ((i % per) * bits))) >>> 0, 4 * Math.floor(i / per)));
	return words;
}

test('a saved sub-chunk gives each block its NBT palette entry, every value with its tag type, keyed by chunk x, sub-chunk y and chunk z', () => {
	const palette = [state('fixture:air', []), state('fixture:lamp', [['lit', 1, 1], ['level', 3, 300], ['tall', 2, -2], ['seed', 4, 5n], ['facing', 8, 'up']]), ...[0, 1, 2].map((i) => state(`fixture:b${i}`, []))];
	const index = Array.from({ length: 4096 }, (_, i) => (i === ((1 << 8) | (2 << 4) | 3) ? 1 : i === 4095 ? 4 : 0));
	const layer0 = Buffer.concat([Buffer.from([3 << 1]), packed(3, index), u32(palette.length), ...palette.map(leRoot)]);
	const layer1 = Buffer.concat([Buffer.from([0]), leRoot(state('fixture:water', [['depth', 3, 0]]))]);
	const key = Buffer.concat([u32(-3), u32(5), Buffer.from([0x2f, 0xfe])]).toString('latin1');
	const subs = leveldb.subChunks(new Map([[key, Buffer.concat([Buffer.from([9, 2, 0xfe]), layer0, layer1])], ['other', Buffer.from([1])]]));
	assert.deepEqual([...subs.keys()], ['-3,-2,5']);
	const [l0, l1] = subs.get('-3,-2,5');
	assert.deepEqual(l0[(1 << 8) | (2 << 4) | 3], palette[1]);
	assert.deepEqual([l0[0], l0[4095], l1[17]], [palette[0], palette[4], state('fixture:water', [['depth', 3, 0]])]);
	assert.throws(() => leveldb.nbt(leRoot(state('fixture:x', [])).subarray(0, 9), 0), /run past the end/);
	assert.throws(() => leveldb.nbt(Buffer.concat([Buffer.from([10]), leStr(''), Buffer.from([7]), leStr('l'), Buffer.from([0])]), 0), /tag type 7/);
});

test('a stored template reads with every tag type kept, and get walks it to its block palette or names the key it lacks', () => {
	const palette = [state('fixture:a', [['up', 1, 1]]), state('fixture:b', [], 9)];
	const template = [['format_version', 3, 1], ['size', 9, [3, [2, 1, 1]]], ['scale', 5, 0.5], ['weight', 6, 2.25],
		['structure', 10, [['block_indices', 9, [9, [[3, [0, 1]]]]], ['origin', 11, [-1, 0, 7]], ['palette', 10, [['default', 10, [['block_palette', 9, [10, palette]]]]]]]]];
	const [root, end] = leveldb.nbt(Buffer.concat([leRoot(template), Buffer.from([0xee])]), 0);
	assert.equal(end, leRoot(template).length);
	assert.deepEqual(root, template);
	assert.deepEqual(leveldb.get(root, 'structure', 'palette', 'default', 'block_palette'), [10, palette]);
	assert.deepEqual([leveldb.get(root, 'structure', 'origin'), leveldb.get(root, 'scale')], [[-1, 0, 7], 0.5]);
	assert.throws(() => leveldb.get(root, 'structure', 'palette', 'other'), /no structure\.palette\.other/);
	assert.throws(() => leveldb.get(root, 'size', 'x'), /no size\.x/);
	assert.throws(() => leveldb.nbt(Buffer.from([9, 0, 0]), 0), /not a compound/);
});

test('a sent sub-chunk gives each block its network ID from a zigzag palette, and a bad version or palette index fails', () => {
	const ids = Array.from({ length: 4096 }, (_, i) => i % 2);
	const sent = Buffer.concat([Buffer.from([8, 2, (1 << 1) | 1]), packed(1, ids), zigzag(2), zigzag(0), zigzag(23959), Buffer.from([1]), zigzag(-7)]);
	const [l0, l1] = leveldb.storages(sent, 'network');
	assert.deepEqual([l0[0], l0[1], l0[4095], l1[9]], [0, 23959, 23959, -7]);
	assert.throws(() => leveldb.storages(Buffer.from([7, 0]), 'network'), /sub-chunk version 7/);
	const short = Buffer.concat([Buffer.from([8, 1, (1 << 1) | 1]), packed(1, ids), zigzag(1), zigzag(4)]);
	assert.throws(() => leveldb.storages(short, 'network'), /palette entry 1 of 1/);
});

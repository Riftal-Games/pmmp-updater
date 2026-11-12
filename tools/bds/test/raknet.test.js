'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const dgram = require('dgram');
const r = require('../raknet');

test('a frame reads back as written, split fields included, and a short one fails', () => {
	const body = Buffer.from('payload');
	const [f] = r.decodeFrames(Buffer.concat([Buffer.alloc(4), r.encodeFrame(body, 5, 6, { count: 3, id: 7, index: 2 })]));
	assert.deepEqual(f, { reliability: 3, reliableIndex: 5, orderIndex: 6, split: { count: 3, id: 7, index: 2 }, body });
	assert.throws(() => r.decodeFrames(Buffer.concat([Buffer.alloc(4), r.encodeFrame(body, 0, 0).subarray(0, -1)])), /malformed/);
});

test('split, shuffled and repeated datagrams reach the peer once each, in order', () => {
	const [wire, acks, got] = [[], [], []];
	const sender = new r.Session((d) => wire.push(d), () => {});
	const big = crypto.randomBytes(5000);
	[big, Buffer.from('second')].forEach((m) => sender.send(m));
	const receiver = new r.Session((d) => acks.push(d), (m) => got.push(m));
	// A reliable unordered frame, sent twice, as a server resends one it saw no ACK for.
	const unordered = Buffer.from([0x84, 9, 0, 0, 0x40, 0, 8, 7, 0, 0, 0x75]);
	for (const d of [4, 2, 0, 2, 3, 1, 0].map((i) => wire[i]).concat(unordered, unordered)) receiver.receive(d);
	assert.deepEqual(got, [big, Buffer.from('second'), Buffer.from('u')]);
	assert.deepEqual([acks.length, acks[0]], [9, Buffer.from([0xc0, 0, 1, 1, 4, 0, 0])]);
});

// A server on loopback that walks the transport through the offline handshake and the
// connection request, then pings it, sends a batch, takes one back and disconnects it twice,
// with one more batch after.
test('the transport connects, answers a ping, carries batches both ways behind 0xfe and reports one disconnect', { timeout: 10000 }, async (t) => {
	const server = dgram.createSocket('udp4');
	t.after(() => server.close());
	const seen = [];
	let session = null;
	let replied = null;
	const pong = new Promise((resolve) => { replied = resolve; });
	server.on('message', (b, from) => {
		const reply = (d) => server.send(d, from.port, from.address);
		session ||= new r.Session(reply, (m) => {
			seen.push(m[0]);
			if (m[0] === 0x09) session.send(Buffer.from([0x10]));
			else if (m[0] === 0x03) replied(m.subarray(1, 9));
			else if (m[0] === 0xfe) {
				seen.push(m[1]);
				for (const d of [[0x15], [0x15], [0xfe, 0x63]]) session.send(Buffer.from(d));
			}
		});
		if (b[0] === 0x05) reply(Buffer.concat([Buffer.from([0x06]), r.MAGIC, Buffer.alloc(8), Buffer.from([0, 0x05, 0x78])]));
		else if (b[0] === 0x07) reply(Buffer.from([0x08]));
		else if (b[0] & 0x80) session.receive(b);
	});
	await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
	const link = r.transport(server.address().port);
	t.after(() => link.close());
	const [got, closed] = [[], []];
	const ended = new Promise((resolve) => link.open((m) => got.push(m), (e) => resolve(closed.push(e.message))).then(() => {
		session.send(Buffer.from([0x00, 1, 2, 3, 4, 5, 6, 7, 8]));
		session.send(Buffer.from([0xfe, 0x61]));
	}));
	assert.deepEqual(await pong, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
	await new Promise((resolve) => { const wait = setInterval(() => got.length && resolve(clearInterval(wait)), 10); });
	link.send(Buffer.from([0x62]));
	await ended;
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(got, [Buffer.from([0x61])]);
	assert.deepEqual(seen, [0x09, 0x13, 0x03, 0xfe, 0x62]);
	assert.deepEqual(closed, ['the server closed the RakNet connection']);
});

// trace() learns of a bad packet only through onClose, so a throw from onMessage must end
// the connection there, once, and stop every later batch.
test('a throw from onMessage reaches onClose once and no batch follows it', { timeout: 10000 }, async (t) => {
	const server = dgram.createSocket('udp4');
	t.after(() => server.close());
	let session = null;
	server.on('message', (b, from) => {
		const reply = (d) => server.send(d, from.port, from.address);
		session ||= new r.Session(reply, (m) => {
			if (m[0] === 0x09) session.send(Buffer.from([0x10]));
			else if (m[0] === 0x13) for (const d of [[0xfe, 0x61], [0xfe, 0x62], [0x15]]) session.send(Buffer.from(d));
		});
		if (b[0] === 0x05) reply(Buffer.concat([Buffer.from([0x06]), r.MAGIC, Buffer.alloc(8), Buffer.from([0, 0x05, 0x78])]));
		else if (b[0] === 0x07) reply(Buffer.from([0x08]));
		else if (b[0] & 0x80) session.receive(b);
	});
	await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
	const link = r.transport(server.address().port);
	t.after(() => link.close());
	const boom = new Error('bad packet');
	const [got, closed] = [[], []];
	const ended = new Promise((resolve) => link.open((m) => {
		got.push(m);
		throw boom;
	}, (e) => resolve(closed.push(e))));
	await ended;
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(got, [Buffer.from([0x61])]);
	assert.equal(closed.length, 1);
	assert.equal(closed[0], boom);
	link.close();
	assert.doesNotThrow(() => link.close());
});

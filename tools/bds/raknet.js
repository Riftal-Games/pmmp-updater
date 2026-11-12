'use strict';

// The RakNet client transport the tracer joins BDS with on 127.0.0.1: the offline
// handshake, the connection request, pings and the reliable ordered session that carries
// game batches.

const crypto = require('crypto');
const dgram = require('dgram');

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const MTU = 1400;
const ORDERED = new Set([1, 3, 4, 7]);
// RakNet writes an IPv4 address with every octet inverted.
const LOOPBACK = (port) => Buffer.from([4, 0x80, 0xff, 0xff, 0xfe, port >> 8, port & 0xff]);

// The only frame this client sends: reliable ordered on channel 0, split to fit the MTU.
function encodeFrame(body, reliableIndex, orderIndex, split) {
	const head = Buffer.alloc(split ? 20 : 10);
	head[0] = 0x60 | (split ? 0x10 : 0);
	head.writeUInt16BE(body.length * 8, 1);
	head.writeUIntLE(reliableIndex, 3, 3);
	head.writeUIntLE(orderIndex, 6, 3);
	if (split) { head.writeUInt32BE(split.count, 10); head.writeUInt16BE(split.id, 14); head.writeUInt32BE(split.index, 16); }
	return Buffer.concat([head, body]);
}

function decodeFrames(datagram) {
	const frames = [];
	for (let at = 4; at < datagram.length;) {
		const [flags, length] = [datagram[at], Math.ceil(datagram.readUInt16BE(at + 1) / 8)];
		const f = { reliability: flags >> 5 };
		at += 3;
		if ([2, 3, 4, 6, 7].includes(f.reliability)) { f.reliableIndex = datagram.readUIntLE(at, 3); at += 3; }
		if (f.reliability === 1 || f.reliability === 4) at += 3;
		if (ORDERED.has(f.reliability)) { f.orderIndex = datagram.readUIntLE(at, 3); at += 4; }
		if (flags & 0x10) { f.split = { count: datagram.readUInt32BE(at), id: datagram.readUInt16BE(at + 4), index: datagram.readUInt32BE(at + 6) }; at += 10; }
		f.body = datagram.subarray(at, at + length);
		if (f.body.length !== length || (f.split && (f.split.index >= f.split.count || f.split.count > 4096))) throw new Error('malformed RakNet frame');
		at += length;
		frames.push(f);
	}
	return frames;
}

// One RakNet connection after the offline handshake. It acknowledges every datagram,
// drops repeated frames, joins split ones and hands messages on in order: the stream is
// encrypted with a running counter, so one message out of place breaks every later one.
class Session {
	constructor(send, onMessage) {
		Object.assign(this, { sendRaw: send, onMessage, seq: 0, reliable: 0, order: 0, splitId: 0, expected: 0, seen: new Set(), splits: new Map(), held: new Map() });
	}

	send(body) {
		const parts = [];
		for (let i = 0; i < body.length; i += MTU - 60) parts.push(body.subarray(i, i + MTU - 60));
		const order = this.order++;
		const id = parts.length > 1 ? this.splitId++ & 0xffff : 0;
		for (const [index, part] of parts.entries()) {
			const head = Buffer.from([0x84, 0, 0, 0]);
			head.writeUIntLE(this.seq++ & 0xffffff, 1, 3);
			this.sendRaw(Buffer.concat([head, encodeFrame(part, this.reliable++, order, parts.length > 1 ? { count: parts.length, id, index } : null)]));
		}
	}

	receive(datagram) {
		if (datagram[0] & 0x60) return;
		this.sendRaw(Buffer.concat([Buffer.from([0xc0, 0, 1, 1]), datagram.subarray(1, 4)]));
		for (const f of decodeFrames(datagram)) this.frame(f);
	}

	frame(f) {
		if (this.seen.has(f.reliableIndex)) return;
		if (f.reliableIndex !== undefined) this.seen.add(f.reliableIndex);
		let body = f.body;
		if (f.split) {
			const parts = this.splits.get(f.split.id) || this.splits.set(f.split.id, []).get(f.split.id);
			parts[f.split.index] = body;
			if (parts.filter(Boolean).length < f.split.count) return;
			this.splits.delete(f.split.id);
			body = Buffer.concat(parts);
		}
		if (!ORDERED.has(f.reliability)) return this.onMessage(body);
		this.held.set(f.orderIndex, body);
		for (let next; (next = this.held.get(this.expected)) !== undefined;) {
			this.held.delete(this.expected++);
			this.onMessage(next);
		}
	}
}

// A transport is { open(onMessage, onClose), send(batch), close() }, where a batch is the
// game layer's bytes; RakNet carries it behind 0xfe, which this one adds and strips. open
// resolves once batches can be sent. onClose is called at most once, with the error that
// ends the connection, and no batch reaches onMessage after it. An exception thrown by
// onMessage ends the connection and is passed to onClose. close() releases the connection
// and may be called again.
function transport(port) {
	const socket = dgram.createSocket('udp4');
	const guid = crypto.randomBytes(8);
	const raw = (b) => socket.send(b, port, '127.0.0.1');
	let session = null;
	let knock = null;
	let bound = false;
	let ended = false;
	return {
		open(onMessage, onClose) {
			const end = (e) => {
				if (!ended) onClose(e);
				ended = true;
			};
			return new Promise((resolve) => {
				session = new Session(raw, (m) => {
					try {
						if (m[0] === 0x10) {
							session.send(Buffer.concat([Buffer.from([0x13]), LOOPBACK(port), ...Array(20).fill(Buffer.from([4, 0xff, 0xff, 0xff, 0xff, 0, 0])), Buffer.alloc(16)]));
							resolve();
						} else if (m[0] === 0x00) session.send(Buffer.concat([Buffer.from([0x03]), m.subarray(1, 9), Buffer.alloc(8)]));
						else if (m[0] === 0x15) throw new Error('the server closed the RakNet connection');
						else if (m[0] === 0xfe && !ended) onMessage(m.subarray(1));
					} catch (e) {
						end(e);
					}
				});
				socket.on('message', (b) => {
					if (b[0] === 0x06) {
						const cookie = b[25] ? [b.subarray(26, 30), Buffer.from([0])] : [];
						raw(Buffer.concat([Buffer.from([0x07]), MAGIC, ...cookie, LOOPBACK(port), b.subarray(-2), guid]));
					} else if (b[0] === 0x08 && session.seq === 0) {
						clearInterval(knock);
						session.send(Buffer.concat([Buffer.from([0x09]), guid, Buffer.alloc(8), Buffer.from([0])]));
					} else if (b[0] & 0x80) {
						try { session.receive(b); } catch (e) { end(e); }
					}
				});
				knock = setInterval(() => raw(Buffer.concat([Buffer.from([0x05]), MAGIC, Buffer.from([11]), Buffer.alloc(MTU - 46)])), 500);
				socket.bind(0, '127.0.0.1');
				bound = true;
			});
		},
		send(batch) { session.send(Buffer.concat([Buffer.from([0xfe]), batch])); },
		close() {
			ended = true;
			if (!bound) return;
			bound = false;
			clearInterval(knock);
			socket.close();
		},
	};
}

module.exports = { MAGIC, encodeFrame, decodeFrames, Session, transport };

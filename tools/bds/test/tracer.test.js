'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../tracer');

// A made-up protocol, so nothing here depends on a real version's numbers.
const INFO = { version: { major: 9, minor: 8, patch: 7, protocol_version: 4321 }, packets: { LoginPacket: 1, StartGamePacket: 11 } };
const KEY = crypto.createHash('sha256').update('synthetic').digest();
const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url'));
const verifies = (jwt) => crypto.verify('sha384', Buffer.from(jwt.slice(0, jwt.lastIndexOf('.'))), { dsaEncoding: 'ieee-p1363',
	key: crypto.createPublicKey({ key: Buffer.from(part(jwt, 0).x5u, 'base64'), format: 'der', type: 'spki' }) }, Buffer.from(jwt.split('.')[2], 'base64url'));

test('varints round-trip and a truncated or overlong one fails', () => {
	for (const n of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 32 - 1]) assert.deepEqual(t.readVarint(t.varint(n), 0), [n, t.varint(n).length]);
	assert.throws(() => t.readVarint(Buffer.from([0x80]), 0), /past the end/);
	assert.throws(() => t.readVarint(Buffer.alloc(6, 0xff), 0), /longer than 5/);
});

test('a batch survives compression and encryption in order, and a flipped byte fails its checksum', () => {
	const [client, server] = [0, 1].map(() => ({ compressed: true, cipher: new t.Cipher(KEY) }));
	const packets = [Buffer.concat([t.varint(11), Buffer.from('start')]), Buffer.concat([t.varint(0x1a2), Buffer.from('x')])];
	for (let i = 0; i < 2; i++) assert.deepEqual(t.decodeBatch(t.encodeBatch(packets, client), server), [{ id: 11, packet: packets[0] }, { id: 0x1a2, packet: packets[1] }]);
	const bad = t.encodeBatch(packets, client);
	bad[3] ^= 1;
	assert.throws(() => t.decodeBatch(bad, server), /checksum/);
	assert.throws(() => t.decodeBatch(Buffer.from([0x01, 0]), { compressed: true }), /neither zlib nor none/);
	assert.throws(() => t.decodeBatch(Buffer.from([5, 1]), {}), /past the end of its batch/);
	assert.deepEqual(t.encodeBatch([Buffer.from([0xfe])], {}), Buffer.from([1, 0xfe]));
});

test('the session key is the shared secret salted, and a handshake signed by another key fails', () => {
	const [client, server] = [t.makeKeys(), t.makeKeys()];
	const salt = crypto.randomBytes(16);
	const token = t.jwt({ salt: salt.toString('base64') }, server);
	const secret = crypto.diffieHellman({ privateKey: server.privateKey, publicKey: client.publicKey });
	assert.deepEqual(t.sessionKey(token, client.privateKey), crypto.createHash('sha256').update(salt).update(secret).digest());
	const forged = token.split('.').slice(0, 2).concat(t.jwt({}, t.makeKeys()).split('.')[2]).join('.');
	assert.throws(() => t.sessionKey(forged, client.privateKey), /does not verify/);
});

test('the login carries the protocol from protocol_info and a token and client data signed by the key they name', () => {
	const keys = t.makeKeys();
	const p = t.loginPacket(INFO.packets, INFO, keys, 19132);
	assert.deepEqual([p[0], p.readUInt32BE(1)], [1, 4321]);
	const [length, at] = t.readVarint(p, 5);
	assert.equal(at + length, p.length);
	const request = p.subarray(at);
	const authLength = request.readUInt32LE(0);
	const auth = JSON.parse(request.subarray(4, 4 + authLength));
	const data = request.subarray(8 + authLength).toString();
	assert.equal(request.readUInt32LE(4 + authLength), data.length);
	assert.equal(auth.AuthenticationType, 2);
	assert.ok(verifies(auth.Token) && verifies(data));
	assert.deepEqual([part(auth.Token, 1).cpk, part(auth.Token, 1).aud], [keys.der, 'api://auth-minecraft-services/multiplayer']);
	assert.equal(part(data, 1).GameVersion, '9.8.7');
	assert.equal(part(data, 1).DeviceOS, 15);
});

// A server stood in for over a fake transport answers each step of the join, then sends
// the WANTED packets, encrypted only where the transport says Bedrock's cipher runs.
for (const bedrockCipher of [false, true]) {
	test(`with bedrockCipher ${bedrockCipher} the handshake reply is ${bedrockCipher ? 'encrypted' : 'plain'} and the session is recorded`, async () => {
		const ids = Object.fromEntries([['LoginPacket', 1], ['ServerToClientHandshakePacket', 3], ['ClientToServerHandshakePacket', 4], ['NetworkSettingsPacket', 143], ['RequestNetworkSettingsPacket', 193], ...t.WANTED.map((n, i) => [n, 300 + i])]);
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tracer-'));
		fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify({ version: INFO.version, packets: ids }));
		const server = t.makeKeys();
		const state = { compressed: true, cipher: null };
		const [sent, replies] = [[], []];
		let deliver = null;
		const reply = (packets, s) => setImmediate(() => deliver(t.encodeBatch(packets, s)));
		const send = (batch) => {
			sent.push(batch);
			if (sent.length === 1) return reply([t.varint(143)], {});
			if (sent.length > 2) {
				replies.push(...t.decodeBatch(batch, state).map((r) => r.id));
				return reply(t.WANTED.map((n) => t.varint(ids[n])), state);
			}
			const p = t.decodeBatch(batch, state)[0].packet;
			const [length, at] = t.readVarint(p, 5);
			const request = p.subarray(at, at + length);
			const cpk = part(JSON.parse(request.subarray(4, 4 + request.readUInt32LE(0))).Token, 1).cpk;
			const salt = crypto.randomBytes(16);
			const secret = crypto.diffieHellman({ privateKey: server.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(cpk, 'base64'), format: 'der', type: 'spki' }) });
			if (bedrockCipher) state.cipher = new t.Cipher(crypto.createHash('sha256').update(salt).update(secret).digest());
			const token = t.jwt({ salt: salt.toString('base64') }, server);
			reply([Buffer.concat([t.varint(3), t.varint(token.length), Buffer.from(token)])], { compressed: true });
		};
		const link = { bedrockCipher, send, close() {}, open: async (onMessage) => { deliver = onMessage; } };
		const code = await t.trace({ protocol_info: path.join(out, 'info.json'), out, port: 19132, deadline: 10 }, () => {}, link);
		const capture = fs.readFileSync(path.join(out, 'capture.bin'));
		const recorded = [];
		for (let i = 0; i < capture.length; i += 6 + capture.readUInt32BE(i + 2)) recorded.push(capture.readUInt16BE(i));
		assert.deepEqual([code, replies, recorded], [0, [4], [143, 3, ...t.WANTED.map((n) => ids[n])]]);
	});
}

test('a capture record is the ID, the length, then the packet, and arguments need both paths', () => {
	const capture = t.encodeCapture([{ id: 0x1a2, packet: Buffer.from('ab') }, { id: 11, packet: Buffer.alloc(0) }]);
	assert.deepEqual(capture, Buffer.from([0x01, 0xa2, 0, 0, 0, 2, 0x61, 0x62, 0, 11, 0, 0, 0, 0]));
	assert.deepEqual(t.parseArgs(['--protocol-info', 'p.json', '--out', '/o']), { protocol_info: 'p.json', out: '/o', port: 19132, deadline: 90 });
	assert.throws(() => t.parseArgs(['--out', '/o']), /required/);
	assert.throws(() => t.parseArgs(['--protocol-info', 'p', '--out', '/o', '--port', 'x']), /positive/);
	assert.throws(() => t.parseArgs(['--verbose']), /Unknown option/);
	assert.ok(t.WANTED.includes('ItemRegistryPacket') && t.WANTED.includes('CraftingDataPacket'));
});

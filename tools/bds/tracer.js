#!/usr/bin/env node
'use strict';

// A headless offline Bedrock client, run beside the server in a container whose only
// network is loopback. It joins on 127.0.0.1 over RakNet, logs in self-signed, answers
// the encryption handshake and the resource pack prompts, and records every packet the
// server sends, decrypted and decompressed, into capture.bin. The protocol number and
// packet IDs come from packages/bedrock-data's protocol_info.json, and what it sends is
// laid out as packages/bedrock-protocol encodes it.
//
// Usage: node tracer.js --protocol-info <json> --out <dir> [--port <n>] [--deadline <seconds>]

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const util = require('util');
const zlib = require('zlib');

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const MTU = 1400;
const NAME = 'PmmpUpdater';
const ORDERED = new Set([1, 3, 4, 7]);
// Every packet ADR 002 sources a BedrockData file from. The session ends once all arrived.
const WANTED = ['StartGamePacket', 'ItemRegistryPacket', 'CreativeContentPacket', 'CraftingDataPacket', 'BiomeDefinitionListPacket', 'AvailableActorIdentifiersPacket', 'JigsawStructureDataPacket', 'VoxelShapesPacket'];

function varint(n) {
	const out = [];
	for (; n > 0x7f; n = Math.floor(n / 128)) out.push((n & 0x7f) | 0x80);
	out.push(n);
	return Buffer.from(out);
}

function readVarint(buf, at) {
	let v = 0;
	for (let shift = 0; shift < 35; shift += 7) {
		if (at >= buf.length) throw new Error('varint runs past the end');
		const b = buf[at++];
		v += (b & 0x7f) * 2 ** shift;
		if (!(b & 0x80)) return [v, at];
	}
	throw new Error('varint longer than 5 bytes');
}

const u32 = (n, le) => { const b = Buffer.alloc(4); b[le ? 'writeUInt32LE' : 'writeUInt32BE'](n); return b; };
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

// Bedrock's AES-256-GCM is used as a stream: CTR from GCM's first counter block, each
// batch followed by 8 bytes of SHA-256 over a per-direction counter, the batch and the key.
class Cipher {
	constructor(key) {
		const iv = Buffer.concat([key.subarray(0, 12), Buffer.from([0, 0, 0, 2])]);
		Object.assign(this, { key, sent: 0n, received: 0n, enc: crypto.createCipheriv('aes-256-ctr', key, iv), dec: crypto.createDecipheriv('aes-256-ctr', key, iv) });
	}

	checksum(counter, plain) {
		const c = Buffer.alloc(8);
		c.writeBigUInt64LE(counter);
		return crypto.createHash('sha256').update(Buffer.concat([c, plain, this.key])).digest().subarray(0, 8);
	}

	encrypt(plain) { return this.enc.update(Buffer.concat([plain, this.checksum(this.sent++, plain)])); }

	decrypt(data) {
		const out = this.dec.update(data);
		const plain = out.subarray(0, -8);
		if (!this.checksum(this.received++, plain).equals(out.subarray(-8))) throw new Error('encrypted batch fails its checksum');
		return plain;
	}
}

// A game batch is 0xfe, then, once NetworkSettings has arrived, a compression byte, then
// length-prefixed packets. Once the handshake is done, all of it after 0xfe is encrypted.
function encodeBatch(packets, state) {
	let body = Buffer.concat(packets.flatMap((p) => [varint(p.length), p]));
	if (state.compressed) body = Buffer.concat([Buffer.from([0]), zlib.deflateRawSync(body)]);
	if (state.cipher) body = state.cipher.encrypt(body);
	return Buffer.concat([Buffer.from([0xfe]), body]);
}

function decodeBatch(message, state) {
	if (message[0] !== 0xfe) throw new Error(`not a game batch: 0x${message[0].toString(16)}`);
	let body = message.subarray(1);
	if (state.cipher) body = state.cipher.decrypt(body);
	if (state.compressed && body[0] === 0) body = zlib.inflateRawSync(body.subarray(1), { maxOutputLength: 256 << 20 });
	else if (state.compressed && body[0] === 0xff) body = body.subarray(1);
	else if (state.compressed) throw new Error(`compression ${body[0]} is neither zlib nor none`);
	const packets = [];
	for (let at = 0; at < body.length;) {
		const [length, start] = readVarint(body, at);
		if (start + length > body.length) throw new Error('packet runs past the end of its batch');
		const packet = body.subarray(start, start + length);
		packets.push({ id: readVarint(packet, 0)[0] & 0x3ff, packet });
		at = start + length;
	}
	return packets;
}

function makeKeys() {
	const k = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
	return { ...k, der: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

function jwt(body, keys) {
	const signed = `${b64url({ alg: 'ES384', x5u: keys.der })}.${b64url(body)}`;
	return `${signed}.${crypto.sign('sha384', Buffer.from(signed), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

// The self-signed login packages/bedrock-protocol's LoginPacket and types/login read:
// AuthenticationType 2, a token and the client data, both signed by the key in cpk.
function loginPacket(ids, info, keys, port) {
	const uuid = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const token = jwt({ iat: now, nbf: now - 60, exp: now + 3600, aud: 'api://auth-minecraft-services/multiplayer', cpk: keys.der, leguuid: uuid, xname: NAME, mid: uuid, ap: 0, nid: '', nname: '', pid: '', pname: '', xid: '' }, keys);
	const auth = JSON.stringify({ AuthenticationType: 2, Token: token });
	const v = info.version;
	const data = jwt({
		AnimatedImageData: [], ArmSize: 'wide', CapeData: '', CapeId: '', CapeImageHeight: 0, CapeImageWidth: 0, CapeOnClassicSkin: false, ClientEditorConnectionIntent: 0, ClientIsEditorCapable: false, ClientRandomId: crypto.randomInt(2 ** 47),
		CompatibleWithClientSideChunkGen: false, CurrentInputMode: 1, DefaultInputMode: 1, DeviceId: uuid, DeviceModel: 'pmmp-updater', DeviceOS: 7, FilterProfanity: false, GameVersion: `${v.major}.${v.minor}.${v.patch}`, GraphicsMode: 1, GuiScale: 0,
		LanguageCode: 'en_US', MaxViewDistance: 8, MemoryTier: 0, OverrideSkin: false, PartyId: '', IsPartyLeader: false, PlatformUserId: '', PersonaPieces: [], PersonaSkin: false, PieceTintColors: [], PlatformOfflineId: '', PlatformOnlineId: '', PlatformType: 0, PremiumSkin: false, ProfileHash: '', SelfSignedId: uuid,
		ServerAddress: `127.0.0.1:${port}`, SkinAnimationData: '', SkinColor: '#0', SkinData: Buffer.alloc(64 * 64 * 4, 0xff).toString('base64'), SkinGeometryData: Buffer.from(JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.humanoid.custom', texture_width: 64, texture_height: 64 }, bones: [] }] })).toString('base64'), SkinGeometryDataEngineVersion: Buffer.from('1.14.0').toString('base64'), SkinId: NAME, SkinImageHeight: 64, SkinImageWidth: 64,
		SkinResourcePatch: Buffer.from(JSON.stringify({ geometry: { default: 'geometry.humanoid.custom' } })).toString('base64'), ThirdPartyName: NAME, TrustedSkin: false, UIProfile: 0,
	}, keys);
	const request = Buffer.concat([u32(auth.length, true), Buffer.from(auth), u32(data.length, true), Buffer.from(data)]);
	return Buffer.concat([varint(ids.LoginPacket), u32(v.protocol_version), varint(request.length), request]);
}

// The key for both directions, from a handshake JWT signed by the key it names.
function sessionKey(token, privateKey) {
	const [h, b, s] = token.split('.');
	const publicKey = crypto.createPublicKey({ key: Buffer.from(JSON.parse(Buffer.from(h, 'base64url')).x5u, 'base64'), format: 'der', type: 'spki' });
	if (!crypto.verify('sha384', Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s || '', 'base64url'))) throw new Error('handshake JWT signature does not verify');
	const salt = Buffer.from(JSON.parse(Buffer.from(b, 'base64url')).salt, 'base64');
	return crypto.createHash('sha256').update(salt).update(crypto.diffieHellman({ privateKey, publicKey })).digest();
}

// capture.bin: per packet a u16 BE ID, a u32 BE length, then the packet with its header
// varint, as BedrockProtocol's PacketPool reads it.
function encodeCapture(records) {
	return Buffer.concat(records.flatMap(({ id, packet }) => [Buffer.from([id >> 8, id & 0xff]), u32(packet.length), packet]));
}

function parseArgs(args) {
	const { values: v } = util.parseArgs({ args, strict: true, options: { 'protocol-info': { type: 'string' }, out: { type: 'string' }, port: { type: 'string', default: '19132' }, deadline: { type: 'string', default: '90' } } });
	if (!v['protocol-info'] || !v.out) throw new Error('--protocol-info and --out are required');
	const a = { protocol_info: v['protocol-info'], out: v.out, port: Number(v.port), deadline: Number(v.deadline) };
	if (!(a.port > 0 && a.port < 65536) || !(a.deadline > 0)) throw new Error('--port and --deadline must be positive numbers');
	return a;
}

function trace(a, log) {
	const info = JSON.parse(fs.readFileSync(a.protocol_info, 'utf8'));
	const ids = info.packets;
	const names = new Map(Object.entries(ids).map(([n, id]) => [id, n]));
	const keys = makeKeys();
	const guid = crypto.randomBytes(8);
	const state = { compressed: false, cipher: null };
	const records = [];
	const socket = dgram.createSocket('udp4');
	const raw = (b) => socket.send(b, a.port, '127.0.0.1');
	return new Promise((resolve) => {
		let done = false;
		const finish = (error) => {
			if (done) return;
			done = true;
			clearInterval(knock); clearTimeout(deadline); socket.close();
			fs.writeFileSync(path.join(a.out, 'capture.bin.part'), encodeCapture(records));
			fs.renameSync(path.join(a.out, 'capture.bin.part'), path.join(a.out, 'capture.bin'));
			for (const r of records) log(`${r.id}\t${names.get(r.id) || '?'}\t${r.packet.length}`);
			const missing = WANTED.filter((n) => !records.some((r) => r.id === ids[n]));
			if (error || missing.length) log(`tracer: ${error ? error.message : `missing ${missing.join(', ')}`}`);
			resolve(error || missing.length ? 1 : 0);
		};
		const deadline = setTimeout(() => finish(), a.deadline * 1000);
		const game = (...packets) => session.send(encodeBatch(packets, state));
		const onPacket = ({ id, packet }) => {
			records.push({ id, packet });
			const payload = packet.subarray(readVarint(packet, 0)[1]);
			if (id === ids.NetworkSettingsPacket) {
				state.compressed = true;
				game(loginPacket(ids, info, keys, a.port));
			} else if (id === ids.ServerToClientHandshakePacket) {
				const [length, at] = readVarint(payload, 0);
				state.cipher = new Cipher(sessionKey(payload.subarray(at, at + length).toString(), keys.privateKey));
				game(varint(ids.ClientToServerHandshakePacket));
			} else if (id === ids.PlayStatusPacket && ![0, 3].includes(payload.readUInt32BE(0))) {
				throw new Error(`PlayStatus ${payload.readUInt32BE(0)}`);
			} else if (id === ids.DisconnectPacket || id === ids.PacketViolationWarningPacket) {
				throw new Error(`${names.get(id)}: ${payload.toString('latin1').replace(/[^\x20-\x7e]+/g, ' ').trim()}`);
			} else if (id === ids.ResourcePacksInfoPacket || id === ids.ResourcePackStackPacket) {
				const [ordinal, value] = id === ids.ResourcePacksInfoPacket ? [2, 'downloadingfinished'] : [3, 'resourcepackstackfinished'];
				game(Buffer.concat([varint(ids.ResourcePackClientResponsePacket), varint(ordinal), varint(value.length), Buffer.from(value)]));
			}
			if (WANTED.every((n) => records.some((r) => r.id === ids[n]))) setTimeout(() => finish(), 2000);
		};
		const session = new Session(raw, (m) => {
			try {
				if (m[0] === 0x10) {
					session.send(Buffer.concat([Buffer.from([0x13]), LOOPBACK(a.port), ...Array(20).fill(Buffer.from([4, 0xff, 0xff, 0xff, 0xff, 0, 0])), Buffer.alloc(16)]));
					game(Buffer.concat([varint(ids.RequestNetworkSettingsPacket), u32(info.version.protocol_version)]));
				} else if (m[0] === 0x00) session.send(Buffer.concat([Buffer.from([0x03]), m.subarray(1, 9), Buffer.alloc(8)]));
				else if (m[0] === 0x15) throw new Error('the server closed the RakNet connection');
				else if (m[0] === 0xfe) decodeBatch(m, state).forEach(onPacket);
			} catch (e) {
				finish(e);
			}
		});
		socket.on('message', (b) => {
			if (b[0] === 0x06) {
				const cookie = b[25] ? [b.subarray(26, 30), Buffer.from([0])] : [];
				raw(Buffer.concat([Buffer.from([0x07]), MAGIC, ...cookie, LOOPBACK(a.port), b.subarray(-2), guid]));
			} else if (b[0] === 0x08 && session.seq === 0) {
				clearInterval(knock);
				session.send(Buffer.concat([Buffer.from([0x09]), guid, Buffer.alloc(8), Buffer.from([0])]));
			} else if (b[0] & 0x80) {
				try { session.receive(b); } catch (e) { finish(e); }
			}
		});
		const knock = setInterval(() => raw(Buffer.concat([Buffer.from([0x05]), MAGIC, Buffer.from([11]), Buffer.alloc(MTU - 46)])), 500);
		socket.bind(0, '127.0.0.1');
	});
}

if (require.main === module) trace(parseArgs(process.argv.slice(2)), (s) => process.stdout.write(`${s}\n`)).then((code) => { process.exitCode = code; });

module.exports = { WANTED, varint, readVarint, encodeFrame, decodeFrames, Session, Cipher, encodeBatch, decodeBatch, makeKeys, jwt, loginPacket, sessionKey, encodeCapture, parseArgs };

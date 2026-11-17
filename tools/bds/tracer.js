#!/usr/bin/env node
'use strict';

// A headless offline Bedrock client, run beside the server in its isolated container.
// It joins over NetherNet, or over RakNet on 127.0.0.1, logs in self-signed, answers
// the encryption handshake and the resource pack prompts, and records every packet the
// server sends, decrypted and decompressed, into capture.bin. The protocol number and
// packet IDs come from packages/bedrock-data's protocol_info.json, and what it sends is
// laid out as packages/bedrock-protocol encodes it.
//
// Usage: node tracer.js --protocol-info <json> --out <dir> [--port <n>] [--deadline <seconds>]
//   [--transport nethernet|raknet] [--blocks]
// With --blocks, for blocks-pack, it asks for a chunk radius of RADIUS and for every
// sub-chunk of each chunk sent, says it is initialised once all are answered and QUIET ms
// pass without a join packet, and ends 2 s after the pack's chat line naming RIFTAL_.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const zlib = require('zlib');
const nethernet = require('./nethernet');
const raknet = require('./raknet');

const NAME = 'PmmpUpdater';
// BDS 1.26.63.1 refuses a self-signed login whose client data names Windows 10 (DeviceOS
// 7) as "Connection Request invalid", and accepts Linux, which the tracer runs on.
const DEVICE_OS = 15;
// Every packet ADR 002 sources a BedrockData file from. The session ends once all arrived.
const WANTED = ['StartGamePacket', 'ItemRegistryPacket', 'CreativeContentPacket', 'CraftingDataPacket', 'BiomeDefinitionListPacket', 'AvailableActorIdentifiersPacket', 'JigsawStructureDataPacket', 'VoxelShapesPacket'];
// blocks-pack sets its blocks in chunks at most 3.6 chunks from the spawn's.
const RADIUS = 6;
const QUIET = 5000;
// The overworld's sub-chunks, y -4 to 19.
const SUB_CHUNKS = 24;

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

// A game batch is, once NetworkSettings has arrived, a compression byte, then
// length-prefixed packets. Once the handshake is done, all of it is encrypted.
function encodeBatch(packets, state) {
	let body = Buffer.concat(packets.flatMap((p) => [varint(p.length), p]));
	if (state.compressed) body = Buffer.concat([Buffer.from([0]), zlib.deflateRawSync(body)]);
	return state.cipher ? state.cipher.encrypt(body) : body;
}

function decodeBatch(message, state) {
	let body = message;
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
	// Random, so the compressed login is larger than one NetherNet segment and every run
	// shows BDS joining segments.
	const skin = crypto.randomBytes(64 * 64 * 4).toString('base64');
	const token = jwt({ iat: now, nbf: now - 60, exp: now + 3600, aud: 'api://auth-minecraft-services/multiplayer', cpk: keys.der, leguuid: uuid, xname: NAME, mid: uuid, ap: 0, nid: '', nname: '', pid: '', pname: '', xid: '' }, keys);
	const auth = JSON.stringify({ AuthenticationType: 2, Token: token });
	const v = info.version;
	const data = jwt({
		AnimatedImageData: [], ArmSize: 'wide', CapeData: '', CapeId: '', CapeImageHeight: 0, CapeImageWidth: 0, CapeOnClassicSkin: false, ClientEditorConnectionIntent: 0, ClientIsEditorCapable: false, ClientRandomId: crypto.randomInt(2 ** 47),
		CompatibleWithClientSideChunkGen: false, CurrentInputMode: 1, DefaultInputMode: 1, DeviceId: uuid, DeviceModel: 'pmmp-updater', DeviceOS: DEVICE_OS, FilterProfanity: false, GameVersion: `${v.major}.${v.minor}.${v.patch}`, GraphicsMode: 1, GuiScale: 0,
		LanguageCode: 'en_US', MaxViewDistance: 8, MemoryTier: 0, OverrideSkin: false, PartyId: '', IsPartyLeader: false, PlatformUserId: '', PersonaPieces: [], PersonaSkin: false, PieceTintColors: [], PlatformOfflineId: '', PlatformOnlineId: '', PlatformType: 0, PremiumSkin: false, ProfileHash: '', SelfSignedId: uuid,
		ServerAddress: `127.0.0.1:${port}`, SkinAnimationData: '', SkinColor: '#0', SkinData: skin, SkinGeometryData: Buffer.from(JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.humanoid.custom', texture_width: 64, texture_height: 64 }, bones: [] }] })).toString('base64'), SkinGeometryDataEngineVersion: Buffer.from('1.14.0').toString('base64'), SkinId: NAME, SkinImageHeight: 64, SkinImageWidth: 64,
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

// A SubChunkRequestPacket for the overworld sub-chunks y -4 to 19 of the chunk a
// LevelChunkPacket payload names: the dimension, the y offsets from the base, then the
// base, the chunk's x and z at sub-chunk y 0.
function subChunkRequest(ids, chunk) {
	const zigzag = (u) => (u % 2 ? -(u + 1) / 2 : u / 2);
	const [x, at] = readVarint(chunk, 0);
	const base = Buffer.alloc(12);
	base.writeInt32LE(zigzag(x));
	base.writeInt32LE(zigzag(readVarint(chunk, at)[0]), 8);
	const offsets = Array.from({ length: SUB_CHUNKS }, (_, i) => Buffer.from([0, (i - 4) & 0xff, 0]));
	return Buffer.concat([varint(ids.SubChunkRequestPacket), varint(0), varint(offsets.length), ...offsets, base]);
}

// The number of entries a SubChunkPacket payload answers with, which follows the cache
// flag, the dimension and the base position.
const subChunkCount = (p) => readVarint(p, readVarint(p, 1)[1] + 12)[0];

function parseArgs(args) {
	const { values: v } = util.parseArgs({ args, strict: true, options: { 'protocol-info': { type: 'string' }, out: { type: 'string' }, port: { type: 'string', default: '19132' }, deadline: { type: 'string', default: '90' }, transport: { type: 'string', default: 'nethernet' }, blocks: { type: 'boolean', default: false } } });
	if (!v['protocol-info'] || !v.out) throw new Error('--protocol-info and --out are required');
	const a = { protocol_info: v['protocol-info'], out: v.out, port: Number(v.port), deadline: Number(v.deadline), transport: v.transport, blocks: v.blocks };
	if (!(a.port > 0 && a.port < 65536) || !(a.deadline > 0)) throw new Error('--port and --deadline must be positive numbers');
	if (!['nethernet', 'raknet'].includes(a.transport)) throw new Error('--transport must be nethernet or raknet');
	return a;
}

function trace(a, log, transport) {
	const info = JSON.parse(fs.readFileSync(a.protocol_info, 'utf8'));
	const ids = info.packets;
	const names = new Map(Object.entries(ids).map(([n, id]) => [id, n]));
	const keys = makeKeys();
	const state = { compressed: false, cipher: null };
	const records = [];
	const wanted = () => WANTED.every((n) => records.some((r) => r.id === ids[n]));
	const blocks = { pending: 0, spawned: false, initialised: false, done: false, quiet: null, runtime: 0 };
	// Every packet that can change whether --blocks is ready to say it is initialised.
	const join = new Set([ids.LevelChunkPacket, ids.SubChunkPacket, ids.PlayStatusPacket, ...WANTED.map((n) => ids[n])]);
	const link = transport || (a.transport === 'raknet' ? raknet.transport(a.port) : nethernet.transport({ port: a.port, info, keys, log }));
	return new Promise((resolve) => {
		let done = false;
		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(deadline); clearTimeout(blocks.quiet); link.close();
			fs.writeFileSync(path.join(a.out, 'capture.bin.part'), encodeCapture(records));
			fs.renameSync(path.join(a.out, 'capture.bin.part'), path.join(a.out, 'capture.bin'));
			// A --blocks session carries thousands of block updates, so it logs a count per ID.
			if (a.blocks) for (const [id, rs] of Map.groupBy(records, (r) => r.id)) log(`${id}\t${names.get(id) || '?'}\t${rs.length} packets`);
			else for (const r of records) log(`${r.id}\t${names.get(r.id) || '?'}\t${r.packet.length}`);
			const missing = WANTED.filter((n) => !records.some((r) => r.id === ids[n]));
			if (a.blocks && !blocks.done) missing.push('blocks-pack\'s RIFTAL_ chat line');
			if (error || missing.length) log(`tracer: ${error ? error.message : `missing ${missing.join(', ')}`}`);
			resolve(error || missing.length ? 1 : 0);
		};
		const deadline = setTimeout(() => finish(), a.deadline * 1000);
		const game = (...packets) => link.send(encodeBatch(packets, state));
		const onPacket = ({ id, packet }) => {
			records.push({ id, packet });
			const payload = packet.subarray(readVarint(packet, 0)[1]);
			if (id === ids.PlayStatusPacket && payload.readUInt32BE(0) === 3) blocks.spawned = true;
			if (id === ids.NetworkSettingsPacket) {
				state.compressed = true;
				game(loginPacket(ids, info, keys, a.port));
			} else if (id === ids.ServerToClientHandshakePacket) {
				const [length, at] = readVarint(payload, 0);
				const key = sessionKey(payload.subarray(at, at + length).toString(), keys.privateKey);
				if (link.bedrockCipher) state.cipher = new Cipher(key);
				game(varint(ids.ClientToServerHandshakePacket));
			} else if (id === ids.PlayStatusPacket && ![0, 3].includes(payload.readUInt32BE(0))) {
				throw new Error(`PlayStatus ${payload.readUInt32BE(0)}`);
			} else if (id === ids.DisconnectPacket || id === ids.PacketViolationWarningPacket) {
				throw new Error(`${names.get(id)}: ${payload.toString('latin1').replace(/[^\x20-\x7e]+/g, ' ').trim()}`);
			} else if (id === ids.ResourcePacksInfoPacket || id === ids.ResourcePackStackPacket) {
				const [ordinal, value] = id === ids.ResourcePacksInfoPacket ? [2, 'downloadingfinished'] : [3, 'resourcepackstackfinished'];
				game(Buffer.concat([varint(ids.ResourcePackClientResponsePacket), varint(ordinal), varint(value.length), Buffer.from(value)]));
			} else if (a.blocks && id === ids.StartGamePacket) {
				// The actor runtime ID follows the actor unique ID, a varlong skipped here.
				let at = 0;
				while (payload[at++] & 0x80);
				blocks.runtime = readVarint(payload, at)[0];
				game(Buffer.concat([varint(ids.RequestChunkRadiusPacket), varint(2 * RADIUS), Buffer.from([RADIUS])]));
			} else if (a.blocks && id === ids.LevelChunkPacket) {
				blocks.pending += SUB_CHUNKS;
				game(subChunkRequest(ids, payload));
			} else if (a.blocks && id === ids.SubChunkPacket) {
				blocks.pending -= subChunkCount(payload);
			} else if (a.blocks && id === ids.TextPacket && packet.includes('RIFTAL_') && !blocks.done) {
				blocks.done = true;
				setTimeout(() => finish(), 2000);
			}
			if (!a.blocks && wanted()) setTimeout(() => finish(), 2000);
			if (a.blocks && !blocks.initialised && join.has(id)) {
				clearTimeout(blocks.quiet);
				blocks.quiet = setTimeout(() => {
					if (!blocks.spawned || blocks.pending > 0 || !wanted()) return;
					blocks.initialised = true;
					game(Buffer.concat([varint(ids.SetLocalPlayerAsInitializedPacket), varint(blocks.runtime)]));
				}, a.quiet || QUIET);
			}
		};
		link.open((m) => decodeBatch(m, state).forEach(onPacket), finish)
			.then(() => game(Buffer.concat([varint(ids.RequestNetworkSettingsPacket), u32(info.version.protocol_version)])))
			.catch(finish);
	});
}

if (require.main === module) trace(parseArgs(process.argv.slice(2)), (s) => process.stdout.write(`${s}\n`)).then((code) => { process.exitCode = code; });

module.exports = { WANTED, varint, readVarint, Cipher, encodeBatch, decodeBatch, makeKeys, jwt, loginPacket, sessionKey, encodeCapture, subChunkRequest, subChunkCount, parseArgs, trace };

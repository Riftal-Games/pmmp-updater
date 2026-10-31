'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const scan = require('../scan');
const fx = require('../../test-support/fixtures');

// A minimal PE32+ image: headers, an .rdata section holding the given strings and an
// .rsrc section holding a VS_FIXEDFILEINFO for the given four-part version.
function fakePe(strings, version) {
	const rdata = Buffer.from('\0' + strings.join('\0') + '\0', 'latin1');
	const rsrc = Buffer.alloc(64);
	rsrc.writeUInt32LE(scan.VS_FIXEDFILEINFO_SIGNATURE, 8);
	const [a, b, c, d] = version.split('.').map(Number);
	rsrc.writeUInt32LE(((a << 16) | b) >>> 0, 16);
	rsrc.writeUInt32LE(((c << 16) | d) >>> 0, 20);
	const peOff = 0x40;
	const optSize = 0xf0;
	const secTable = peOff + 24 + optSize;
	const headerEnd = 0x200;
	const buf = Buffer.alloc(headerEnd + rdata.length + rsrc.length);
	buf.write('MZ', 0, 'latin1');
	buf.writeUInt32LE(peOff, 0x3c);
	buf.writeUInt32LE(0x4550, peOff);
	buf.writeUInt16LE(2, peOff + 6);
	buf.writeUInt16LE(optSize, peOff + 20);
	const section = (i, name, raw, size) => {
		const o = secTable + i * 40;
		buf.write(name, o, 'latin1');
		buf.writeUInt32LE(size, o + 16);
		buf.writeUInt32LE(raw, o + 20);
	};
	section(0, '.rdata', headerEnd, rdata.length);
	section(1, '.rsrc', headerEnd + rdata.length, rsrc.length);
	rdata.copy(buf, headerEnd);
	rsrc.copy(buf, headerEnd + rdata.length);
	return buf;
}

function brarchive(entries) {
	const header = Buffer.alloc(16 + entries.length * 256);
	header.writeBigUInt64LE(scan.BRARCHIVE_MAGIC, 0);
	header.writeUInt32LE(entries.length, 8);
	header.writeUInt32LE(1, 12);
	const bodies = [];
	let offset = 0;
	entries.forEach(([name, body], i) => {
		const o = 16 + i * 256;
		header[o] = name.length;
		header.write(name, o + 1, 'utf8');
		const data = Buffer.from(body);
		header.writeUInt32LE(offset, o + 248);
		header.writeUInt32LE(data.length, o + 252);
		bodies.push(data);
		offset += data.length;
	});
	return Buffer.concat([header, ...bodies]);
}

function fakeClient() {
	return fx.writeTree(fx.tempDir('client'), {
		'MicrosoftGame.Config': '<Game><Identity Name="Microsoft.MinecraftUWP" Version="1.2.305.0" /></Game>',
		'Minecraft.Windows.exe': fakePe(['AlphaPacket', 'AEBVAlphaPacket', 'NewPacket', 'QEAVNewPacket', 'NotAPacketName'], '1.2.30.5'),
		'data/packetlimitconfig.json': JSON.stringify({ limitGroups: [{ minecraftPacketIds: [9, 4] }, { minecraftPacketIds: [9] }] }),
		'data/behavior_packs/vanilla/__brarchive/entities.brarchive': brarchive([['pig.json', '{}'], ['cow.json', '{}']]),
		'data/behavior_packs/vanilla_1.2.20/__brarchive/entities.brarchive': brarchive([['pig.json', '{}']]),
		'data/behavior_packs/vanilla_1.2.30/__brarchive/entities.brarchive': brarchive([['pig.json', '{}'], ['owl.json', '{}']]),
		'data/behavior_packs/vanilla_1.2.30/contents.json': JSON.stringify({ content: [{ path: 'entities/owl.json' }, { path: 'loot_tables/owl.json' }] }),
		'data/resource_packs/vanilla_1.2.30/contents.json': JSON.stringify({ content: [{ path: 'textures/blocks/owl_egg.png' }] }),
	});
}

function fakePackages(protocol, version) {
	return fx.writeTree(fx.tempDir('pkg'), {
		'ProtocolInfo.php': fx.protocolInfoPhp(protocol, version, { ALPHA: 1 }),
		'AlphaPacket.php': '',
	});
}

test('reads version, packet names and the newest content delta from a client tree', () => {
	const s = scan.scan({ client: fakeClient(), offline: true, packagesSrc: fakePackages(5, '1.2.30') });
	assert.equal(s.client.package_version, '1.2.305.0');
	assert.equal(s.client.exe_file_version, '1.2.30.5');
	assert.equal(s.client.game_version, '1.2.30');
	assert.deepEqual(s.client_packet_names, ['AlphaPacket', 'NewPacket']);
	assert.deepEqual(s.not_in_packages, ['NewPacket']);
	assert.deepEqual(s.packet_limit_ids, [4, 9]);
	assert.deepEqual(s.behavior_delta.introduced, { entities: ['owl.json'], loot_tables: ['owl.json'] });
	assert.deepEqual(s.resource_delta.changed, { 'textures/blocks': ['owl_egg.png'] });
});

test('decorated MSVC names collapse onto the real class name', () => {
	assert.deepEqual(scan.dropDecorated(['AEBVBlockEventPacket', 'BlockEventPacket', 'SAXAEBVPlayerAuthInputPacket'], ['PlayerAuthInputPacket']), ['BlockEventPacket']);
});

test('the verdict follows the protocol number when Mojang supplies one', () => {
	const ours = { protocol: 2225, version: '1.26.60' };
	assert.match(scan.verdict(ours, { game_version: '1.26.60', protocol: { tag: 'v1.26.60', protocol: 2225 } }), /^CURRENT:/);
	assert.match(scan.verdict(ours, { game_version: '1.26.61', protocol: { tag: 'v1.26.61', protocol: 2225 } }), /^CURRENT PROTOCOL:/);
	assert.match(scan.verdict(ours, { game_version: '1.26.70', protocol: { tag: 'v1.26.70', protocol: 2239 } }), /^BEHIND: the client speaks 2239/);
	assert.match(scan.verdict(ours, { game_version: '1.26.70', protocol: null }), /^BEHIND BY VERSION/);
	assert.match(scan.verdict(ours, { game_version: null, protocol: null }), /^UNKNOWN/);
});

test('live: the installed client is readable', { skip: !process.env.RIFTAL_LIVE_CLIENT }, () => {
	const s = scan.scan({ client: process.env.RIFTAL_LIVE_CLIENT, offline: false, packagesSrc: path.join(__dirname, '..', '..', '..', 'packages', 'bedrock-protocol', 'src') });
	assert.ok(s.client.game_version);
	assert.ok(s.client.protocol && s.client.protocol.protocol > 0);
	assert.ok(s.client_packet_names.length > 100);
});

'use strict';

// Reads what our own packages currently implement, so tools compare Mojang's docs and the
// installed client against this repository rather than against any upstream.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PROTOCOL_SRC = path.join(REPO, 'packages', 'bedrock-protocol', 'src');

function readProtocolInfo(src = PROTOCOL_SRC) {
	const text = fs.readFileSync(path.join(src, 'ProtocolInfo.php'), 'utf8');
	const num = (re) => { const m = re.exec(text); return m ? m[1] : null; };
	const ids = new Map();
	for (const m of text.matchAll(/public const ([A-Z0-9_]+)_PACKET = (0x[0-9a-fA-F]+|\d+);/g)) ids.set(m[1], Number(m[2]));
	return {
		protocol: Number(num(/CURRENT_PROTOCOL = (\d+);/)),
		version: num(/MINECRAFT_VERSION_NETWORK = '([^']+)';/),
		ids,
	};
}

const NOT_PACKETS = new Set(['DataPacket', 'Packet', 'ClientboundPacket', 'ServerboundPacket']);

function packetClasses(src = PROTOCOL_SRC) {
	return fs.readdirSync(src).filter((n) => /Packet\.php$/.test(n)).map((n) => n.replace(/\.php$/, '')).filter((n) => !NOT_PACKETS.has(n)).sort();
}

// SetPassengerOfBlockPacket -> SET_PASSENGER_OF_BLOCK, the ProtocolInfo constant stem.
function constantStem(packetName) {
	return packetName.replace(/Packet$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toUpperCase();
}

// The core checkout next to this one. Its folder is named PocketMine-MP after its
// repository, or pmmp-core; PocketMine-MP wins when both exist.
function siblingCoreDir(parent = path.join(REPO, '..')) {
	const named = path.join(parent, 'PocketMine-MP');
	return fs.existsSync(named) ? named : path.join(parent, 'pmmp-core');
}

// What the core checkout pins, which is what the server image actually speaks. Null
// when there is no checkout there. A package composer resolves from a path repository
// has a dist and no source, so its source is the dist type and url, for example
// "path deps/pmmp-updater/packages/bedrock-protocol".
function corePin(coreDir = siblingCoreDir()) {
	const lockFile = path.join(coreDir, 'composer.lock');
	if (!fs.existsSync(lockFile)) return null;
	const entry = JSON.parse(fs.readFileSync(lockFile, 'utf8')).packages.find((p) => p.name === 'axolotl-pm/bedrock-protocol');
	if (!entry) return null;
	const m = /\+bedrock-(\d+(?:\.\d+)+)$/.exec(entry.version);
	return { package_version: entry.version, version: m ? m[1] : null, source: pinSource(entry) };
}

function pinSource(entry) {
	if (entry.source && entry.source.url) return entry.source.url;
	if (entry.dist && entry.dist.url) return `${entry.dist.type} ${entry.dist.url}`;
	return null;
}

module.exports = { REPO, PROTOCOL_SRC, readProtocolInfo, packetClasses, constantStem, siblingCoreDir, corePin };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const docs = require('../../lib/mojang-docs');
const pkg = require('../../lib/packages');
const fx = require('../../test-support/fixtures');
const { run, generate, parseArgs, camel, upperSnake, TODO } = require('../generate');
const { parse } = require('./php-shape');

const P = 500;
const at = (i, body) => ({ ...body, 'x-ordinal-index': i });
const int = (ut, opts) => ({ type: 'integer', 'x-underlying-type': ut, ...(opts ? { 'x-serialization-options': opts } : {}) });

const SHARED = {
	ActorUniqueID: { type: 'object', properties: { 'Actor Unique ID': at(0, int('int64', ['Compression'])) }, required: ['Actor Unique ID'] },
	BlockPos: { type: 'object', properties: { X: at(0, int('int32', ['Compression'])), Y: at(1, int('int32', ['Compression'])), Z: at(2, int('int32', ['Compression'])) }, required: ['X', 'Y', 'Z'] },
	Mode: { type: 'string', enum: ['Off', 'On', 'AutoMode'], 'x-underlying-type': 'uint8', 'x-enum-binary-value': [0, 1, 5] },
	Spot: { type: 'object', properties: { Where: at(0, { $ref: './BlockPos.json' }), Note: at(1, { type: 'string' }) }, required: ['Where'] },
	Token: { type: 'object', properties: { 'Compact JWT': at(0, { type: 'string' }) }, required: ['Compact JWT'] },
	LooseKind: { type: 'string', enum: ['A', 'B'], 'x-underlying-type': 'uint8' },
	Shade: { type: 'string', enum: ['Light', 'Dark Grey'], 'x-underlying-type': 'uint8', 'x-enum-binary-value': [0, 1] },
	DeltaPacket: fx.packet('DeltaPacket', 9, P),
	DeltaPacketPayload: { type: 'object', properties: { Volume: at(0, { type: 'number', 'x-underlying-type': 'float' }) }, required: ['Volume'] },
};

const ALPHA_FIELDS = {
	Count: at(2, int('int32', ['Compression'])),
	Mode: at(0, { $ref: './Mode.json', 'x-underlying-type': 'uint8', 'x-serialization-options': ['Enum-as-Value'] }),
	Name: at(1, { type: 'string' }),
	Flag: at(3, { type: 'boolean', 'x-underlying-type': 'boolean' }),
	Big: at(4, int('int32', ['Big Endian'])),
	Ratio: at(5, { type: 'number', 'x-underlying-type': 'float' }),
	Owner: at(6, { $ref: './ActorUniqueID.json' }),
	Spot: at(7, { $ref: './Spot.json' }),
	Token: at(8, { $ref: './Token.json' }),
	Spots: at(9, { type: 'array', items: { $ref: './Spot.json' } }),
	Kind: at(10, { type: 'string', enum: ['Plain', 'Fancy'], 'x-underlying-type': 'uint8', 'x-enum-binary-value': [0, 4], 'x-serialization-options': ['Enum-as-Value'] }),
	Maybe: at(11, int('int64')),
	Shade: at(12, { $ref: './Shade.json', 'x-underlying-type': 'uint8' }),
	Tone: at(13, { type: 'string', enum: ['Warm', 'Cool'], 'x-underlying-type': 'uint8' }),
};

function fixtureDocs(extra = {}) {
	return fx.writeTree(fx.tempDir('codegen'), fx.docsTree(P, {
		...SHARED,
		ClientboundAlphaPacket: fx.packet('ClientboundAlphaPacket', 7, P),
		ClientboundAlphaPacketPayload: { type: 'object', properties: ALPHA_FIELDS, required: Object.keys(ALPHA_FIELDS).filter((k) => k !== 'Maybe') },
		ServerboundBetaPacket: fx.packet('ServerboundBetaPacket', 8, P),
		ServerboundBetaPacketPayload: { type: 'object' },
		GammaPacket: fx.schema('GammaPacket', P, { description: 'Sent by server only.', $ref: './GammaPacketPayload.json', $metaProperties: { '[cereal:packet]': 10 } }),
		GammaPacketPayload: { type: 'object', properties: { Sound: at(0, { $ref: './DeltaPacketPayload.json' }) }, required: ['Sound'] },
		EpsilonPacket: fx.packet('EpsilonPacket', 11, P),
		EpsilonPacketPayload: {
			type: 'object',
			properties: {
				Pick: at(0, { oneOf: [{ type: 'string' }, { type: 'boolean' }] }),
				Raw: at(1, { type: 'array', items: { type: 'string' }, 'x-serialization-options': ['No size compression'] }),
				Odd: at(2, int('int32', ['Mystery Option'])),
				Loose: at(3, { $ref: './LooseKind.json', 'x-serialization-options': ['Enum-as-Value'] }),
			},
			required: ['Pick', 'Raw', 'Odd', 'Loose'],
		},
		ZetaPacket: fx.packet('ZetaPacket', 12, P),
		ZetaPacketPayload: { type: 'object', properties: { First: { type: 'string' }, Second: { type: 'string' } }, required: ['First', 'Second'] },
		...extra,
	}));
}

function gen(names, extra) {
	return generate(docs.loadDocs(fixtureDocs(extra)), names);
}

test('names: Mojang field names become camel case, enum values upper snake case', () => {
	assert.equal(camel('Destination Name'), 'destinationName');
	assert.equal(camel('Actor Unique ID'), 'actorUniqueId');
	assert.equal(camel('PassengerOfBlockData'), 'passengerOfBlockData');
	assert.equal(camel('Compact JWT'), 'compactJwt');
	assert.equal(upperSnake('MatchFound'), 'MATCH_FOUND');
	assert.equal(upperSnake('PlayerLeftParty'), 'PLAYER_LEFT_PARTY');
});

test('a packet carries its ID constant, direction and handler, and fields in x-ordinal-index order', () => {
	const r = gen(['ClientboundAlphaPacket']);
	const s = parse(r.files.get('ClientboundAlphaPacket.php'));
	assert.equal(s.name, 'ClientboundAlphaPacket');
	assert.equal(s.networkId, 'CLIENTBOUND_ALPHA_PACKET');
	assert.deepEqual(s.implements, ['ClientboundPacket']);
	assert.equal(s.handle, 'handleClientboundAlpha');
	assert.deepEqual(s.properties.map((p) => p.name), ['mode', 'name', 'count', 'flag', 'big', 'ratio', 'owner', 'spot', 'token', 'spots', 'kind', 'maybe', 'shade', 'tone']);
	assert.deepEqual(s.create, s.properties.map((p) => ({ ...p, readonly: false })));
});

test('wire calls follow x-underlying-type and x-serialization-options, and fields not required are optional', () => {
	const s = parse(gen(['ClientboundAlphaPacket']).files.get('ClientboundAlphaPacket.php'));
	assert.deepEqual(s.properties.map((p) => p.type), ['Mode', 'string', 'int', 'bool', 'int', 'float', 'int', 'Spot', 'string', 'array', 'AlphaKind', '?int', 'Shade', 'AlphaTone']);
	assert.deepEqual(s.decode, [
		'Mode::fromPacket', 'Byte::readUnsigned',
		'CommonTypes::getString',
		'VarInt::readSignedInt',
		'CommonTypes::getBool',
		'BE::readSignedInt',
		'LE::readFloat',
		'CommonTypes::getActorUniqueId',
		'Spot::read',
		'CommonTypes::getString',
		'CommonTypes::readList', 'Spot::read',
		'AlphaKind::fromPacket', 'Byte::readUnsigned',
		'CommonTypes::readOptional', 'LE::readSignedLong',
		'Shade::fromPacket', 'CommonTypes::getString',
		'AlphaTone::fromPacket', 'CommonTypes::getString',
	]);
	assert.deepEqual(s.decodeTargets, [
		'mode', 'mode', 'name', 'count', 'flag', 'big', 'ratio', 'owner', 'spot', 'token', 'spots', 'spots',
		'kind', 'kind', 'maybe', 'maybe', 'shade', 'shade', 'tone', 'tone',
	]);
	assert.deepEqual(s.encode, [
		'Byte::writeUnsigned',
		'CommonTypes::putString',
		'VarInt::writeSignedInt',
		'CommonTypes::putBool',
		'BE::writeSignedInt',
		'LE::writeFloat',
		'CommonTypes::putActorUniqueId',
		'->write',
		'CommonTypes::putString',
		'CommonTypes::writeList', '->write',
		'Byte::writeUnsigned',
		'CommonTypes::writeOptional', 'LE::writeSignedLong',
		'CommonTypes::putString',
		'CommonTypes::putString',
	]);
});

test('enums under Enum-as-Value become int-backed enums carrying Mojang binary values, inline ones named after their packet', () => {
	const r = gen(['ClientboundAlphaPacket']);
	assert.deepEqual(parse(r.files.get('types/Mode.php')), {
		kind: 'enum', namespace: 'pocketmine\\network\\mcpe\\protocol\\types', name: 'Mode', backing: 'int', traits: ['PacketIntEnumTrait'],
		cases: [{ name: 'OFF', value: '0' }, { name: 'ON', value: '1' }, { name: 'AUTO_MODE', value: '5' }],
	});
	assert.deepEqual(parse(r.files.get('types/AlphaKind.php')).cases, [{ name: 'PLAIN', value: '0' }, { name: 'FANCY', value: '4' }]);
});

test('enums without Enum-as-Value go on the wire as their names, through string-backed enums', () => {
	const r = gen(['ClientboundAlphaPacket']);
	assert.deepEqual(parse(r.files.get('types/Shade.php')), {
		kind: 'enum', namespace: 'pocketmine\\network\\mcpe\\protocol\\types', name: 'Shade', backing: 'string', traits: ['PacketOrdinalEnumTrait'],
		cases: [{ name: 'LIGHT', value: "'Light'" }, { name: 'DARK_GREY', value: "'Dark Grey'" }],
	});
	assert.deepEqual(parse(r.files.get('types/AlphaTone.php')).cases, [{ name: 'WARM', value: "'Warm'" }, { name: 'COOL', value: "'Cool'" }]);
	const text = r.files.get('ClientboundAlphaPacket.php');
	assert.match(text, /\$this->shade = Shade::fromPacket\(CommonTypes::getString\(\$in\)\);/);
	assert.match(text, /CommonTypes::putString\(\$out, \$this->shade->value\);/);
	assert.match(text, /\$this->tone = AlphaTone::fromPacket\(CommonTypes::getString\(\$in\)\);/);
	assert.equal((text.match(/Byte::readUnsigned/g) || []).length, 2, 'only Mode and Kind, which carry Enum-as-Value, read a byte');
});

test('an enum sent both as its value and as its name, or by name with wire options, is marked; allowed unknown values are marked in the draft', () => {
	const r = gen(['ClientboundAlphaPacket'], {
		ClientboundAlphaPacketPayload: {
			type: 'object',
			properties: {
				ByValue: at(0, { $ref: './Shade.json', 'x-underlying-type': 'uint8', 'x-serialization-options': ['Enum-as-Value'] }),
				ByName: at(1, { $ref: './Shade.json', 'x-underlying-type': 'uint8' }),
				Packed: at(2, { $ref: './LooseKind.json', 'x-underlying-type': 'uint8', 'x-serialization-options': ['Compression'] }),
				Open: at(3, { $ref: './Mode.json', 'x-underlying-type': 'uint8', 'x-serialization-options': ['Enum-as-Value', 'Allow unknown enum values'] }),
				Opens: at(4, { type: 'array', items: { $ref: './Mode.json', 'x-underlying-type': 'uint8', 'x-serialization-options': ['Enum-as-Value', 'Allow unknown enum values'] } }),
			},
			required: ['ByValue', 'ByName', 'Packed', 'Open', 'Opens'],
		},
	});
	assert.deepEqual(r.todos, [
		'ClientboundAlphaPacket.ByName: enum Shade is sent as its name here and as its value elsewhere; one PHP enum cannot be backed by both',
		'ClientboundAlphaPacket.Packed: enum LooseKind is sent as its name, with compression, which the package has no pattern for',
		'ClientboundAlphaPacket.Open: Mode allows unknown values, which fromPacket rejects',
		'ClientboundAlphaPacket.Opens item: Mode allows unknown values, which fromPacket rejects',
	]);
	const text = r.files.get('ClientboundAlphaPacket.php');
	for (const t of r.todos) {
		const [where, reason] = t.split(': ');
		const field = where.split('.')[1].replace(/ item$/, '');
		assert.equal(text.split(`// ${TODO}: ${field}: ${reason}\n`).length - 1, 2, `${field} is marked in both decode and encode`);
	}
	assert.match(text, /\/\/ TODO\(codegen\): Open: [^\n]*\n\t\t\$this->open = Mode::fromPacket\(Byte::readUnsigned\(\$in\)\);/);
});

test('every marker in the report is in a draft, and every marker in a draft is in the report', () => {
	const r = gen(['EpsilonPacket', 'ZetaPacket', 'GammaPacket', 'ClientboundAlphaPacket'], {
		GammaPacketPayload: { type: 'object', properties: { Sound: at(0, { $ref: './DeltaPacketPayload.json' }) } },
		ClientboundAlphaPacketPayload: {
			type: 'object',
			properties: { Open: at(0, { $ref: './Mode.json', 'x-underlying-type': 'uint8', 'x-serialization-options': ['Enum-as-Value', 'Allow unknown enum values'] }) },
			required: ['Open'],
		},
	});
	const drafted = new Set();
	for (const text of r.files.values()) for (const m of text.matchAll(/\/\/ TODO\(codegen\): (?:[^:\n]+: )?([^\n]+)/g)) drafted.add(m[1]);
	const reported = new Set(r.todos.map((t) => t.slice(t.indexOf(': ') + 2)));
	assert.ok(reported.has('an optional embedded packet'));
	assert.ok(reported.has('Mode allows unknown values, which fromPacket rejects'));
	assert.deepEqual([...drafted].sort(), [...reported].sort());
});

test('object refs become type classes, single-field wrappers inline, known types use CommonTypes', () => {
	const r = gen(['ClientboundAlphaPacket']);
	assert.deepEqual([...r.files.keys()].sort(), ['ClientboundAlphaPacket.php', 'types/AlphaKind.php', 'types/AlphaTone.php', 'types/Mode.php', 'types/Shade.php', 'types/Spot.php']);
	const spot = parse(r.files.get('types/Spot.php'));
	assert.equal(spot.final, true);
	assert.deepEqual(spot.ctor, [{ type: 'BlockPosition', name: 'where', readonly: true }, { type: '?string', name: 'note', readonly: true }]);
	assert.deepEqual(spot.read, ['CommonTypes::getBlockPosition', 'CommonTypes::readOptional', 'CommonTypes::getString', 'new self']);
	assert.deepEqual(spot.write, ['CommonTypes::putBlockPosition', 'CommonTypes::writeOptional', 'CommonTypes::putString']);
	const text = r.files.get('ClientboundAlphaPacket.php');
	assert.match(text, /use pocketmine\\network\\mcpe\\protocol\\types\\Spot;/);
	assert.match(text, /@phpstan-var list<Spot>/);
	assert.match(text, /\$this->token = CommonTypes::getString\(\$in\);/, 'a one-field wrapper is read as its field');
	assert.ok(!r.files.has('types/Token.php') && !r.files.has('types/ActorUniqueID.php') && !r.files.has('types/BlockPos.php'));
});

test('a payload that is another packet\'s payload embeds that packet, and "Sent by server only" sets the direction', () => {
	const r = gen(['GammaPacket']);
	const s = parse(r.files.get('GammaPacket.php'));
	assert.deepEqual(s.implements, ['ClientboundPacket']);
	assert.deepEqual(s.properties, [{ type: 'DeltaPacket', name: 'sound' }]);
	assert.deepEqual(s.decode, ['new DeltaPacket', '->decodePayload']);
	assert.deepEqual(s.encode, ['->encodePayload']);
	assert.deepEqual([...r.files.keys()], ['GammaPacket.php']);
});

test('an empty payload gives empty encode and decode', () => {
	const s = parse(gen(['ServerboundBetaPacket']).files.get('ServerboundBetaPacket.php'));
	assert.deepEqual(s.implements, ['ServerboundPacket']);
	assert.deepEqual([s.properties, s.create, s.decode, s.encode], [[], [], [], []]);
});

test('what the schema cannot decide is marked TODO(codegen), and nothing else is', () => {
	const clean = gen(['ClientboundAlphaPacket', 'ServerboundBetaPacket', 'GammaPacket']);
	assert.deepEqual(clean.todos, []);
	for (const text of clean.files.values()) assert.ok(!text.includes(TODO));

	const r = gen(['EpsilonPacket', 'ZetaPacket']);
	assert.deepEqual(r.todos, [
		'EpsilonPacket.Pick: a variant type (oneOf/anyOf/allOf); pick the encoding by its discriminator',
		'EpsilonPacket.Raw: an array with No size compression; the length prefix is not a varint',
		'EpsilonPacket.Odd: unknown x-serialization-options mysteryoption',
		'LooseKind: enum values not published; index order assumed',
		'EpsilonPacket: direction not stated by the schema; keep the interface the packet travels as',
		'ZetaPacket: field order not given by x-ordinal-index; schema order used',
		'ZetaPacket: direction not stated by the schema; keep the interface the packet travels as',
	]);
	const eps = r.files.get('EpsilonPacket.php');
	assert.equal(eps.split(TODO).length - 1, 1 + 3 * 2, 'one class marker, and one per undecided field in each of decode and encode');
	assert.match(eps, /^\/\/ TODO\(codegen\): direction not stated[^\n]*\nfinal class EpsilonPacket extends DataPacket implements ClientboundPacket, ServerboundPacket\{/m);
	assert.match(eps, /private mixed \$pick;/);
	assert.match(r.files.get('types/LooseKind.php'), /^\/\/ TODO\(codegen\): enum values not published[^\n]*\nenum LooseKind : int\{/m);
});

test('two schemas with the same short name get distinct classes', () => {
	const r = gen(['ClientboundAlphaPacket'], {
		ClientboundAlphaPacketPayload: {
			type: 'object',
			properties: { A: at(0, { $ref: './One__Kind.json' }), B: at(1, { $ref: './Two__Kind.json' }) },
			required: ['A', 'B'],
		},
		One__Kind: { title: 'One::Kind', type: 'string', enum: ['X'], 'x-underlying-type': 'uint8', 'x-enum-binary-value': [0] },
		Two__Kind: { title: 'Two::Kind', type: 'string', enum: ['Y'], 'x-underlying-type': 'uint8', 'x-enum-binary-value': [0] },
	});
	assert.deepEqual([...r.files.keys()].sort(), ['ClientboundAlphaPacket.php', 'types/Kind.php', 'types/TwoKind.php']);
});

test('--all-new writes the new packets and their types to --out and nowhere else', () => {
	const from = fx.writeTree(fx.tempDir('codegen-from'), fx.docsTree(P - 1, { ...SHARED, ServerboundBetaPacket: fx.packet('ServerboundBetaPacket', 8, P - 1), ServerboundBetaPacketPayload: { type: 'object' } }));
	const to = fixtureDocs();
	const out = path.join(fx.tempDir('codegen-out'), 'drafts');
	const r = run({ ...parseArgs(['--all-new', '--from-dir', from, '--to-dir', to, '--out', out]), packages_src: fx.tempDir('codegen-pkg') });
	assert.deepEqual(r.packets.map((p) => p.name), ['ClientboundAlphaPacket', 'EpsilonPacket', 'GammaPacket', 'ZetaPacket']);
	const written = [];
	const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : written.push(path.relative(out, path.join(d, e.name)).replace(/\\/g, '/'))));
	walk(out);
	assert.deepEqual(written.sort(), [...r.files.keys()].sort());
	assert.ok(!written.includes('ServerboundBetaPacket.php'), 'a packet the older tag has is not new');
	assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
	assert.throws(() => run({ packet: ['NoSuchPacket'], docs_dir: to, out }), /no packet NoSuchPacket/);
});

// The parts of a class the ground truth compares. The namespace and finality are checked
// on their own; tolerate() has already applied TOLERATED to both sides.
function project(s) {
	if (s.kind === 'enum') return s;
	const { namespace, final, ...rest } = s;
	return rest;
}

test('the structural comparison notices a reordered field', () => {
	const r = gen(['ClientboundAlphaPacket']);
	const text = r.files.get('ClientboundAlphaPacket.php');
	const swapped = text.replace(/(\t\tCommonTypes::putString\(\$out, \$this->name\);\n)(\t\tVarInt::writeSignedInt\(\$out, \$this->count\);\n)/, '$2$1');
	assert.notEqual(swapped, text);
	assert.notDeepEqual(project(parse(swapped)), project(parse(text)));
});

test('the structural comparison notices two adjacent fields of the same type swapped', () => {
	const r = gen(['ClientboundAlphaPacket'], {
		ClientboundAlphaPacketPayload: {
			type: 'object',
			properties: { First: at(0, { type: 'string' }), Second: at(1, { type: 'string' }), Pair: at(2, { $ref: './Pair.json' }) },
			required: ['First', 'Second', 'Pair'],
		},
		Pair: { type: 'object', properties: { Left: at(0, { type: 'string' }), Right: at(1, { type: 'string' }) }, required: ['Left', 'Right'] },
	});
	const swaps = [
		['ClientboundAlphaPacket.php', /(\t\tCommonTypes::putString\(\$out, \$this->first\);\n)(\t\tCommonTypes::putString\(\$out, \$this->second\);\n)/, '$2$1'],
		['ClientboundAlphaPacket.php', /(\t\t\$this->first = CommonTypes::getString\(\$in\);\n)(\t\t\$this->second = CommonTypes::getString\(\$in\);\n)/, '$2$1'],
		['types/Pair.php', /(\t\t\$left = CommonTypes::getString\(\$in\);\n)(\t\t\$right = CommonTypes::getString\(\$in\);\n)/, '$2$1'],
		['types/Pair.php', /new self\(\$left, \$right\)/, 'new self($right, $left)'],
		['types/Pair.php', /(\t\tCommonTypes::putString\(\$out, \$this->left\);\n)(\t\tCommonTypes::putString\(\$out, \$this->right\);\n)/, '$2$1'],
	];
	for (const [file, from, to] of swaps) {
		const text = r.files.get(file);
		const swapped = text.replace(from, to);
		assert.notEqual(swapped, text, `${file} ${from}`);
		const [a, b] = [parse(swapped), parse(text)];
		for (const k of ['decode', 'encode', 'read', 'write']) assert.deepEqual(a[k], b[k], 'the call names alone cannot tell the two apart');
		assert.notDeepEqual(project(a), project(b), `${file} ${from}`);
	}
});

// Every way the hand-written 1.26.60 classes differ from what codegen drafts.
const TOLERATED = {
	// Codegen makes every class final; these hand-written ones are not.
	notFinal: ['ClientboundMatchmakingStatePacket', 'ClientboundStonecutterSetRecipePacket', 'ServerboundMatchmakingCancelPacket', 'ServerboundStonecutterSetRecipePacket'],
	// Our class names where they differ from Mojang's schema titles.
	typeNames: { PassengerOfBlockArguments: 'PassengerOfBlockData' },
	// Our field names where they differ from Mojang's names in camel case.
	fieldNames: {
		SetPassengerOfBlockPacket: { passenger: 'actorUniqueId', passengerOfBlockData: 'passengerData' },
		ClientboundStonecutterSetRecipePacket: { playerId: 'playerActorUniqueId' },
	},
	// Codegen writes every type into types\; ours group some by area.
	namespaces: { AudioContentPlaybackType: 'sound', AudioContentRegistrationEntry: 'sound', CursorItemDragState: 'inventory' },
	// Ours is string-backed and resolved by ordinal through PacketOrdinalEnumTrait, so it
	// reads with fromOrdinal and writes toOrdinal() where codegen's int-backed enum uses
	// fromPacket and ->value. Codegen's values must then be the ordinals.
	ordinalEnums: ['MatchmakingState'],
	// Ours has constructor parameters that are not readonly.
	notReadonly: ['MatchmakingStateOptions'],
	// Unverified, pmmp-updater#15. Mojang's schema gives every field of these enums no
	// Enum-as-Value, so codegen sends the name as a string; ours, from upstream axolotl-pm,
	// sends the binary value as a byte. One of the two is wrong on the wire. The test maps
	// codegen's string calls onto ours and reports each place it did so; settling #15
	// removes the entry or fixes the package.
	nameOnWire: {
		AudioContentPlaybackType: { issue: 'pmmp-updater#15', read: 'Byte::readUnsigned', write: 'Byte::writeUnsigned' },
	},
};

// Every place the live test maps a TOLERATED.nameOnWire difference, so none goes unseen.
const NAME_ON_WIRE_REPORTED = ['ClientboundPlayAudioContentPacket.playbackType', 'types/AudioContentPlaybackType.php'];

const EXPECTED_FILES = [
	'ClientboundMatchmakingStatePacket.php', 'ClientboundPlayAudioContentPacket.php', 'ClientboundStonecutterSetRecipePacket.php',
	'ServerboundCursorItemDragPacket.php', 'ServerboundMatchmakingCancelPacket.php', 'ServerboundRegisterAudioContentPacket.php',
	'ServerboundStonecutterSetRecipePacket.php', 'SetPassengerOfBlockPacket.php',
	'types/AudioContentPlaybackType.php', 'types/AudioContentRegistrationEntry.php', 'types/CursorItemDragState.php', 'types/EmoteType.php',
	'types/MatchmakingState.php', 'types/MatchmakingStateOptions.php', 'types/PassengerOfBlockArguments.php',
];

function renameTypes(shape) {
	let json = JSON.stringify(shape);
	for (const [ours, theirs] of Object.entries(TOLERATED.typeNames)) json = json.replace(new RegExp(`\\b${ours}\\b`, 'g'), theirs);
	return JSON.parse(json);
}

const BODIES = ['decode', 'encode', 'read', 'write'];

function tolerate(genShape, handShape, reported) {
	const g = renameTypes(genShape);
	const h = JSON.parse(JSON.stringify(handShape));
	const names = TOLERATED.fieldNames[g.name] || {};
	for (const list of [g.properties, g.create, g.ctor]) for (const p of list || []) if (names[p.name]) p.name = names[p.name];
	for (const k of BODIES) if (g[`${k}Targets`]) g[`${k}Targets`] = g[`${k}Targets`].map((t) => names[t] || t);
	if (TOLERATED.notReadonly.includes(g.name)) for (const p of g.ctor || []) p.readonly = false;
	for (const e of TOLERATED.ordinalEnums) {
		for (const k of BODIES) {
			if (!h[k]) continue;
			const keep = h[k].map((c) => c !== '->toOrdinal');
			h[k] = h[k].filter((_, i) => keep[i]).map((c) => (c === `${e}::fromOrdinal` ? `${e}::fromPacket` : c));
			h[`${k}Targets`] = h[`${k}Targets`].filter((_, i) => keep[i]);
		}
	}
	for (const p of [...(g.properties || []), ...(g.ctor || [])]) {
		const type = p.type.replace(/^\?/, '');
		const entry = TOLERATED.nameOnWire[type];
		if (!entry) continue;
		const map = { 'CommonTypes::getString': entry.read, 'CommonTypes::putString': entry.write };
		let mapped = false;
		for (const k of BODIES) {
			if (!g[k]) continue;
			g[k] = g[k].map((c, i) => {
				if (g[`${k}Targets`][i] !== p.name || !map[c]) return c;
				mapped = true;
				return map[c];
			});
		}
		if (mapped && !reported.some((d) => d.where === `${g.name}.${p.name}`)) reported.push({ where: `${g.name}.${p.name}`, type });
	}
	return { g, h };
}

// The docs tag our classes for these packets follow. Two of them change in 1.26.70, so the
// drafts come from the tag the package was brought to, not from the one that added them.
const PACKAGE_TAG = 'v1.26.70-preview.23';

test('live: codegen redrafts the 8 packets new in 1.26.60 as the hand-written classes, up to the listed differences', { skip: !process.env.RIFTAL_LIVE }, (t) => {
	const out = fx.tempDir('codegen-live');
	const added = docs.diffDocs(docs.loadDocs(docs.checkout('v1.26.50')), docs.loadDocs(docs.checkout('v1.26.60'))).packets.added.map((p) => p.name);
	assert.equal(added.length, 8);
	const r = run({ ...parseArgs([...added.flatMap((n) => ['--packet', n]), '--tag', PACKAGE_TAG, '--out', out]) });
	assert.deepEqual(r.todos, []);
	assert.deepEqual([...r.files.keys()].sort(), [...EXPECTED_FILES].sort());
	const reported = [];
	for (const [rel, text] of r.files) {
		const genShape = parse(text);
		const ours = TOLERATED.typeNames[genShape.name] || genShape.name;
		const sub = rel.startsWith('types/') ? ['types', ...(TOLERATED.namespaces[ours] ? [TOLERATED.namespaces[ours]] : [])] : [];
		const handShape = parse(fs.readFileSync(path.join(pkg.PROTOCOL_SRC, ...sub, `${ours}.php`), 'utf8'));
		assert.equal(handShape.namespace, ['pocketmine\\network\\mcpe\\protocol', ...sub].join('\\'), rel);
		if (genShape.kind === 'enum') {
			if (TOLERATED.nameOnWire[ours]) {
				assert.equal(genShape.backing, 'string', rel);
				assert.deepEqual(genShape.traits, ['PacketOrdinalEnumTrait'], rel);
				assert.equal(handShape.backing, 'int', rel);
				assert.deepEqual(handShape.traits, ['PacketIntEnumTrait'], rel);
				assert.deepEqual(genShape.cases.map((c) => c.name), handShape.cases.map((c) => c.name), rel);
				reported.push({ where: rel, type: ours });
				continue;
			}
			assert.equal(genShape.backing, 'int', rel);
			assert.deepEqual(genShape.traits, ['PacketIntEnumTrait'], rel);
			if (TOLERATED.ordinalEnums.includes(ours)) {
				assert.equal(handShape.backing, 'string', rel);
				assert.deepEqual(handShape.traits, ['PacketOrdinalEnumTrait'], rel);
				assert.deepEqual(genShape.cases.map((c) => c.name), handShape.cases.map((c) => c.name), rel);
				assert.deepEqual(genShape.cases.map((c) => c.value), handShape.cases.map((_, i) => String(i)), rel);
			} else {
				assert.deepEqual({ ...genShape, namespace: null }, { ...handShape, namespace: null }, rel);
			}
			continue;
		}
		assert.equal(genShape.final, true, rel);
		assert.equal(handShape.final, !TOLERATED.notFinal.includes(ours), rel);
		const { g, h } = tolerate(genShape, handShape, reported);
		assert.deepEqual(project(g), project(h), rel);
	}
	assert.deepEqual(reported.map((d) => d.where).sort(), [...NAME_ON_WIRE_REPORTED].sort());
	for (const { where, type } of reported) {
		t.diagnostic(`DIFFERS, unverified (${TOLERATED.nameOnWire[type].issue}): ${where}: codegen sends ${type} as its name string, the package sends its value as a byte`);
	}
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const docs = require('../../lib/mojang-docs');
const pkg = require('../../lib/packages');
const { run } = require('../diff');
const fx = require('../../test-support/fixtures');

function buildPair() {
	const from = fx.writeTree(fx.tempDir('from'), {
		...fx.docsTree(100, {
			AlphaPacket: fx.packet('AlphaPacket', 1, 100),
			AlphaPacketPayload: { type: 'object', properties: { Mode: { $ref: './Mode.json', 'x-ordinal-index': 0 } } },
			Mode: { type: 'string', enum: ['Off', 'On'], 'x-underlying-type': 'uint8' },
			BetaPacket: fx.packet('BetaPacket', 2, 100),
			BetaPacketPayload: { type: 'object', properties: { Count: { type: 'integer', 'x-underlying-type': 'int32', 'x-ordinal-index': 0 } } },
			GammaPacket: fx.packet('GammaPacket', 3, 100),
			GammaPacketPayload: { type: 'object', properties: { Level: { $ref: './Level.json' } } },
			Level: { type: 'string', enum: ['Low', 'High'], 'x-enum-binary-value': [0, 1] },
			OldPacket: fx.packet('OldPacket', 9, 100),
			OldPacketPayload: { type: 'object', properties: {} },
		}),
		'developer_notes/a.md': '# Old note',
	});
	const to = fx.writeTree(fx.tempDir('to'), {
		...fx.docsTree(101, {
			AlphaPacket: fx.packet('AlphaPacket', 1, 101),
			AlphaPacketPayload: { type: 'object', properties: { Mode: { $ref: './Mode.json', 'x-ordinal-index': 0 } } },
			Mode: { type: 'string', enum: ['Off', 'On'], 'x-underlying-type': 'uint8', 'x-enum-binary-value': [0, 1], description: 'Newly documented.' },
			BetaPacket: fx.packet('BetaPacket', 5, 101),
			BetaPacketPayload: { type: 'object', properties: { Count: { type: 'integer', 'x-underlying-type': 'int32', 'x-ordinal-index': 0 }, Extra: { type: 'boolean', 'x-ordinal-index': 1 } } },
			GammaPacket: fx.packet('GammaPacket', 3, 101),
			GammaPacketPayload: { type: 'object', properties: { Level: { $ref: './Level.json' } } },
			Level: { type: 'string', enum: ['Low', 'High'], 'x-enum-binary-value': [0, 2] },
			NewPacket: fx.packet('NewPacket', 10, 101),
			NewPacketPayload: { type: 'object', properties: {} },
		}),
		'developer_notes/a.md': '# Old note',
		'developer_notes/r1/b.md': '# Network Protocol\n- Added NewPacket',
	});
	const src = fx.writeTree(fx.tempDir('pkg'), {
		'ProtocolInfo.php': fx.protocolInfoPhp(100, '1.0.0', { ALPHA: 1, BETA: 2, GAMMA: 3, OLD: 9 }),
		'AlphaPacket.php': '', 'BetaPacket.php': '', 'GammaPacket.php': '', 'OldPacket.php': '', 'DataPacket.php': '', 'ServerboundPacket.php': '',
	});
	return { from, to, src };
}

test('reports added, removed and renumbered packets and the protocol move', () => {
	const { from, to, src } = buildPair();
	const r = run({ from_dir: from, to_dir: to, packages_src: src });
	assert.deepEqual(r.diff.protocol, { from: 100, to: 101 });
	assert.deepEqual(r.diff.packets.added.map((p) => [p.name, p.id]), [['NewPacket', 10]]);
	assert.deepEqual(r.diff.packets.removed.map((p) => p.name), ['OldPacket']);
	assert.deepEqual(r.diff.packets.id_changed, [{ name: 'BetaPacket', from: 2, to: 5 }]);
});

test('separates wire changes from documentation-only changes', () => {
	const { from, to, src } = buildPair();
	const r = run({ from_dir: from, to_dir: to, packages_src: src });
	const changed = Object.fromEntries(r.diff.packets.changed.map((p) => [p.name, p.types]));
	assert.deepEqual(changed.BetaPacket, ['BetaPacket', 'BetaPacketPayload'], 'its own schema changed with its ID, and its payload gained a field');
	assert.deepEqual(changed.GammaPacket, ['Level'], 'renumbered enum values are a wire change');
	assert.equal(changed.AlphaPacket, undefined, 'newly published enum values and prose are documentation only');
	assert.deepEqual(r.diff.types.annotation_only, ['Mode']);
});

test('renumbered enum values nested inside a schema are a wire change', () => {
	const nested = (values) => ({ type: 'object', properties: { Kind: { type: 'string', enum: ['A', 'B'], 'x-enum-binary-value': values } } });
	assert.equal(docs.classify(nested([0, 1]), nested([0, 7])), 'wire');
	assert.equal(docs.classify(nested([0, 1]), nested([0, 1])), 'same');
});

test('enum values published for the first time out of index order are flagged for a check', () => {
	const plain = { type: 'string', enum: ['A', 'B', 'C'] };
	assert.equal(docs.classify(plain, { ...plain, 'x-enum-binary-value': [0, 1, 2] }), 'annotation');
	assert.equal(docs.classify(plain, { ...plain, 'x-enum-binary-value': [0, 1, 5] }), 'values-to-check');
	const nestedPlain = { type: 'object', properties: { Kind: plain } };
	const nestedValued = { type: 'object', properties: { Kind: { ...plain, 'x-enum-binary-value': [2, 4, 8] } } };
	assert.equal(docs.classify(nestedPlain, nestedValued), 'values-to-check');
});

test('enum values that stop being published out of index order are flagged for a check', () => {
	const plain = { type: 'string', enum: ['A', 'B'] };
	assert.equal(docs.classify({ ...plain, 'x-enum-binary-value': [0, 7] }, plain), 'values-to-check');
	assert.equal(docs.classify({ ...plain, 'x-enum-binary-value': [0, 1] }, plain), 'annotation');
});

test('fields named like schema keywords are compared as fields', () => {
	const withField = (name) => ({ type: 'object', properties: { Count: { type: 'integer' }, [name]: { type: 'string' } } });
	const base = { type: 'object', properties: { Count: { type: 'integer' } } };
	assert.equal(docs.classify(base, withField('description')), 'wire');
	assert.equal(docs.classify(base, withField('$schema')), 'wire');
	assert.equal(docs.classify(base, withField('x-enum-binary-value')), 'wire');
	assert.equal(docs.classify(base, { ...base, description: 'prose' }), 'annotation');
});

test('finds new developer notes in subdirectories', () => {
	const { from, to, src } = buildPair();
	const r = run({ from_dir: from, to_dir: to, packages_src: src });
	assert.deepEqual(r.diff.developer_notes.map((n) => n.file), ['r1/b.md']);
});

test('checks the newer docs against our packages', () => {
	const { from, to, src } = buildPair();
	const p = run({ from_dir: from, to_dir: to, packages_src: src }).packages;
	assert.equal(p.protocol, 100);
	assert.equal(p.protocol_matches, false);
	assert.deepEqual(p.missing_classes.map((x) => x.name), ['NewPacket']);
	assert.deepEqual(p.id_mismatch, [{ name: 'BetaPacket', ours: 2, mojang: 5 }]);
});

test('orders previews before the release of the same version', () => {
	const tags = docs.parseLsRemote([
		'a\trefs/tags/v1.26.61',
		'b\trefs/tags/v1.26.70-preview.3',
		'c\trefs/tags/v1.26.60',
		'd\trefs/tags/v1.26.70-preview.22',
		'e\trefs/tags/v1.26.70',
		'f\trefs/tags/not-a-version',
	].join('\n'));
	assert.deepEqual(tags.map((t) => t.tag), ['v1.26.60', 'v1.26.61', 'v1.26.70-preview.3', 'v1.26.70-preview.22', 'v1.26.70']);
	assert.equal(docs.tagForVersion(tags, '1.26.60.5').tag, 'v1.26.60');
	assert.equal(docs.tagForVersion(tags, '1.26.70').tag, 'v1.26.70');
	assert.equal(docs.tagForVersion(tags, '1.26.80'), null);
});

test('only version tags reach the cache, so no argument can name another path', () => {
	for (const bad of ['../..', 'v1.26.60/../../x', 'main', 'v1.26', '']) assert.throws(() => docs.checkout(bad), /not a Mojang docs version tag/);
});

function withCache(t) {
	const cache = fx.tempDir('docs-cache');
	const before = process.env.PMMP_UPDATER_CACHE;
	process.env.PMMP_UPDATER_CACHE = cache;
	t.after(() => {
		if (before === undefined) delete process.env.PMMP_UPDATER_CACHE;
		else process.env.PMMP_UPDATER_CACHE = before;
	});
	return path.join(cache, 'mojang-docs');
}

function fakeGit(failOn) {
	return (args) => {
		if (args[0] === 'clone') fx.writeTree(args[args.length - 1], { 'json/AlphaPacket.json': '{}' });
		if (args.includes(failOn)) throw new Error(`git ${failOn} failed`);
	};
}

test('a checkout that fails part way leaves no partial clone in the cache', (t) => {
	const root = withCache(t);
	for (const step of ['clone', 'sparse-checkout']) {
		assert.throws(() => docs.checkout('v1.26.60', fakeGit(step)), new RegExp(`git ${step} failed`));
		assert.deepEqual(fs.readdirSync(root), [], step);
	}
});

test('a checkout that completes is renamed into place with its marker', (t) => {
	const root = withCache(t);
	const dir = docs.checkout('v1.26.60', fakeGit(null));
	assert.equal(dir, path.join(root, 'v1.26.60'));
	assert.deepEqual(fs.readdirSync(root), ['v1.26.60']);
	assert.ok(fs.existsSync(path.join(dir, '.checkout-complete')));
	assert.equal(docs.checkout('v1.26.60', () => assert.fail('a complete checkout is not cloned again')), dir);
});

test('every packet class in our packages maps to a ProtocolInfo constant', () => {
	const info = pkg.readProtocolInfo();
	const unmapped = pkg.packetClasses().filter((c) => !info.ids.has(pkg.constantStem(c)));
	assert.deepEqual(unmapped, []);
	assert.equal(pkg.constantStem('SetPassengerOfBlockPacket'), 'SET_PASSENGER_OF_BLOCK');
	assert.equal(pkg.constantStem('NPCDialoguePacket'), 'NPC_DIALOGUE');
});

test('live: Mojang 1.26.50 to 1.26.60 is protocol 2193 to 2225 with the 8 known new packets', { skip: !process.env.RIFTAL_LIVE }, () => {
	const r = run({ from: 'v1.26.50', to: 'v1.26.60' });
	assert.deepEqual(r.diff.protocol, { from: 2193, to: 2225 });
	assert.deepEqual(r.diff.packets.added.map((p) => p.name), [
		'ClientboundMatchmakingStatePacket', 'ClientboundPlayAudioContentPacket', 'ClientboundStonecutterSetRecipePacket',
		'ServerboundCursorItemDragPacket', 'ServerboundMatchmakingCancelPacket', 'ServerboundRegisterAudioContentPacket',
		'ServerboundStonecutterSetRecipePacket', 'SetPassengerOfBlockPacket',
	]);
	assert.equal(path.basename(r.to), 'v1.26.60');
});

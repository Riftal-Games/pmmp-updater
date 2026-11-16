'use strict';

// The BDS-free core of a version run's canonical_block_states.nbt, under the steward's
// ruling on #10, issuecomment-6868986975 section 1: our file plus a delta BDS measures.
// build() takes the state set from the new version's structure palette and puts each state
// BDS kept when placed at the network ID it sent, then every other state into the IDs left,
// in the order our file gives it. Its report holds acceptance items a to d and f, each a list
// of what failed, and two lists outside them: the order rule's reversal, and how our file
// and the old palette differ. The result is a MATCH only when every one of them is empty.
// Item e is a run: the same build() on BDS 1.26.63.1's palettes and IDs against our
// 1.26.60.6 file, whose states control() then compares with that file entry for entry.
//
// A state is a compound as leveldb.nbt yields it, [[key, tag type, value], ...], holding
// name, states and version. `sent` pairs a state with the ID BDS sent for it, and holds
// only states BDS kept when placed: which those are is the run's to decide.

const samples = require('./samples');

const fail = (m) => { throw new Error(`blocks-delta: ${m}`); };
const TYPES = { 1: 'b', 3: 'i', 8: 's' };

function field(c, k) {
	const e = c.find((x) => x[0] === k);
	return e || fail(`a state has no ${k}`);
}

function key(c) {
	const [[, nt, name], [, st, states]] = [field(c, 'name'), field(c, 'states')];
	if (nt !== 8 || st !== 10) fail(`${name} has a name or states of another tag type`);
	return samples.stateKey({ name, states: states.map(([k, t, v]) => [k, TYPES[t] || fail(`${name} state ${k} has tag type ${t}`), v]) });
}

const nameOf = (k) => k.slice(0, k.indexOf('['));

const show = (c) => `${field(c, 'name')[2]}[${field(c, 'states')[2].map(([k, t, v]) => `${k}=${TYPES[t]}:${JSON.stringify(v)}`).join(',')}] v${field(c, 'version')[2]}`;

const uvar = (n) => {
	const out = [];
	for (; n > 0x7f; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
	return Buffer.from([...out, n]);
};

// Network NBT, as canonical_block_states.nbt is written: varint string lengths and zigzag
// varint ints, one nameless root compound per state, in ID order.
function encode(list) {
	const str = (s) => Buffer.concat([uvar(Buffer.byteLength(s)), Buffer.from(s)]);
	const value = (t, v) => {
		if (t === 1) return Buffer.from([v & 0xff]);
		if (t === 3) return uvar(v < 0 ? -2 * v - 1 : 2 * v);
		if (t === 8) return str(v);
		if (t !== 10) fail(`tag type ${t} in a block state`);
		return Buffer.concat([...v.map(([k, tt, x]) => Buffer.concat([Buffer.from([tt]), str(k), value(tt, x)])), Buffer.from([0])]);
	};
	return Buffer.concat(list.map((c, id) => (c ? Buffer.concat([Buffer.from([10]), str(''), value(10, c)]) : fail(`ID ${id} names no state`))));
}

function decode(buf) {
	let o = 0;
	const byte = () => (o < buf.length ? buf[o++] : fail(`NBT truncated at byte ${o}`));
	const uv = () => {
		let v = 0;
		for (let shift = 0, b = 0x80; b & 0x80; shift += 7) {
			if (shift > 28) fail(`varint too long at byte ${o}`);
			b = byte();
			v += (b & 0x7f) * 2 ** shift;
		}
		return v;
	};
	const str = () => {
		const n = uv();
		if ((o += n) > buf.length) fail(`NBT truncated at byte ${o - n}`);
		return buf.toString('utf8', o - n, o);
	};
	const value = (t) => {
		if (t === 1) return byte() << 24 >> 24;
		if (t === 3) return ((u) => (u % 2 ? -(u + 1) / 2 : u / 2))(uv());
		if (t === 8) return str();
		if (t !== 10) fail(`tag type ${t} at byte ${o - 1} in a block state`);
		const c = [];
		for (let tt = byte(); tt !== 0; tt = byte()) c.push([str(), tt, value(tt)]);
		return c;
	};
	const out = [];
	while (o < buf.length) {
		if (byte() !== 10) fail(`the root at byte ${o - 1} is not a compound`);
		str();
		out.push(value(10));
	}
	return out;
}

// Block name to the keys of its states.
function blocks(palette) {
	const m = new Map();
	for (const c of palette) {
		const k = key(c);
		(m.get(nameOf(k)) || m.set(nameOf(k), new Set()).get(nameOf(k))).add(k);
	}
	return m;
}

function build({ base, oldPalette, newPalette, sent }) {
	const entries = new Map();
	for (const c of newPalette) {
		const [k, e] = [key(c), [field(c, 'name'), field(c, 'states'), field(c, 'version')]];
		if (entries.has(k) && entries.get(k)[2][2] !== e[2][2]) fail(`the new palette holds ${k} at two versions`);
		entries.set(k, e);
	}
	const [was, now] = [blocks(oldPalette), blocks(newPalette)];
	const changed = new Set([...was.keys(), ...now.keys()].filter((n) => !was.has(n) || !now.has(n) || was.get(n).size !== now.get(n).size || [...now.get(n)].some((k) => !was.get(n).has(k))));
	const ours = new Map();
	base.forEach((c, id) => ours.has(key(c)) || ours.set(key(c), id));

	const [ids, b, unsure] = [new Map(), [], new Set()];
	const refuse = (k, why) => {
		b.push(`${k} ${why}`);
		unsure.add(nameOf(k));
	};
	for (const [c, id] of sent) {
		const k = key(c);
		if (!Number.isInteger(id) || id < 0) refuse(k, `was sent as ${id}, not an ID`);
		else if (!entries.has(k)) refuse(k, `was sent as ${id} and is not in the new palette`);
		else if (id >= entries.size) refuse(k, `was sent as ${id}, past the new palette's last ID ${entries.size - 1}`);
		else if (ids.has(k) && ids.get(k) !== id) refuse(k, `was sent as ${ids.get(k)} and as ${id}`);
		else ids.set(k, id);
	}
	const list = new Array(entries.size).fill(null);
	for (const [k, id] of ids) {
		if (list[id] === null) list[id] = k;
		else refuse(k, `was sent as ${id}, which ${list[id]} holds`);
	}
	const kept = new Set([...ids].filter(([k, id]) => list[id] === k).map(([k]) => k));
	const rank = (k) => (ours.has(k) ? ours.get(k) : base.length);
	const inherited = [...entries.keys()].filter((k) => !kept.has(k)).sort((x, y) => rank(x) - rank(y));
	for (let i = 0, id = 0; i < inherited.length; i++, id++) {
		while (list[id] !== null) id++;
		list[id] = inherited[i];
	}
	const idOf = new Map(list.map((k, id) => [k, id]));

	const d = [];
	for (const k of inherited) {
		const why = changed.has(nameOf(k)) ? 'its block changed' : !ours.has(k) ? 'it is not in our file'
			: unsure.has(nameOf(k)) ? 'a state of its block is not at its sent ID' : null;
		if (why) d.push(`${k} is inherited at ${idOf.get(k)}, but ${why}`);
	}

	// The order rule, whose reversal issuecomment-6868986975 names: outside the changed blocks,
	// the states both lists hold stand in our file's order. Any that do not are listed, as the
	// states outside one longest run in our order. Patience sorting finds that run, so of runs
	// of equal length it keeps states with lower IDs in our file.
	const shared = list.filter((k) => !changed.has(nameOf(k)) && ours.has(k));
	const [tails, prev, inRun] = [[], new Map(), new Set()];
	for (const k of shared) {
		let [lo, hi] = [0, tails.length];
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ours.get(tails[mid]) < ours.get(k)) lo = mid + 1;
			else hi = mid;
		}
		prev.set(k, tails[lo - 1]);
		tails[lo] = k;
	}
	for (let k = tails[tails.length - 1]; k !== undefined; k = prev.get(k)) inRun.add(k);
	const order = shared.filter((k) => !inRun.has(k))
		.map((k) => `${k} ${kept.has(k) ? `was sent as ${ids.get(k)}` : `is inherited at ${idOf.get(k)}`}, ours ${ours.get(k)}`);

	// The base rests on BDS's old palette holding our file's states (issuecomment-6868011006),
	// so where the two differ, this run is not evidence for a to f.
	const full = (c) => `${key(c)} v${field(c, 'version')[2]}`;
	const [inBase, inOld] = [new Set(base.map(full)), new Set(oldPalette.map(full))];
	const differ = [...[...inBase].filter((k) => !inOld.has(k)).map((k) => `${k} is in our file, not the old palette`),
		...[...inOld].filter((k) => !inBase.has(k)).map((k) => `${k} is in the old palette, not our file`)];

	const byBlock = new Map();
	const at = (n) => byBlock.get(n) || byBlock.set(n, { inherited: [], added: [], removed: [] }).get(n);
	for (const k of inherited) at(nameOf(k)).inherited.push({ state: k, id: idOf.get(k) });
	for (const n of changed) {
		for (const k of now.get(n) || []) if (!was.get(n)?.has(k)) at(n).added.push({ state: k, id: ids.get(k) ?? null });
		for (const k of was.get(n) || []) if (!now.get(n)?.has(k)) at(n).removed.push({ state: k, our_id: ours.get(k) ?? null });
		at(n).added.sort((x, y) => (x.id ?? Infinity) - (y.id ?? Infinity));
		at(n).removed.sort((x, y) => (x.our_id ?? Infinity) - (y.our_id ?? Infinity));
	}
	const blocksOut = Object.fromEntries([...byBlock].sort(([x], [y]) => (x < y ? -1 : 1)));
	const items = {
		a: [...entries.keys()].filter((k) => changed.has(nameOf(k)) && !ids.has(k)).map((k) => `${k} was not sent, and its block changed`),
		b,
		c: list.flatMap((k, id) => (k === null ? [`${id} names no state`] : [])),
		d,
		f: Object.values(blocksOut).flatMap((x) => x.added.filter((s) => s.id === null).map((s) => `${s.state} was added and has no sent ID`)),
	};
	const match = [...Object.values(items), order, differ].every((x) => x.length === 0);
	const report = { match, states: list.length, kept: kept.size, inherited: inherited.length, items, order, base: differ, blocks: blocksOut };
	return { states: list.map((k) => (k === null ? null : entries.get(k))), report };
}

// Item e: entry for entry by the bytes each would have in the file, so name, states in
// order with their types, and version all count.
function control(got, ours) {
	const out = [];
	for (let i = 0; i < Math.max(got.length, ours.length); i++) {
		const [x, y] = [got[i], ours[i]];
		if (!x || !y || !encode([x]).equals(encode([y]))) out.push(`${i}: got ${x ? show(x) : 'none'}, ours ${y ? show(y) : 'none'}`);
	}
	return out;
}

function render(r) {
	const lines = [`${r.states} IDs: ${r.kept} at the ID BDS sent, ${r.inherited} in our order`];
	const part = (label, failed, what) => lines.push(failed.length ? `${label}: ${what} (${failed.length})` : `${label}: holds`, ...failed.map((s) => `  ${s}`));
	for (const [item, failed] of Object.entries(r.items)) part(item, failed, 'MISMATCH');
	part('order rule', r.order, 'REVERSED, our file no longer predicts BDS\'s order');
	part('base', r.base, 'our file and the old palette differ, so this run is not evidence for a to f');
	lines.push('f, by block:');
	for (const [n, x] of Object.entries(r.blocks)) {
		lines.push(`  ${n}:`);
		for (const s of x.inherited) lines.push(`    inherited ${s.state} at ${s.id}`);
		for (const s of x.added) lines.push(`    added ${s.state}, sent ${s.id ?? 'none'}`);
		for (const s of x.removed) lines.push(`    removed ${s.state}, ours ${s.our_id ?? 'none'}`);
	}
	return [...lines, r.match ? 'MATCH' : 'NOT MATCH'].join('\n');
}

module.exports = { key, encode, decode, build, control, render };

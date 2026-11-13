// BlockStates lists one set of values per state for every block that uses it, so each
// combination is resolved and kept only when BDS gives back the same block type with
// exactly the states asked for: a state such as `color` on a flattened block resolves to
// another type. A refused or altered one yields null, so the caller can count it. The
// first state varies fastest, as samples.js derives them.
const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

export function* permutations(id, api) {
	const names = Object.keys(api.resolve(id).getAllStates());
	const lists = names.map((n) => api.values(n));
	if (lists.some((l) => !l.length)) throw new Error(`${id} has a state with no values`);
	const at = names.map(() => 0);
	for (;;) {
		const want = Object.fromEntries(names.map((n, i) => [n, lists[i][at[i]]]));
		let got;
		try {
			const p = api.resolve(id, want);
			got = p.type.id === id ? p.getAllStates() : null;
		} catch {
			got = null;
		}
		yield got && same(got, want) ? want : null;
		let i = 0;
		while (i < at.length && ++at[i] === lists[i].length) at[i++] = 0;
		if (i === at.length) return;
	}
}

'use strict';

// Reduces a PHP class or enum in the package's style to the parts the codegen tests
// compare: names, fields, signatures and the order of encoding calls. It reads only the
// layout this package uses, not PHP in general.

function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function braceBlock(text, from) {
	const open = text.indexOf('{', from);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
	}
	return null;
}

function parenBlock(text, from) {
	const open = text.indexOf('(', from);
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')' && --depth === 0) return { inner: text.slice(open + 1, i), end: i };
	}
	return { inner: '', end: text.length };
}

function method(code, name) {
	const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
	if (!m) return null;
	const p = parenBlock(code, m.index);
	return { params: p.inner, body: braceBlock(code, p.end) };
}

function params(list) {
	return list.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
		const m = /^((?:private|protected|public)\s+)?(readonly\s+)?(\??[\w\\]+)\s+\$(\w+)/.exec(p);
		return m ? { type: m[3], name: m[4], readonly: Boolean(m[2]) } : { raw: p };
	});
}

// Static calls, method calls and constructions, in source order.
function calls(body) {
	if (body === null) return null;
	const out = [];
	for (const m of body.matchAll(/\b([A-Z]\w*)::(\w+)|->(\w+)\(|\bnew\s+(\w+)/g)) {
		if (m[1]) out.push(`${m[1]}::${m[2]}`);
		else if (m[3]) out.push(`->${m[3]}`);
		else out.push(`new ${m[4]}`);
	}
	return out;
}

function parse(text) {
	const code = stripComments(text);
	const ns = (/^namespace\s+([\w\\]+);/m.exec(code) || [])[1] || null;
	const en = /^enum\s+(\w+)\s*:\s*(\w+)/m.exec(code);
	if (en) {
		const cases = [...code.matchAll(/^\s*case\s+(\w+)\s*=\s*([^;]+);/gm)].map((m) => ({ name: m[1], value: m[2].trim() }));
		const traits = [...code.matchAll(/^\s*use\s+(\w+)\s*;/gm)].map((m) => m[1]);
		return { kind: 'enum', namespace: ns, name: en[1], backing: en[2], traits, cases };
	}
	const cl = /^(final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+?))?\s*\{/m.exec(code);
	if (!cl) throw new Error('no class or enum found');
	const classBody = braceBlock(code, cl.index);
	const properties = [...classBody.matchAll(/^\t(?:private|protected|public)\s+(?:readonly\s+)?(\??[\w\\]+)\s+\$(\w+)\s*;/gm)].map((m) => ({ type: m[1], name: m[2] }));
	const ctor = method(classBody, '__construct');
	const create = method(classBody, 'create');
	const id = /const\s+NETWORK_ID\s*=\s*ProtocolInfo::(\w+)\s*;/.exec(classBody);
	const handle = method(classBody, 'handle');
	const body = (n) => { const m = method(classBody, n); return m ? calls(m.body) : null; };
	return {
		kind: 'class',
		namespace: ns,
		name: cl[2],
		final: Boolean(cl[1]),
		extends: cl[3] || null,
		implements: cl[4] ? cl[4].split(',').map((s) => s.trim()).sort() : [],
		networkId: id ? id[1] : null,
		properties,
		ctor: ctor ? params(ctor.params) : null,
		create: create ? params(create.params) : null,
		handle: handle ? (/->(handle\w+)\(/.exec(handle.body) || [])[1] || null : null,
		decode: body('decodePayload'),
		encode: body('encodePayload'),
		read: body('read'),
		write: body('write'),
	};
}

module.exports = { parse, calls };

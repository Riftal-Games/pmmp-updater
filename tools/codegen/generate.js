#!/usr/bin/env node
'use strict';

// Drafts PHP packet classes, and the payload types they need, from one tag of Mojang's
// protocol docs, in the style of packages/bedrock-protocol. Output goes to a directory of
// its own, laid out like the package's src/, and is applied to packages/ by a version run.
// Where the schema cannot decide the code, the draft carries a TODO(codegen) marker.
//
// Usage: node tools/codegen/generate.js --tag <tag> --packet <Name> [--packet <Name> ...] [--out <dir>]
//        node tools/codegen/generate.js --all-new --from <tag> --to <tag> [--out <dir>]
//        --docs-dir <dir> in place of --tag, --from-dir/--to-dir in place of --from/--to (fixtures, no network)

const fs = require('fs');
const path = require('path');
const docs = require('../lib/mojang-docs');
const pkg = require('../lib/packages');

const NS = 'pocketmine\\network\\mcpe\\protocol';
const TYPES_NS = `${NS}\\types`;
const TODO = 'TODO(codegen)';

const HEADER = `<?php

/*
 * This file is part of BedrockProtocol.
 * Copyright (C) 2014-2022 PocketMine Team <https://github.com/pmmp/BedrockProtocol>
 *
 * BedrockProtocol is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

declare(strict_types=1);
`;

const USE = {
	Byte: 'pmmp\\encoding\\Byte',
	LE: 'pmmp\\encoding\\LE',
	BE: 'pmmp\\encoding\\BE',
	VarInt: 'pmmp\\encoding\\VarInt',
	ByteBufferReader: 'pmmp\\encoding\\ByteBufferReader',
	ByteBufferWriter: 'pmmp\\encoding\\ByteBufferWriter',
	CommonTypes: `${NS}\\serializer\\CommonTypes`,
	PacketIntEnumTrait: `${TYPES_NS}\\PacketIntEnumTrait`,
};

// Calls per wire type, with % standing for read or write: fixed width little endian by
// default, big endian under "Big Endian", varint under "Compression".
const NUMERIC = {
	int8: { php: 'int', le: 'Byte::%Signed', be: 'Byte::%Signed', varint: 'VarInt::%SignedInt' },
	uint8: { php: 'int', le: 'Byte::%Unsigned', be: 'Byte::%Unsigned', varint: 'VarInt::%UnsignedInt' },
	int16: { php: 'int', le: 'LE::%SignedShort', be: 'BE::%SignedShort', varint: 'VarInt::%SignedInt' },
	uint16: { php: 'int', le: 'LE::%UnsignedShort', be: 'BE::%UnsignedShort', varint: 'VarInt::%UnsignedInt' },
	int32: { php: 'int', le: 'LE::%SignedInt', be: 'BE::%SignedInt', varint: 'VarInt::%SignedInt' },
	uint32: { php: 'int', le: 'LE::%UnsignedInt', be: 'BE::%UnsignedInt', varint: 'VarInt::%UnsignedInt' },
	int64: { php: 'int', le: 'LE::%SignedLong', be: 'BE::%SignedLong', varint: 'VarInt::%SignedLong' },
	uint64: { php: 'int', le: 'LE::%UnsignedLong', be: 'BE::%UnsignedLong', varint: 'VarInt::%UnsignedLong' },
	float: { php: 'float', le: 'LE::%Float', be: 'BE::%Float', varint: null },
	double: { php: 'float', le: 'LE::%Double', be: 'BE::%Double', varint: null },
};

// Mojang types the package already reads and writes through CommonTypes, keyed by the
// schema file stem.
const KNOWN = {
	ActorUniqueID: { php: 'int', read: 'CommonTypes::getActorUniqueId', write: 'CommonTypes::putActorUniqueId' },
	ActorRuntimeID: { php: 'int', read: 'CommonTypes::getActorRuntimeId', write: 'CommonTypes::putActorRuntimeId' },
	BlockPos: { php: 'BlockPosition', use: `${TYPES_NS}\\BlockPosition`, read: 'CommonTypes::getBlockPosition', write: 'CommonTypes::putBlockPosition' },
	Vec3: { php: 'Vector3', use: 'pocketmine\\math\\Vector3', read: 'CommonTypes::getVector3', write: 'CommonTypes::putVector3' },
	Vec2: { php: 'Vector2', use: 'pocketmine\\math\\Vector2', read: 'CommonTypes::getVector2', write: 'CommonTypes::putVector2' },
	mce__UUID: { php: 'UuidInterface', use: 'Ramsey\\Uuid\\UuidInterface', read: 'CommonTypes::getUUID', write: 'CommonTypes::putUUID' },
};

const KNOWN_OPTIONS = new Set(['compression', 'bigendian', 'enum-as-value', 'allowunknownenumvalues', 'nosizecompression']);

function words(name) {
	return String(name)
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean);
}

function pascal(name) {
	return words(name).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Field';
}

// "Destination Name" -> destinationName, "Actor Unique ID" -> actorUniqueId. A name that
// is already camel or Pascal case keeps its humps.
function camel(name) {
	const parts = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
	if (!parts.length) return 'field';
	const out = parts.map((p, i) => {
		const w = /^[A-Z0-9]+$/.test(p) ? p[0] + p.slice(1).toLowerCase() : p;
		return i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1);
	}).join('');
	return /^[0-9]/.test(out) ? `_${out}` : out;
}

function upperSnake(value) {
	const s = words(value).join('_').toUpperCase();
	if (!s) return 'NONE';
	return /^[0-9]/.test(s) ? `_${s}` : s;
}

// PassengerOfBlockArguments::EmoteType -> EmoteType.
function className(schema, stem) {
	const title = (schema && schema.title) || stem;
	const last = title.split('::').pop();
	const cleaned = last.replace(/[^A-Za-z0-9_]/g, '');
	return /^[0-9]/.test(cleaned) || !cleaned ? `_${cleaned}` : cleaned;
}

function options(prop) {
	return new Set((prop['x-serialization-options'] || []).map((o) => String(o).toLowerCase().replace(/\s+/g, '')));
}

function packetStem(name) {
	return name.replace(/^(Clientbound|Serverbound)/, '').replace(/Packet$/, '');
}

function call(template, op) {
	return template.replace('%', op);
}

// A resolved field type. read and write are templates over the reader, writer and value
// expressions; a callable read or write is one a closure can name as F(...).
function todoType(reason) {
	return { php: 'mixed', todo: reason, uses: [] };
}

function staticType(php, read, write, uses = []) {
	return {
		php, uses,
		readCallable: read, writeCallable: write,
		read: (i) => `${read}(${i})`,
		write: (o, v) => `${write}(${o}, ${v})`,
	};
}

class Generator {
	constructor(loaded) {
		this.docs = loaded;
		this.types = new Map();
		this.files = new Map();
		this.todos = [];
	}

	schema(stem) {
		return this.docs.schemas.get(stem);
	}

	// Two schemas that share a short name, such as A::Kind and B::Kind, get their full
	// titles instead, so neither overwrites the other.
	claim(name, key, fullTitle) {
		const held = this.types.get(name);
		if (!held || held.key === key) return name;
		const alt = pascal(fullTitle || key);
		const again = this.types.get(alt);
		if (again && again.key !== key) throw new Error(`two schemas generate the class ${name}: ${held.key} and ${key}`);
		return alt;
	}

	note(where, reason) {
		this.todos.push(`${where}: ${reason}`);
		return reason;
	}

	numeric(ut, opts, where) {
		const n = NUMERIC[ut];
		if (!n) return null;
		let tpl = n.le;
		if (opts.has('compression')) tpl = n.varint;
		else if (opts.has('bigendian')) tpl = n.be;
		if (!tpl) return todoType(this.note(where, `${ut} with Compression has no varint form`));
		const cls = tpl.split('::')[0];
		return staticType(n.php, call(tpl, 'read'), call(tpl, 'write'), [USE[cls]]);
	}

	resolve(prop, ctx) {
		const where = `${ctx.owner}.${ctx.field}`;
		const opts = options(prop);
		const unknown = [...opts].filter((o) => !KNOWN_OPTIONS.has(o));
		if (unknown.length) return todoType(this.note(where, `unknown x-serialization-options ${unknown.join(', ')}`));
		if (prop.oneOf || prop.anyOf || prop.allOf) return todoType(this.note(where, 'a variant type (oneOf/anyOf/allOf); pick the encoding by its discriminator'));
		if (prop.$ref) return this.resolveRef(prop, ctx, opts);
		if (Array.isArray(prop.enum)) return this.enumType(prop, prop, `${ctx.ownerStem}${pascal(ctx.field)}`, ctx, where);
		switch (prop.type) {
			case 'integer':
			case 'number': {
				const t = this.numeric(prop['x-underlying-type'], opts, where);
				return t || todoType(this.note(where, `no wire type for ${prop.type} with x-underlying-type ${prop['x-underlying-type']}`));
			}
			case 'boolean':
				if (opts.has('compression') || opts.has('bigendian')) return todoType(this.note(where, 'a boolean with serialization options'));
				return staticType('bool', 'CommonTypes::getBool', 'CommonTypes::putBool', [USE.CommonTypes]);
			case 'string':
				if (opts.size) return todoType(this.note(where, 'a string with serialization options'));
				return staticType('string', 'CommonTypes::getString', 'CommonTypes::putString', [USE.CommonTypes]);
			case 'array':
				return this.arrayType(prop, ctx, opts);
			case 'object':
				if (prop.properties) return this.classType(prop, `${ctx.ownerStem}${pascal(ctx.field)}`, where);
				return todoType(this.note(where, 'an object with no properties, such as a map'));
			default:
				return todoType(this.note(where, `no type in the schema${prop.type ? ` (${prop.type})` : ''}`));
		}
	}

	resolveRef(prop, ctx, opts) {
		const where = `${ctx.owner}.${ctx.field}`;
		const stem = path.basename(prop.$ref, '.json');
		if (KNOWN[stem]) {
			const k = KNOWN[stem];
			return staticType(k.php, k.read, k.write, [USE.CommonTypes, ...(k.use ? [k.use] : [])]);
		}
		const target = this.schema(stem);
		if (!target) return todoType(this.note(where, `$ref ${stem} has no schema in this tag`));
		const packetName = stem.replace(/Payload$/, '');
		if (stem !== packetName && this.docs.packets.has(packetName)) {
			if (!ctx.inPacket) return todoType(this.note(where, `embeds ${packetName}, whose payload methods are protected`));
			return {
				php: packetName, uses: [`${NS}\\${packetName}`], embedded: true,
				readStmts: (target_, i) => [`${target_} = new ${packetName}();`, `${target_}->decodePayload(${i});`],
				write: (o, v) => `${v}->encodePayload(${o})`,
			};
		}
		if (Array.isArray(target.enum)) return this.enumType(prop, target, className(target, stem), ctx, stem);
		if (target.oneOf || target.anyOf || target.allOf) return todoType(this.note(where, `${stem} is a variant type (oneOf/anyOf/allOf)`));
		if (target.type === 'object') {
			const props = Object.entries(target.properties || {});
			const required = new Set(target.required || []);
			if (props.length === 1 && required.has(props[0][0])) {
				return this.resolve(props[0][1], { ...ctx, owner: className(target, stem), field: props[0][0], ownerStem: className(target, stem) });
			}
			if (!target.properties) return todoType(this.note(where, `${stem} is an object with no properties`));
			return this.classType(target, className(target, stem), stem);
		}
		const { $ref, ...rest } = prop;
		if (target.type) return this.resolve({ ...target, ...rest }, ctx);
		return todoType(this.note(where, `${stem} has no type in the schema`));
	}

	arrayType(prop, ctx, opts) {
		const where = `${ctx.owner}.${ctx.field}`;
		if (opts.has('nosizecompression')) return todoType(this.note(where, 'an array with No size compression; the length prefix is not a varint'));
		if (opts.has('compression')) return todoType(this.note(where, 'an array with Compression, such as a bit set'));
		if (!prop.items) return todoType(this.note(where, 'an array with no items schema'));
		const item = this.resolve(prop.items, { ...ctx, field: `${ctx.field} item` });
		if (item.todo) return todoType(item.todo);
		if (item.embedded) return todoType(this.note(where, 'an array of embedded packets'));
		return {
			php: 'array', element: item.php, uses: [USE.CommonTypes, ...item.uses],
			read: (i) => `CommonTypes::readList(${i}, ${readerFn(item)})`,
			write: (o, v) => `CommonTypes::writeList(${o}, ${v}, ${writerFn(item)})`,
		};
	}

	enumType(prop, enumSchema, wanted, ctx, key) {
		const where = `${ctx.owner}.${ctx.field}`;
		const name = this.claim(wanted, key, enumSchema.title);
		const ut = prop['x-underlying-type'] || enumSchema['x-underlying-type'];
		const opts = options(prop);
		const num = this.numeric(ut, opts, where);
		if (!num || num.todo || num.php !== 'int') return todoType(this.note(where, `enum ${name} has no integer wire type (${ut})`));
		if (!this.types.has(name)) {
			const values = enumSchema['x-enum-binary-value'];
			const published = Array.isArray(values) && values.length === enumSchema.enum.length;
			if (!published) this.note(name, 'enum values not published; index order assumed');
			this.types.set(name, { kind: 'enum', key });
			this.files.set(`types/${name}.php`, renderEnum(name, enumSchema.enum.map((v, i) => [upperSnake(v), published ? values[i] : i]), !published));
		}
		if (opts.has('allowunknownenumvalues')) this.note(where, `${name} allows unknown values, which fromPacket rejects`);
		const read = num.readCallable;
		const write = num.writeCallable;
		return {
			php: name, uses: [...num.uses, `${TYPES_NS}\\${name}`],
			read: (i) => `${name}::fromPacket(${read}(${i}))`,
			write: (o, v) => `${write}(${o}, ${v}->value)`,
		};
	}

	classType(schema, wanted, key) {
		const name = this.claim(wanted, key, schema.title);
		if (!this.types.has(name)) {
			this.types.set(name, { kind: 'class', key });
			const fields = this.fields(schema, { owner: name, ownerStem: name, inPacket: false });
			this.files.set(`types/${name}.php`, renderTypeClass(name, fields));
		}
		return {
			php: name, uses: [`${TYPES_NS}\\${name}`],
			readCallable: `${name}::read`,
			read: (i) => `${name}::read(${i})`,
			write: (o, v) => `${v}->write(${o})`,
		};
	}

	fields(schema, ctx) {
		const props = Object.entries(schema.properties || {});
		const required = new Set(schema.required || []);
		const ordered = props.every(([, p]) => typeof p['x-ordinal-index'] === 'number');
		if (!ordered && props.length > 1) this.note(ctx.owner, 'field order not given by x-ordinal-index; schema order used');
		const sorted = ordered ? [...props].sort((a, b) => a[1]['x-ordinal-index'] - b[1]['x-ordinal-index']) : props;
		const out = { list: [], todos: [] };
		for (const [field, prop] of sorted) {
			const type = this.resolve(prop, { ...ctx, field });
			out.list.push({ field, name: camel(field), type, optional: !required.has(field) });
		}
		if (!ordered && props.length > 1) out.todos.push('field order not given by x-ordinal-index; schema order used');
		return out;
	}

	packet(name) {
		const p = this.docs.packets.get(name);
		if (!p) throw new Error(`no packet ${name} in these docs`);
		const s = this.schema(p.file);
		const where = name;
		let payload = null;
		const todos = [];
		if (s.$ref) payload = this.schema(path.basename(s.$ref, '.json'));
		else if (s.properties) payload = s;
		if (!payload) todos.push(this.note(where, `payload ${s.$ref || '(none)'} has no schema`));
		else if (payload.type !== 'object' || payload.oneOf || payload.anyOf || payload.allOf) todos.push(this.note(where, 'the payload is not a plain object'));
		const fields = payload && payload.type === 'object' ? this.fields(payload, { owner: name, ownerStem: packetStem(name), inPacket: true }) : { list: [], todos: [] };
		const direction = directionOf(name, s.description || '');
		if (!direction.known) todos.push(this.note(where, 'direction not stated by the schema; keep the interface the packet travels as'));
		this.files.set(`${name}.php`, renderPacket(name, direction.interfaces, fields, [...todos, ...fields.todos]));
		return { name, id: p.id };
	}
}

function directionOf(name, description) {
	if (/^Clientbound/.test(name) || /sent by (the )?server only/i.test(description)) return { known: true, interfaces: ['ClientboundPacket'] };
	if (/^Serverbound/.test(name) || /sent by (the )?client only/i.test(description)) return { known: true, interfaces: ['ServerboundPacket'] };
	return { known: false, interfaces: ['ClientboundPacket', 'ServerboundPacket'] };
}

function fieldType(f) {
	return f.optional && f.type.php !== 'mixed' ? `?${f.type.php}` : f.type.php;
}

function readerFn(t) {
	if (t.readCallable) return `${t.readCallable}(...)`;
	return `static fn(ByteBufferReader $in) : ${t.php} => ${t.read('$in')}`;
}

function writerFn(t) {
	if (t.writeCallable) return `${t.writeCallable}(...)`;
	const v = /^[A-Z]/.test(t.php) ? `$${t.php[0].toLowerCase()}${t.php.slice(1)}` : '$value';
	return `static fn(ByteBufferWriter $out, ${t.php} ${v}) => ${t.write('$out', v)}`;
}

function readStmts(f, target) {
	const t = f.type;
	if (t.todo) return [`// ${TODO}: ${f.field}: ${t.todo}`];
	if (f.optional) {
		if (t.embedded) return [`// ${TODO}: ${f.field}: an optional embedded packet`];
		return [`${target} = CommonTypes::readOptional($in, ${readerFn(t)});`];
	}
	if (t.readStmts) return t.readStmts(target, '$in');
	return [`${target} = ${t.read('$in')};`];
}

function writeStmts(f, value) {
	const t = f.type;
	if (t.todo) return [`// ${TODO}: ${f.field}: ${t.todo}`];
	if (f.optional) {
		if (t.embedded) return [`// ${TODO}: ${f.field}: an optional embedded packet`];
		return [`CommonTypes::writeOptional($out, ${value}, ${writerFn(t)});`];
	}
	return [`${t.write('$out', value)};`];
}

function usesOf(fields, base, namespace) {
	const all = new Set(base);
	for (const f of fields.list) {
		for (const u of f.type.uses || []) all.add(u);
		if (f.optional && !f.type.todo) all.add(USE.CommonTypes);
	}
	return [...all]
		.filter((u) => u.slice(0, u.lastIndexOf('\\')) !== namespace)
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
		.map((u) => `use ${u};`);
}

function arrayDoc(f, tags) {
	if (f.type.php !== 'array') return [];
	const el = f.type.element;
	const n = f.optional ? '|null' : '';
	return tags.map(([tag, phpstan, suffix]) => `${tag} ${el}[]${n}${suffix}\n\t * ${phpstan} list<${el}>${n}${suffix}`);
}

function docblock(lines, indent = '\t') {
	if (!lines.length) return '';
	return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function getter(f) {
	const t = fieldType(f);
	const docs = arrayDoc(f, [['@return', '@phpstan-return', '']]);
	return `${docblock(docs)}\tpublic function get${f.name[0].toUpperCase()}${f.name.slice(1)}() : ${t}{\n\t\treturn $this->${f.name};\n\t}\n`;
}

function body(lines) {
	return lines.length ? lines.map((l) => `\t\t${l}`).join('\n') + '\n' : '';
}

function classTodos(todos) {
	return todos.map((t) => `// ${TODO}: ${t}\n`).join('');
}

function renderPacket(name, interfaces, fields, todos) {
	const uses = usesOf(fields, [USE.ByteBufferReader, USE.ByteBufferWriter], NS);
	const out = [];
	out.push(HEADER);
	out.push(`namespace ${NS};\n`);
	out.push(`${uses.join('\n')}\n`);
	out.push(`${classTodos(todos)}final class ${name} extends DataPacket implements ${interfaces.join(', ')}{`);
	out.push(`\tpublic const NETWORK_ID = ProtocolInfo::${pkg.constantStem(name)}_PACKET;\n`);
	for (const f of fields.list) {
		const docs = arrayDoc(f, [['@var', '@phpstan-var', '']]);
		out.push(`${docblock(docs)}\tprivate ${fieldType(f)} $${f.name};\n`);
	}
	const params = fields.list.map((f) => `${fieldType(f)} $${f.name}`).join(', ');
	const createDocs = ['@generate-create-func', ...fields.list.flatMap((f) => arrayDoc(f, [['@param', '@phpstan-param', ` $${f.name}`]]))];
	const assigns = fields.list.length
		? `\t\t$result = new self;\n${fields.list.map((f) => `\t\t$result->${f.name} = $${f.name};\n`).join('')}\t\treturn $result;\n`
		: '\t\treturn new self;\n';
	out.push(`${docblock(createDocs)}\tpublic static function create(${params}) : self{\n${assigns}\t}\n`);
	for (const f of fields.list) out.push(getter(f));
	out.push(`\tprotected function decodePayload(ByteBufferReader $in) : void{\n${body(fields.list.flatMap((f) => readStmts(f, `$this->${f.name}`)))}\t}\n`);
	out.push(`\tprotected function encodePayload(ByteBufferWriter $out) : void{\n${body(fields.list.flatMap((f) => writeStmts(f, `$this->${f.name}`)))}\t}\n`);
	out.push(`\tpublic function handle(PacketHandlerInterface $handler) : bool{\n\t\treturn $handler->handle${name.replace(/Packet$/, '')}($this);\n\t}`);
	out.push('}\n');
	return out.join('\n');
}

function renderTypeClass(name, fields) {
	const uses = usesOf(fields, [USE.ByteBufferReader, USE.ByteBufferWriter], TYPES_NS);
	const out = [];
	out.push(HEADER);
	out.push(`namespace ${TYPES_NS};\n`);
	out.push(`${uses.join('\n')}\n`);
	out.push(`${classTodos(fields.todos)}final class ${name}{\n`);
	const params = fields.list.map((f) => `\t\tprivate readonly ${fieldType(f)} $${f.name}`).join(',\n');
	const paramDocs = fields.list.flatMap((f) => arrayDoc(f, [['@param', '@phpstan-param', ` $${f.name}`]]));
	out.push(`${docblock(paramDocs)}\tpublic function __construct(${params ? `\n${params}\n\t` : ''}){\n\t}\n`);
	for (const f of fields.list) out.push(getter(f));
	const reads = fields.list.flatMap((f) => readStmts(f, `$${f.name}`));
	const ctorArgs = fields.list.map((f) => `$${f.name}`).join(', ');
	out.push(`\tpublic static function read(ByteBufferReader $in) : self{\n${body(reads)}${reads.length ? '\n' : ''}\t\treturn new self(${ctorArgs});\n\t}\n`);
	out.push(`\tpublic function write(ByteBufferWriter $out) : void{\n${body(fields.list.flatMap((f) => writeStmts(f, `$this->${f.name}`)))}\t}`);
	out.push('}\n');
	return out.join('\n');
}

function renderEnum(name, cases, assumed) {
	const out = [];
	out.push(HEADER);
	out.push(`namespace ${TYPES_NS};\n`);
	out.push(`${assumed ? `// ${TODO}: enum values not published; index order assumed\n` : ''}enum ${name} : int{`);
	out.push('\tuse PacketIntEnumTrait;\n');
	out.push(cases.map(([c, v]) => `\tcase ${c} = ${v};`).join('\n'));
	out.push('}\n');
	return out.join('\n');
}

function findExisting(src, rel) {
	const base = path.basename(rel);
	const hits = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name === base) hits.push(path.relative(src, p).replace(/\\/g, '/'));
		}
	};
	if (src && fs.existsSync(src)) walk(src);
	return hits;
}

function generate(loaded, names) {
	const g = new Generator(loaded);
	const packets = names.map((n) => g.packet(n));
	return { files: g.files, todos: g.todos, packets };
}

function parseArgs(argv) {
	const a = { packet: [], all_new: false };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--all-new') a.all_new = true;
		else if (k === '--packet') a.packet.push(argv[++i]);
		else if (['--tag', '--from', '--to', '--out', '--docs-dir', '--from-dir', '--to-dir', '--packages-src'].includes(k)) a[k.slice(2).replace(/-/g, '_')] = argv[++i];
		else throw new Error(`unknown argument ${k}`);
	}
	return a;
}

function run(args) {
	let loaded;
	let names;
	let tag;
	if (args.all_new) {
		if (args.packet.length) throw new Error('--all-new and --packet are exclusive');
		const fromDir = args.from_dir || (args.from && docs.checkout(args.from));
		const toDir = args.to_dir || (args.to && docs.checkout(args.to));
		if (!fromDir || !toDir) throw new Error('--all-new needs --from and --to, or --from-dir and --to-dir');
		const from = docs.loadDocs(fromDir);
		loaded = docs.loadDocs(toDir);
		names = docs.diffDocs(from, loaded).packets.added.map((p) => p.name);
		tag = args.to || path.basename(toDir);
	} else {
		if (!args.packet.length) throw new Error('name at least one --packet, or use --all-new');
		const dir = args.docs_dir || (args.tag && docs.checkout(args.tag));
		if (!dir) throw new Error('--packet needs --tag or --docs-dir');
		loaded = docs.loadDocs(dir);
		names = args.packet;
		tag = args.tag || path.basename(dir);
	}
	const out = path.resolve(args.out || path.join(docs.cacheRoot(), 'codegen', tag));
	const result = generate(loaded, names);
	for (const [rel, text] of result.files) {
		const p = path.join(out, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, text);
	}
	const src = args.packages_src || pkg.PROTOCOL_SRC;
	const existing = [...result.files.keys()].map((rel) => ({ file: rel, existing: findExisting(src, rel) }));
	return { out, tag, ...result, existing };
}

function render(r) {
	const lines = [`# Codegen: ${r.tag}`, '', `Written to ${r.out}`, ''];
	for (const e of r.existing) lines.push(`- ${e.file}${e.existing.length ? ` (packages/bedrock-protocol already has ${e.existing.join(', ')})` : ''}`);
	lines.push('', `## ${TODO} markers (${r.todos.length})`);
	lines.push(r.todos.length ? r.todos.map((t) => `- ${t}`).join('\n') : 'none');
	lines.push('', '## Registration');
	for (const p of r.packets) {
		lines.push(`- ProtocolInfo.php: public const ${pkg.constantStem(p.name)}_PACKET = 0x${p.id.toString(16)};`);
		lines.push(`  PacketPool.php: $this->registerPacket(new ${p.name}());`);
		lines.push(`  PacketHandlerInterface.php: public function handle${p.name.replace(/Packet$/, '')}(${p.name} $packet) : bool;`);
	}
	return lines.join('\n') + '\n';
}

if (require.main === module) {
	const r = run(parseArgs(process.argv.slice(2)));
	process.stdout.write(render(r));
}

module.exports = { run, render, generate, parseArgs, camel, upperSnake, className, TODO };

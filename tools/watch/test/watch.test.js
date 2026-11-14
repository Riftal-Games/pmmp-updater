'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const docs = require('../../lib/mojang-docs');
const fx = require('../../test-support/fixtures');
const watch = require('../watch');

const OURS = { tag: 'v1.26.60', protocol: 2225, version: '1.26.60' };

function docsFixture(protocol, extra = {}, notes = {}) {
	return fx.writeTree(fx.tempDir('watch-docs'), {
		...fx.docsTree(protocol, {
			AlphaPacket: fx.packet('AlphaPacket', 1, protocol),
			AlphaPacketPayload: { type: 'object', properties: {} },
			...extra,
		}),
		...notes,
	});
}

function packagesFixture() {
	return fx.writeTree(fx.tempDir('watch-pkg'), {
		'ProtocolInfo.php': fx.protocolInfoPhp(OURS.protocol, OURS.version, { ALPHA: 1 }),
		'AlphaPacket.php': '',
	});
}

// Our version and a hotfix with identical schemas, then a version with one new packet.
function fixtureDocs() {
	const changedTo = (protocol) => docsFixture(protocol, { NewPacket: fx.packet('NewPacket', 361, protocol), NewPacketPayload: { type: 'object', properties: {} } }, { 'developer_notes/r1/notes.md': '# Network Protocol\n- Added NewPacket' });
	return {
		'v1.26.60': docsFixture(2225),
		'v1.26.61': docsFixture(2225),
		'v1.26.70-preview.22': changedTo(2239),
		'v1.26.70-preview.23': changedTo(2240),
		'v1.26.70': changedTo(2241),
		'v1.26.80-preview.20': changedTo(2250),
		'v1.26.80-preview.21': changedTo(2251),
	};
}

const tagList = (names) => docs.parseLsRemote(names.map((n) => `x\trefs/tags/${n}`).join('\n'));

function bdsJson(release, preview) {
	return { result: { links: [
		{ downloadType: 'serverBedrockWindows', downloadUrl: `https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-${release}.zip` },
		{ downloadType: 'serverBedrockLinux', downloadUrl: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${release}.zip` },
		{ downloadType: 'serverBedrockPreviewLinux', downloadUrl: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-${preview}.zip` },
		{ downloadType: 'serverJar', downloadUrl: 'https://piston-data.mojang.com/v1/objects/0/server.jar' },
	] } };
}

const ISSUE_10 = {
	number: 10,
	state: 'OPEN',
	title: 'Bedrock 1.26.70 (protocol 2239): first version built without upstream',
	body: "Mojang's docs tag `v1.26.70-preview.22`, published 2026-10-28, gives **protocol 2239**; ours is 2225.",
	labels: [{ name: 'owner:updater' }, { name: 'route:steward' }, { name: 'M1' }, { name: 'prep' }],
};

// A fake GitHub REST API that keeps issues and comments in memory and records every
// call by the gh verb it stands for, so a test can tell reads from writes and a second
// run sees what the first one wrote. Lists come back two to a page, linked by rel="next".
const PAGE = 2;

function fakeGh(issues) {
	const state = { issues: issues.map((i) => ({ ...i, comments: [...(i.comments || [])] })), calls: [], auth: [] };
	const reply = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
	const paged = (u, items) => {
		const page = Number(u.searchParams.get('page') || 1);
		const next = new URL(u);
		next.searchParams.set('page', String(page + 1));
		const more = items.length > page * PAGE;
		return reply(200, items.slice((page - 1) * PAGE, page * PAGE), more ? { link: `<${next}>; rel="next"` } : {});
	};
	state.fetch = async (url, init = {}) => {
		const u = new URL(url);
		const method = init.method || 'GET';
		const body = init.body === undefined ? null : JSON.parse(init.body);
		state.auth.push(init.headers.authorization);
		const m = /^\/repos\/x\/y\/issues(?:\/(\d+)\/(comments|labels))?$/.exec(u.pathname);
		if (!m || u.origin !== 'https://api.github.com') throw new Error(`unexpected ${method} ${url}`);
		const issue = state.issues.find((i) => i.number === Number(m[1]));
		const verb = { 'GET ': 'list', 'GET comments': 'view', 'POST comments': 'comment', 'POST labels': 'edit', 'POST ': 'create' }[`${method} ${m[2] || ''}`];
		state.calls.push(`issue ${verb}`);
		if (verb === 'list') return paged(u, state.issues.map(({ comments, ...i }) => ({ ...i, state: i.state.toLowerCase() })));
		if (verb === 'view') return paged(u, issue.comments.map((b) => ({ body: b })));
		if (verb === 'comment') {
			issue.comments.push(body.body);
			return reply(201, { html_url: `https://github.com/x/y/issues/${issue.number}#issuecomment-1` });
		}
		if (verb === 'edit') {
			issue.labels.push(...body.labels.map((name) => ({ name })));
			return reply(200, issue.labels);
		}
		const number = Math.max(0, ...state.issues.map((i) => i.number)) + 1;
		state.issues.push({ number, state: 'OPEN', title: body.title, body: body.body, labels: body.labels.map((name) => ({ name })), comments: [] });
		return reply(201, { number, html_url: `https://github.com/x/y/issues/${number}` });
	};
	state.writes = () => state.calls.filter((c) => !['issue list', 'issue view'].includes(c));
	return state;
}

async function runWatch({ tags, bds, gh, dryRun = false, fetchBds }) {
	const dirs = fixtureDocs();
	const out = [];
	const code = await watch.main([...(dryRun ? ['--dry-run'] : []), '--repo', 'x/y', '--packages-src', packagesFixture()], {
		fetch: gh.fetch,
		token: 'test-token',
		listTags: () => tagList(tags),
		fetchBds: fetchBds || (async () => watch.parseBdsLinks(bds)),
		checkout: (tag) => {
			if (!dirs[tag]) throw new Error(`no fixture for ${tag}`);
			return dirs[tag];
		},
		write: (s) => out.push(s),
	});
	return { code, out: out.join('') };
}

const TODAY_TAGS = ['v1.26.60-preview.30', 'v1.26.60', 'v1.26.61', 'v1.26.70-preview.21', 'v1.26.70-preview.22'];
const TODAY_BDS = bdsJson('1.26.61.1', '1.26.70.22');

test('reads the Linux release and preview builds and maps each to its docs tag', () => {
	assert.deepEqual(watch.parseBdsLinks(TODAY_BDS), [
		{ channel: 'release', build: '1.26.61.1', version: '1.26.61', tag: 'v1.26.61' },
		{ channel: 'preview', build: '1.26.70.22', version: '1.26.70', tag: 'v1.26.70-preview.22' },
	]);
});

test('a BDS links layout it does not recognise fails instead of reporting nothing', () => {
	assert.throws(() => watch.parseBdsLinks({ links: [] }), /no result\.links/);
	assert.throws(() => watch.parseBdsLinks({ result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://example.com/server.tar' }] } }), /not a BDS zip/);
	assert.throws(() => watch.parseBdsLinks({ result: { links: TODAY_BDS.result.links.filter((l) => l.downloadType !== 'serverBedrockPreviewLinux') } }), /no Linux preview link/);
});

test('today: v1.26.70-preview.22 is already on #10 and v1.26.61 changes nothing, so a dry run files nothing', async () => {
	const gh = fakeGh([ISSUE_10]);
	const { code, out } = await runWatch({ tags: TODAY_TAGS, bds: TODAY_BDS, gh, dryRun: true });
	assert.equal(code, 0);
	assert.match(out, /^SKIP 1\.26\.61: v1\.26\.61 is protocol 2225 and its schemas match v1\.26\.60$/m);
	assert.match(out, /^NOTHING 1\.26\.70: v1\.26\.70-preview\.22, BDS 1\.26\.70\.22 already on #10$/m);
	assert.match(out, /^Result: 0 to file, 0 to comment$/m);
	assert.deepEqual(gh.writes(), []);
});

test('a newer preview comments on the open issue once, and the second run reports nothing new', async () => {
	const gh = fakeGh([ISSUE_10]);
	const tags = [...TODAY_TAGS, 'v1.26.70-preview.23'];
	const bds = bdsJson('1.26.61.1', '1.26.70.23');

	const dry = await runWatch({ tags, bds, gh, dryRun: true });
	assert.match(dry.out, /^COMMENT #10 \(1\.26\.70\): v1\.26\.70-preview\.23$/m);
	assert.deepEqual(gh.writes(), [], 'a dry run calls no GitHub write');

	const first = await runWatch({ tags, bds, gh });
	assert.match(first.out, /^COMMENTED https:\/\/github\.com\/x\/y\/issues\/10#issuecomment-1$/m);
	const comment = gh.issues[0].comments[0];
	assert.match(comment, /^<!-- watch:v1\.26\.70-preview\.23 -->$/m);
	assert.match(comment, /\*\*protocol 2240\*\*/);
	assert.match(comment, /Added packets \(1\): `NewPacket` \(361\)/);
	assert.match(comment, /Developer notes \(1\): `r1\/notes\.md`/);
	assert.match(comment, /BDS Linux preview `1\.26\.70\.23` is published\./);
	assert.doesNotMatch(comment, /Added NewPacket/, "Mojang's note text stays out of the issue");

	const second = await runWatch({ tags, bds, gh });
	assert.match(second.out, /^NOTHING 1\.26\.70: v1\.26\.70-preview\.23, BDS 1\.26\.70\.23 already on #10$/m);
	assert.deepEqual(gh.writes(), ['issue comment'], 'one comment over both runs');
});

test('a version with no issue is filed once with the preview labels, protocol and scope', async () => {
	const gh = fakeGh([ISSUE_10]);
	const tags = [...TODAY_TAGS, 'v1.26.80-preview.20'];

	const first = await runWatch({ tags, bds: TODAY_BDS, gh });
	assert.match(first.out, /^FILE "Bedrock 1\.26\.80 \(protocol 2250\): update from 1\.26\.60" labels owner:updater, route:steward, M1, prep: v1\.26\.80-preview\.20$/m);
	const filed = gh.issues.find((i) => i.number === 11);
	assert.deepEqual(filed.labels.map((l) => l.name), ['owner:updater', 'route:steward', 'M1', 'prep']);
	assert.match(filed.body, /^<!-- watch:v1\.26\.80-preview\.20 -->$/m);
	assert.match(filed.body, /--from v1\.26\.60 --to v1\.26\.80-preview\.20/);

	const second = await runWatch({ tags, bds: TODAY_BDS, gh });
	assert.match(second.out, /^NOTHING 1\.26\.80: v1\.26\.80-preview\.20 already on #11$/m);
	assert.deepEqual(gh.writes(), ['issue create']);
});

test('the release comments on the open preview issue and adds critical-path', async () => {
	const gh = fakeGh([ISSUE_10]);
	const tags = [...TODAY_TAGS, 'v1.26.70'];
	const { out } = await runWatch({ tags, bds: bdsJson('1.26.70.1', '1.26.70.22'), gh });
	assert.match(out, /^COMMENT #10 \(1\.26\.70\): v1\.26\.70, add label critical-path$/m);
	assert.match(gh.issues[0].comments[0], /Bedrock 1\.26\.70 is released/);
	assert.ok(gh.issues[0].labels.some((l) => l.name === 'critical-path'));
	assert.deepEqual(gh.writes(), ['issue comment', 'issue edit']);
});

test('a release with no issue is filed with critical-path', async () => {
	const gh = fakeGh([]);
	const { out } = await runWatch({ tags: [...TODAY_TAGS, 'v1.26.70'], bds: TODAY_BDS, gh });
	assert.match(out, /^FILE "Bedrock 1\.26\.70 \(protocol 2241\): update from 1\.26\.60" labels owner:updater, route:steward, M1, prep, critical-path: v1\.26\.70$/m);
});

test('a BDS build ahead of the docs is filed, and its docs tag comments with the scope when it lands', async () => {
	const gh = fakeGh([ISSUE_10]);
	const bds = bdsJson('1.26.61.1', '1.26.80.21');

	const first = await runWatch({ tags: TODAY_TAGS, bds, gh });
	assert.match(first.out, /^FILE "Bedrock 1\.26\.80 \(protocol not yet published\): update from 1\.26\.60" labels owner:updater, route:steward, M1, prep: BDS 1\.26\.80\.21$/m);
	assert.match(gh.issues[1].body, /^<!-- watch:bds:v1\.26\.80-preview\.21 -->$/m);

	const again = await runWatch({ tags: TODAY_TAGS, bds, gh });
	assert.match(again.out, /^NOTHING 1\.26\.80: BDS 1\.26\.80\.21 already on #11$/m);

	const docsLand = await runWatch({ tags: [...TODAY_TAGS, 'v1.26.80-preview.21'], bds, gh });
	assert.match(docsLand.out, /^COMMENT #11 \(1\.26\.80\): v1\.26\.80-preview\.21$/m);
	assert.match(gh.issues[1].comments[0], /\*\*protocol 2251\*\*/);
	assert.deepEqual(gh.writes(), ['issue create', 'issue comment']);
});

test('issues match a version by its whole number or by marker, and closed issues still cover their tags', () => {
	const issues = [
		{ number: 1, state: 'OPEN', title: 'Bedrock 1.26.700 (protocol 1)', body: '' },
		{ number: 2, state: 'OPEN', title: 'Bedrock 1.26.70.1 hotfix', body: '' },
		{ number: 3, state: 'CLOSED', title: 'Something renamed', body: '<!-- watch:v1.26.70-preview.20 -->' },
		{ number: 4, state: 'OPEN', title: 'Bedrock 1.26.70: scope', body: '' },
	];
	assert.deepEqual(watch.issuesForVersion(issues, '1.26.70').map((i) => i.number), [3, 4]);
	const tags = tagList(['v1.26.70-preview.2', 'v1.26.70-preview.22', 'v1.26.70']);
	const covered = watch.coverage({ body: 'see `v1.26.70-preview.22`.' }, ['<!-- watch:bds:v1.26.70-preview.23 -->'], tags);
	assert.deepEqual([...covered].sort(), ['bds:v1.26.70-preview.23', 'v1.26.70-preview.22']);
});

test('a closed issue that does not cover the new tag leads to a new issue, not a comment on the closed one', async () => {
	const closed = { ...ISSUE_10, state: 'CLOSED' };
	const gh = fakeGh([closed]);
	const { out } = await runWatch({ tags: [...TODAY_TAGS, 'v1.26.70-preview.23'], bds: TODAY_BDS, gh });
	assert.match(out, /^FILE "Bedrock 1\.26\.70 \(protocol 2240\)/m);
	assert.deepEqual(gh.writes(), ['issue create']);
});

test('nothing newer than our packages asks GitHub nothing', async () => {
	const gh = fakeGh([]);
	const { out } = await runWatch({ tags: ['v1.26.60-preview.30', 'v1.26.60'], bds: bdsJson('1.26.60.5', '1.26.60.30'), gh });
	assert.match(out, /^Result: 0 to file, 0 to comment$/m);
	assert.deepEqual(gh.calls, []);
});

test('an unreachable BDS links API still checks the docs, then fails the run', async () => {
	const gh = fakeGh([]);
	const { code, out } = await runWatch({ tags: [...TODAY_TAGS], gh, fetchBds: async () => { throw new Error('BDS links: HTTP 503'); } });
	assert.equal(code, 1);
	assert.match(out, /^WARNING BDS links: HTTP 503$/m);
	assert.match(out, /^FILE "Bedrock 1\.26\.70 \(protocol 2239\)/m);
});

test('rejects a repository argument that is not owner/name', () => {
	assert.throws(() => watch.parseArgs(['--repo', 'x/y; rm -rf /']), /not a repository name/);
	assert.throws(() => watch.parseArgs(['--bogus']), /unknown argument/);
});

test('files through the GitHub REST API with GH_TOKEN and needs no gh binary on the PATH', async () => {
	const gh = fakeGh([ISSUE_10]);
	const saved = process.env.PATH;
	process.env.PATH = fx.tempDir('watch-empty-path');
	let run;
	try {
		run = await runWatch({ tags: [...TODAY_TAGS, 'v1.26.70-preview.23'], bds: TODAY_BDS, gh });
	} finally {
		process.env.PATH = saved;
	}
	assert.equal(run.code, 0);
	assert.match(run.out, /^COMMENTED https:\/\/github\.com\/x\/y\/issues\/10#issuecomment-1$/m);
	assert.ok(gh.auth.length > 0 && gh.auth.every((a) => a === 'Bearer test-token'));
});

test('lists every page of issues and leaves out pull requests', async () => {
	const pr = { number: 6, state: 'OPEN', title: 'Bedrock 1.26.70 packets', body: '', labels: [], pull_request: {} };
	const gh = fakeGh([1, 2, 3, 4, 5].map((n) => ({ number: n, state: n === 2 ? 'CLOSED' : 'OPEN', title: `t${n}`, body: null, labels: ['owner:updater', { name: 'M1' }] })).concat([pr]));
	const issues = await watch.github({ repo: 'x/y', token: 't', fetch: gh.fetch }).listIssues();
	assert.deepEqual(issues.map((i) => i.number), [1, 2, 3, 4, 5]);
	assert.deepEqual(issues[1], { number: 2, title: 't2', state: 'CLOSED', body: '', labels: [{ name: 'owner:updater' }, { name: 'M1' }] });
	assert.deepEqual(gh.calls, ['issue list', 'issue list', 'issue list']);
});

test('a missing GH_TOKEN fails with a message naming it, before any request', async () => {
	const gh = fakeGh([ISSUE_10]);
	await assert.rejects(watch.github({ repo: 'x/y', token: '', fetch: gh.fetch }).listIssues(), /^Error: GH_TOKEN is not set\./);
	assert.deepEqual(gh.calls, []);
});

test('a GitHub API failure names the request and the reason', async () => {
	const denied = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
	await assert.rejects(watch.github({ repo: 'x/y', token: 't', fetch: denied }).comment(10, 'x'), {
		message: 'GitHub API POST /repos/x/y/issues/10/comments: HTTP 401 Bad credentials',
	});
	const offline = async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.github.com') }); };
	await assert.rejects(watch.github({ repo: 'x/y', token: 't', fetch: offline }).listIssues(), {
		message: 'GitHub API GET /repos/x/y/issues?state=all&per_page=100: fetch failed (getaddrinfo ENOTFOUND api.github.com)',
	});
});

test('a tool missing from the PATH fails the run with a message naming it, not a bare ENOENT', () => {
	const env = { PATH: fx.tempDir('watch-empty-path'), PMMP_UPDATER_CACHE: fx.tempDir('watch-cache') };
	if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'watch.js'), '--dry-run', '--repo', 'x/y', '--packages-src', packagesFixture()], { env, encoding: 'utf8' });
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /^watch: git is not on the PATH of this machine\. The watch runs git; install it or add it to the PATH of the runner that takes the job\.$/m);
	assert.doesNotMatch(r.stderr, /ENOENT/);
});

test('live: Mojang docs tags and the BDS links JSON parse', { skip: !process.env.RIFTAL_LIVE }, async () => {
	const tags = docs.listTags();
	assert.ok(tags.some((t) => t.tag === 'v1.26.60'));
	const bds = await watch.fetchBdsLinks();
	assert.deepEqual(bds.map((b) => b.channel).sort(), ['preview', 'release']);
	for (const b of bds) assert.match(b.build, /^\d+\.\d+\.\d+\.\d+$/);
});

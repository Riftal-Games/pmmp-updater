#!/usr/bin/env node
'use strict';

// Daily check for a Bedrock version newer than our packages. Reads Mojang's docs tags
// (git ls-remote, no clone needed to detect) and the BDS download links JSON (never the
// zip), then files one issue per new version in pmmp-updater, or comments on the open
// issue for that version when a newer preview or the release appears.
//
// Usage: node tools/watch/watch.js [--dry-run] [--repo <owner/name>] [--packages-src <dir>]
//
// Idempotency rests on markers: every issue and comment this tool writes carries
// <!-- watch:<tag> --> for each docs tag, or <!-- watch:bds:<tag> --> for a BDS build
// Mojang's docs have no tag for yet. An issue filed by hand counts as covering a docs
// tag when its body names that tag, as #10 does.

const docs = require('../lib/mojang-docs');
const pkg = require('../lib/packages');
const docsDiff = require('../docs-diff/diff');

const DEFAULT_REPO = 'Riftal-Games/pmmp-updater';
const BDS_LINKS_URL = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const BDS_CHANNELS = { serverBedrockLinux: 'release', serverBedrockPreviewLinux: 'preview' };
const PREVIEW_LABELS = ['owner:updater', 'route:steward', 'M1', 'prep'];
const RELEASE_LABEL = 'critical-path';
const DEFAULT_API_URL = 'https://api.github.com';

function parseArgs(argv) {
	const a = { dry_run: false, repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--dry-run') a.dry_run = true;
		else if (k === '--repo' || k === '--packages-src') a[k.slice(2).replace('-', '_')] = argv[++i];
		else throw new Error(`unknown argument ${k}`);
	}
	if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo)) throw new Error(`not a repository name: ${a.repo}`);
	return a;
}

function compareVersions(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
}

// A preview build 1.26.70.22 is docs tag v1.26.70-preview.22; a release build 1.26.61.1
// is v1.26.61. A Linux link that no longer looks like a BDS zip throws, so a change in
// Mojang's layout fails the run instead of going quiet.
function parseBdsLinks(json) {
	const links = json && json.result && json.result.links;
	if (!Array.isArray(links)) throw new Error('BDS links: no result.links array');
	const out = [];
	for (const l of links) {
		const channel = BDS_CHANNELS[l && l.downloadType];
		if (!channel) continue;
		const m = /\/bedrock-server-(\d+)\.(\d+)\.(\d+)\.(\d+)\.zip$/.exec(String(l.downloadUrl));
		if (!m) throw new Error(`BDS links: ${l.downloadType} URL is not a BDS zip: ${l.downloadUrl}`);
		const version = `${m[1]}.${m[2]}.${m[3]}`;
		const tag = channel === 'preview' ? `v${version}-preview.${Number(m[4])}` : `v${version}`;
		out.push({ channel, build: `${version}.${m[4]}`, version, tag });
	}
	for (const channel of Object.values(BDS_CHANNELS)) {
		if (!out.some((b) => b.channel === channel)) throw new Error(`BDS links: no Linux ${channel} link`);
	}
	return out;
}

async function fetchBdsLinks() {
	const res = await fetch(BDS_LINKS_URL, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`BDS links: HTTP ${res.status}`);
	return parseBdsLinks(await res.json());
}

// GitHub's REST API through fetch, so the watch needs no gh binary on the runner, only
// the job's GH_TOKEN. The issues endpoint also lists pull requests, which are dropped.
function github({ repo, token, fetch: fetchImpl = fetch, apiUrl = DEFAULT_API_URL }) {
	async function call(method, url, body) {
		if (!token) throw new Error('GH_TOKEN is not set. The watch reads and writes issues through the GitHub REST API with it; in Actions, pass GH_TOKEN: ${{ github.token }} to the step.');
		const where = `GitHub API ${method} ${url.replace(apiUrl, '')}`;
		let res;
		try {
			res = await fetchImpl(url, {
				method,
				signal: AbortSignal.timeout(30000),
				headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (e) {
			throw new Error(`${where}: ${e.message}${e.cause ? ` (${e.cause.message || e.cause})` : ''}`);
		}
		const text = await res.text();
		if (!res.ok) {
			let message = text;
			try {
				message = JSON.parse(text).message || text;
			} catch {}
			throw new Error(`${where}: HTTP ${res.status} ${message}`.trim());
		}
		const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
		return { data: text ? JSON.parse(text) : null, next: next ? next[1] : null };
	}
	async function all(path) {
		const out = [];
		for (let url = `${apiUrl}${path}`; url;) {
			const page = await call('GET', url);
			out.push(...page.data);
			url = page.next;
		}
		return out;
	}
	const base = `/repos/${repo}/issues`;
	return {
		async listIssues() {
			const items = await all(`${base}?state=all&per_page=100`);
			return items.filter((i) => !i.pull_request).map((i) => ({
				number: i.number,
				title: i.title,
				state: String(i.state).toUpperCase(),
				body: i.body || '',
				labels: (i.labels || []).map((l) => ({ name: typeof l === 'string' ? l : l.name })),
			}));
		},
		async comments(number) {
			return (await all(`${base}/${number}/comments?per_page=100`)).map((c) => c.body || '');
		},
		async create(title, body, labels) {
			return (await call('POST', `${apiUrl}${base}`, { title, body, labels })).data.html_url;
		},
		async comment(number, body) {
			return (await call('POST', `${apiUrl}${base}/${number}/comments`, { body })).data.html_url;
		},
		async addLabel(number, label) {
			await call('POST', `${apiUrl}${base}/${number}/labels`, { labels: [label] });
		},
	};
}

// A tool the watch spawns, git for Mojang's docs tags, that is missing from the PATH
// surfaces from Node as a bare "spawnSync git ENOENT".
function describeError(e) {
	if (e && e.code === 'ENOENT' && /^spawn/.test(String(e.syscall))) {
		return `${e.path} is not on the PATH of this machine. The watch runs ${e.path}; install it or add it to the PATH of the runner that takes the job.`;
	}
	return e && e.message ? e.message : String(e);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The name ends where neither a word character, a hyphen nor a further ".<digit>"
// follows, so 1.26.70 does not match 1.26.700, 1.26.70.1 or v1.26.70-preview.22.
const ENDS = '(?![\\w-]|\\.\\d)';
const MARKER = /<!-- watch:(\S+) -->/g;

const docsMarker = (tag) => `<!-- watch:${tag} -->`;
const bdsMarker = (tag) => `<!-- watch:bds:${tag} -->`;

function markersIn(text) {
	return [...String(text || '').matchAll(MARKER)].map((m) => m[1]);
}

function markerVersion(key) {
	const t = docs.parseTag(key.replace(/^bds:/, ''));
	return t ? t.version : null;
}

function issuesForVersion(issues, version) {
	const title = new RegExp(`^Bedrock ${escapeRe(version)}${ENDS}`);
	return issues.filter((i) => title.test(i.title || '') || markersIn(i.body).some((k) => markerVersion(k) === version));
}

// Everything an issue already covers: its markers, in body and comments, and, for an
// issue filed by hand, any docs tag its body names in full. A body this tool wrote is
// read by its markers alone, because it names tags the docs do not have yet.
function coverage(issue, comments, tags) {
	const covered = new Set([issue.body, ...comments].flatMap(markersIn));
	if (markersIn(issue.body).length) return covered;
	for (const t of tags) {
		if (new RegExp(`(^|[^\\w.-])${escapeRe(t.tag)}${ENDS}`).test(issue.body || '')) covered.add(t.tag);
	}
	return covered;
}

function changed(d) {
	return d.protocol.from !== d.protocol.to
		|| d.packets.added.length || d.packets.removed.length || d.packets.id_changed.length || d.packets.changed.length
		|| d.types.added.length || d.types.removed.length || d.types.changed.length || d.types.enum_values_to_check.length
		|| d.developer_notes.length;
}

function summarize(r) {
	const d = r.diff;
	const p = r.packages;
	const names = (xs, f) => (xs.length ? xs.map(f).join(', ') : 'none');
	return [
		`Mojang docs tag \`${r.to}\` gives **protocol ${d.protocol.to}**. Our packages speak ${p.version}, protocol ${p.protocol}.`,
		'',
		`Scope from \`node tools/docs-diff/diff.js --from ${r.from} --to ${r.to}\`:`,
		`- Added packets (${d.packets.added.length}): ${names(d.packets.added, (x) => `\`${x.name}\` (${x.id})`)}`,
		`- Removed packets (${d.packets.removed.length}): ${names(d.packets.removed, (x) => `\`${x.name}\` (${x.id})`)}`,
		`- Packet ID changes (${d.packets.id_changed.length}): ${names(d.packets.id_changed, (x) => `\`${x.name}\` ${x.from} to ${x.to}`)}`,
		`- Changed on the wire (${d.packets.changed.length}): ${names(d.packets.changed, (x) => `\`${x.name}\``)}`,
		`- Types: ${d.types.added.length} added, ${d.types.removed.length} removed, ${d.types.changed.length} changed on the wire, ${d.types.enum_values_to_check.length} with enum values to check`,
		`- Developer notes (${d.developer_notes.length}): ${names(d.developer_notes, (n) => `\`${n.file}\``)}. Read each one; block state notes mean BedrockData and the upgrade schemas change too.`,
		`- Against our packages: ${p.missing_classes.length} packets with no class, ${p.id_mismatch.length} packet IDs that differ.`,
	].join('\n');
}

function bdsLine(b, hasDocsTag) {
	const kind = b.channel === 'preview' ? 'preview' : 'release';
	if (hasDocsTag) return `BDS Linux ${kind} \`${b.build}\` is published.`;
	return `BDS Linux ${kind} \`${b.build}\` is published. Mojang's docs have no tag \`${b.tag}\` yet, so its protocol number is not known; the next run reports it once the tag appears.`;
}

function defaultDiff(checkout, packagesSrc) {
	return (from, to) => docsDiff.run({ from, to, from_dir: checkout(from), to_dir: checkout(to), packages_src: packagesSrc });
}

// Returns one entry per version newer than our packages: 'file', 'comment', 'skip' (a
// new tag that changes nothing against our version) or 'nothing' (already covered).
async function plan(deps) {
	const ours = deps.ours;
	const tags = deps.listTags();
	const warnings = [];
	let bds = [];
	try {
		bds = await deps.fetchBds();
	} catch (e) {
		warnings.push(e.message);
	}
	const fromTag = docs.tagForVersion(tags, ours.version);
	const newer = (v) => compareVersions(v, ours.version) > 0;
	const versions = [...new Set([...tags.map((t) => t.version), ...bds.map((b) => b.version)])].filter(newer).sort(compareVersions);
	const issues = versions.length ? await deps.gh.listIssues() : [];
	const tagNames = new Set(tags.map((t) => t.tag));
	const entries = [];

	for (const version of versions) {
		const versionTags = tags.filter((t) => t.version === version);
		const newest = versionTags[versionTags.length - 1] || null;
		const builds = bds.filter((b) => b.version === version);
		const matched = issuesForVersion(issues, version).sort((a, b) => a.number - b.number);
		const covered = new Set();
		for (const i of matched) for (const k of coverage(i, await deps.gh.comments(i.number), versionTags)) covered.add(k);
		const open = matched.find((i) => i.state === 'OPEN') || null;
		const base = { version, issue: open ? open.number : null, matched: matched.map((i) => i.number) };

		const sections = [];
		const markers = [];
		let protocol = null;
		let release = false;
		const events = [];

		if (newest && !covered.has(newest.tag)) {
			if (!fromTag) throw new Error(`no Mojang docs tag for our packages' version ${ours.version}`);
			const r = deps.diff(fromTag.tag, newest.tag);
			if (!changed(r.diff)) {
				entries.push({ ...base, kind: 'skip', tag: newest.tag, reason: `${newest.tag} is protocol ${r.diff.protocol.to} and its schemas match ${fromTag.tag}` });
				continue;
			}
			protocol = r.diff.protocol.to;
			release = release || newest.preview === null;
			markers.push(docsMarker(newest.tag));
			sections.push(summarize(r));
			events.push(newest.tag);
		}
		for (const b of builds) {
			if (tagNames.has(b.tag)) {
				if (events.includes(b.tag)) sections.push(bdsLine(b, true));
				continue;
			}
			if (covered.has(`bds:${b.tag}`)) continue;
			release = release || b.channel === 'release';
			markers.push(bdsMarker(b.tag));
			sections.push(bdsLine(b, false));
			events.push(`BDS ${b.build}`);
		}

		if (!events.length) {
			const what = [newest && newest.tag, ...builds.map((b) => `BDS ${b.build}`)].filter(Boolean).join(', ');
			entries.push({ ...base, kind: 'nothing', reason: `${what} already on ${matched.map((n) => `#${n.number}`).join(', ')}` });
			continue;
		}

		if (open) {
			const hasLabel = (open.labels || []).some((l) => l.name === RELEASE_LABEL);
			const lead = release ? `Bedrock ${version} is released. This is now critical path.` : `A newer Bedrock ${version} preview is out.`;
			entries.push({ ...base, kind: 'comment', events, addLabel: release && !hasLabel ? RELEASE_LABEL : null, body: [...markers, lead, '', ...sections.flatMap((s) => [s, ''])].join('\n').trimEnd() + '\n' });
			continue;
		}

		const labels = release ? [...PREVIEW_LABELS, RELEASE_LABEL] : [...PREVIEW_LABELS];
		const title = `Bedrock ${version} (protocol ${protocol === null ? 'not yet published' : protocol}): update from ${ours.version}`;
		const done = release
			? `**Done means** \`/protocol-update ${version}\` completes and the downtime from release to a merged image is recorded in \`docs/versions/${version}.md\`.`
			: `**Done means** \`/protocol-update ${version}\` has its preview stages done on \`bedrock-${version}\`, with nothing merged into a mainline before Mojang releases ${version}.`;
		const body = [...markers, `Filed by \`tools/watch\`. Rerun \`/docs-diff\` on each new preview and at release; the watch comments here when one appears.`, '', ...sections.flatMap((s) => [s, '']), done].join('\n') + '\n';
		entries.push({ ...base, kind: 'file', events, title, labels, body });
	}
	return { ours, fromTag: fromTag ? fromTag.tag : null, tags, bds, versions, entries, warnings };
}

function render(p, dryRun) {
	const out = [];
	out.push(dryRun ? 'watch: dry run, no GitHub writes' : 'watch');
	out.push(`Our packages: ${p.ours.version}, protocol ${p.ours.protocol}, docs tag ${p.fromTag || 'none'}`);
	const newestPerVersion = p.versions.map((v) => p.tags.filter((t) => t.version === v).pop()).filter(Boolean).map((t) => t.tag);
	out.push(`Docs tags newer than ours, newest per version: ${newestPerVersion.join(', ') || 'none'}`);
	out.push(`BDS Linux: ${p.bds.map((b) => `${b.channel} ${b.build}`).join(', ') || 'unavailable'}`);
	for (const e of p.entries) {
		if (e.kind === 'skip') out.push(`SKIP ${e.version}: ${e.reason}`);
		else if (e.kind === 'nothing') out.push(`NOTHING ${e.version}: ${e.reason}`);
		else if (e.kind === 'comment') {
			out.push(`COMMENT #${e.issue} (${e.version}): ${e.events.join(', ')}${e.addLabel ? `, add label ${e.addLabel}` : ''}`);
			if (dryRun) out.push(...e.body.trimEnd().split('\n').map((l) => `  | ${l}`));
		} else {
			out.push(`FILE "${e.title}" labels ${e.labels.join(', ')}: ${e.events.join(', ')}`);
			if (dryRun) out.push(...e.body.trimEnd().split('\n').map((l) => `  | ${l}`));
		}
	}
	for (const w of p.warnings) out.push(`WARNING ${w}`);
	const count = (k) => p.entries.filter((e) => e.kind === k).length;
	out.push(`Result: ${count('file')} to file, ${count('comment')} to comment`);
	return out.join('\n') + '\n';
}

async function apply(p, gh) {
	const done = [];
	for (const e of p.entries) {
		if (e.kind === 'file') done.push(`FILED ${await gh.create(e.title, e.body, e.labels)}`);
		else if (e.kind === 'comment') {
			done.push(`COMMENTED ${await gh.comment(e.issue, e.body)}`);
			if (e.addLabel) {
				await gh.addLabel(e.issue, e.addLabel);
				done.push(`LABELLED #${e.issue} ${e.addLabel}`);
			}
		}
	}
	return done;
}

async function main(argv, deps = {}) {
	const args = parseArgs(argv);
	const write = deps.write || ((s) => process.stdout.write(s));
	const gh = github({
		repo: args.repo,
		token: 'token' in deps ? deps.token : process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
		fetch: deps.fetch,
		apiUrl: process.env.GITHUB_API_URL || DEFAULT_API_URL,
	});
	const p = await plan({
		ours: pkg.readProtocolInfo(args.packages_src),
		listTags: deps.listTags || docs.listTags,
		fetchBds: deps.fetchBds || fetchBdsLinks,
		diff: deps.diff || defaultDiff(deps.checkout || docs.checkout, args.packages_src),
		gh,
	});
	write(render(p, args.dry_run));
	if (!args.dry_run) {
		const done = await apply(p, gh);
		if (done.length) write(done.join('\n') + '\n');
	}
	return p.warnings.length ? 1 : 0;
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
		process.stderr.write(`watch: ${describeError(e)}\n`);
		process.exitCode = 1;
	});
}

module.exports = { BDS_LINKS_URL, DEFAULT_REPO, describeError, parseArgs, parseBdsLinks, fetchBdsLinks, compareVersions, issuesForVersion, coverage, markersIn, summarize, plan, render, apply, main, github };

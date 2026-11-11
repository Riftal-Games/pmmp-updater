'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const n = require('../nethernet');
const { makeKeys } = require('../tracer');

const ETH0 = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '172.22.0.2', internal: false }], docker0: [{ family: 'IPv4', address: '10.9.0.1', internal: false }] };
const FP = 'AB:CD:EF';
const SDP = ['v=0', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${FP.toLowerCase()}`, 'a=candidate:1 1 udp 2130706431 10.9.0.1 5000 typ host', 'a=candidate:2 1 udp 2130706431 172.22.0.2 5001 typ host', 'a=candidate:3 1 tcp 2130706431 172.22.0.2 9 typ host', 'a=candidate:4 1 udp 1694498815 203.0.113.9 5002 typ srflx', 'a=end-of-candidates'].join('\r\n');
const lines = (sdp) => sdp.split('\r\n').filter(Boolean);
const signs = (signed, s, key) => crypto.verify('sha384', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
const detached = (jws, payload, key) => signs(`${jws.split('.')[0]}.${Buffer.from(payload).toString('base64url')}`, jws.split('.')[2], key);
const PAYLOAD = `{"fingerprint":[{"algorithm":"sha-256","digest":"${FP}"}]}`;

test('a message is cut into counted segments of 10000 bytes, and at most 255 of them', () => {
	const parts = n.segments(crypto.randomBytes(25000));
	assert.deepEqual(parts.map((p) => [p[0], p.length]), [[2, 10001], [1, 10001], [0, 5001]]);
	assert.deepEqual(n.segments(Buffer.alloc(0)), [Buffer.from([0])]);
	assert.equal(n.segments(Buffer.alloc(255 * 10000)).length, 255);
	assert.throws(() => n.segments(Buffer.alloc(255 * 10000 + 1)), /256 segments, more than 255/);
});

test('segments are joined by count whatever their size, and a bad count is refused', () => {
	const r = new n.Reassembly();
	const message = crypto.randomBytes(1000);
	const got = n.segments(message, 7).map((s) => r.push(s));
	assert.deepEqual([got.slice(0, -1).every((m) => m === null), got.at(-1)], [true, message]);
	assert.deepEqual(r.push(Buffer.from([0, 9])), Buffer.from([9]));
	assert.equal(r.push(Buffer.from([254, 1])), null);
	assert.throws(() => new n.Reassembly().push(Buffer.from([255, 1])), /announces 256 segments/);
	assert.throws(() => r.push(Buffer.from([252, 1])), /segment count 252 follows 254/);
	assert.throws(() => r.push(Buffer.alloc(0)), /empty/);
});

test('the one candidate is eth0\'s IPv4 address from the interface list, with no STUN, TURN or other socket', () => {
	assert.equal(n.hostAddress(ETH0), '172.22.0.2');
	assert.throws(() => n.hostAddress({ lo: ETH0.lo }), /eth0 has 0/);
	assert.throws(() => n.hostAddress({ eth0: [ETH0.eth0[1], { ...ETH0.eth0[1], address: '172.22.0.3' }] }), /eth0 has 2/);
	assert.deepEqual(n.peerConfig('172.22.0.2'), { iceServers: [], iceUseDefaultStunServer: false, iceInterfaceAddresses: { udp4: '172.22.0.2' }, iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false, certificateScope: 'peerConnection' });
	const sdp = n.offer(SDP, '172.22.0.2', makeKeys());
	assert.deepEqual(lines(sdp).filter((l) => l.startsWith('a=candidate:')), ['a=candidate:2 1 udp 2130706431 172.22.0.2 5001 typ host']);
	assert.equal(lines(sdp).at(-1), 'a=end-of-candidates');
	assert.ok(lines(sdp).findIndex((l) => l.startsWith('a=identity:')) < lines(sdp).findIndex((l) => l.startsWith('m=')));
	assert.throws(() => n.offer(SDP, '172.22.0.9', makeKeys()), /0 UDP host candidates/);
});

test('the identity names the login key in cpk and x5u and signs the DTLS fingerprints with it', () => {
	const keys = makeKeys();
	const id = JSON.parse(Buffer.from(n.identity(keys, [{ algorithm: 'sha-256', digest: FP }]), 'base64'));
	assert.deepEqual(id.idp, { domain: 'self', protocol: 'default' });
	const { fingerprints, token } = JSON.parse(id.assertion);
	const [head, body] = token.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url')));
	assert.deepEqual([head.alg, head.x5u, body.cpk, body.exp - body.iat], ['ES384', keys.der, keys.der, 60]);
	assert.ok(signs(token.slice(0, token.lastIndexOf('.')), token.split('.')[2], keys.publicKey));
	assert.equal(fingerprints.split('.')[1], '');
	assert.ok(detached(fingerprints, PAYLOAD, keys.publicKey));
	const forged = JSON.parse(JSON.parse(Buffer.from(n.identity(keys, [{ algorithm: 'sha-256', digest: FP }], makeKeys().privateKey), 'base64')).assertion).fingerprints;
	assert.ok(!detached(forged, PAYLOAD, keys.publicKey));
});

// werift and BDS stood in for: each peer offers SDP's candidates, the first offer gets
// BDS's identity refusal and the second an answer, and both channels open at once.
function fakes() {
	const [peers, posts, logs] = [[], [], []];
	const event = () => ({ fns: [], subscribe(f) { this.fns.push(f); }, watch: async () => {} });
	class RTCPeerConnection {
		constructor(config) { Object.assign(this, { config, channels: [], iceGatheringState: 'complete', connectionStateChange: event(), closed: false }); peers.push(this); }
		createDataChannel(label) { const c = { label, sent: [], stateChange: event(), onMessage: event(), send(b) { this.sent.push(b); } }; this.channels.push(c); return c; }
		async createOffer() { return { type: 'offer', sdp: SDP }; }
		async setLocalDescription(d) { this.localDescription = d; }
		async setRemoteDescription(d) { this.remote = d; }
		async getStats() { return new Map([['r', { type: 'remote-candidate', candidateType: 'prflx', address: '172.22.0.2' }]]); }
		close() { this.closed = true; }
	}
	const get = async (url, o = {}) => {
		if (o.method === 'POST') posts.push(o.body);
		const body = o.method !== 'POST' ? '' : posts.length === 1 ? '37' : 'v=0\r\nm=application 19132 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:9 1 udp 1 172.22.0.2 19132 typ host\r\na=candidate:8 1 udp 1 bds.local 19132 typ host';
		return { ok: true, status: 200, headers: { get: () => 'application/sdp' }, text: async () => body };
	};
	const link = n.transport({ address: '10.9.0.1', port: 19132, info: { version: { major: 1, minor: 2, patch: 3, protocol_version: 4 } }, keys: makeKeys(), log: (s) => logs.push(s), interfaces: ETH0, get, werift: () => ({ RTCPeerConnection }) });
	return { link, peers, posts, logs };
}

test('the transport offers only eth0, learns whether BDS checks the identity, and drops mDNS candidates', async (t) => {
	process.env.RIFTAL_NETHERNET_ADDRESS = '10.9.0.1';
	t.after(() => delete process.env.RIFTAL_NETHERNET_ADDRESS);
	const { link, peers, posts, logs } = fakes();
	await link.open(() => {}, () => {});
	assert.equal(posts.length, 2);
	for (const p of posts) assert.deepEqual(lines(p).filter((l) => l.startsWith('a=candidate:')).map((l) => l.split(' ')[4]), ['172.22.0.2']);
	assert.ok(peers.every((p) => p.config.iceServers.length === 0 && p.config.iceInterfaceAddresses.udp4 === '172.22.0.2'));
	assert.deepEqual([peers[0].closed, peers[1].channels.map((c) => c.label)], [true, ['ReliableDataChannel', 'UnreliableDataChannel']]);
	assert.ok(!peers[1].remote.sdp.includes('bds.local'));
	assert.ok(logs.includes('nethernet: a forged fingerprint signature gets no answer, code 37'));
	assert.ok(logs.some((l) => l.endsWith('remote candidates [prflx, container eth0], 1 mDNS dropped')));
});

test('batches go out segmented on the reliable channel, come in from both, and onClose fires once', async () => {
	const { link, peers } = fakes();
	const [got, closed] = [[], []];
	await link.open((m) => got.push(m), (e) => closed.push(e.message));
	const [reliable, unreliable] = peers[1].channels;
	link.send(Buffer.alloc(15000, 1));
	assert.deepEqual([reliable.sent.map((s) => s[0]), unreliable.sent.length], [[1, 0], 0]);
	unreliable.onMessage.fns[0](Buffer.from([0, 7]));
	reliable.onMessage.fns[0](Buffer.from([1, 8]));
	reliable.onMessage.fns[0](Buffer.from([0, 9]));
	reliable.onMessage.fns[0](Buffer.from([1, 2]));
	reliable.onMessage.fns[0](Buffer.from([5, 1]));
	peers[1].connectionStateChange.fns[0]('failed');
	reliable.onMessage.fns[0](Buffer.from([0, 6]));
	assert.deepEqual([got, closed], [[Buffer.from([7]), Buffer.from([8, 9])], ['segment count 5 follows 1']]);
	link.close();
	assert.ok(peers.every((p) => p.closed));
});

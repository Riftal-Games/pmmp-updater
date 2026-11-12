'use strict';

// The NetherNet client transport the tracer joins BDS with, per ADR 003: HTTP signalling
// on BDS's server port, an identity signed with the login's key, a werift peer whose one
// candidate is the container's own eth0 address, and BDS's two data channels, which carry
// each game batch in segments.

const crypto = require('crypto');
const os = require('os');

const SEGMENT = 10000;
const MAX_SEGMENTS = 255;
const CHANNELS = [['ReliableDataChannel', { ordered: true }], ['UnreliableDataChannel', { ordered: false, maxRetransmits: 0 }]];
const HEADERS = { 'user-agent': 'libhttpclient/1.0.0.0' };

// Each segment starts with how many segments follow it, so the last one carries 0.
function segments(message, size = SEGMENT) {
	const count = Math.max(1, Math.ceil(message.length / size));
	if (count > MAX_SEGMENTS) throw new Error(`a ${message.length}-byte message needs ${count} segments, more than ${MAX_SEGMENTS}`);
	return Array.from({ length: count }, (_, i) => Buffer.concat([Buffer.from([count - 1 - i]), message.subarray(i * size, (i + 1) * size)]));
}

// Joined by count alone, whatever size the sender cut its segments to.
class Reassembly {
	constructor() { Object.assign(this, { parts: [], left: null }); }

	push(segment) {
		if (!segment.length) throw new Error('an empty NetherNet segment');
		const left = segment[0];
		if (this.left === null && left >= MAX_SEGMENTS) throw new Error(`a message announces ${left + 1} segments, more than ${MAX_SEGMENTS}`);
		if (this.left !== null && left !== this.left - 1) throw new Error(`segment count ${left} follows ${this.left}`);
		this.parts.push(segment.subarray(1));
		this.left = left;
		if (left) return null;
		const message = Buffer.concat(this.parts);
		Object.assign(this, { parts: [], left: null });
		return message;
	}
}

// Read inside the container, never passed in, so a host address cannot be offered by mistake.
function hostAddress(interfaces) {
	const own = (interfaces.eth0 || []).filter((i) => i.family === 'IPv4' && !i.internal);
	if (own.length !== 1) throw new Error(`eth0 has ${own.length} IPv4 addresses, not one`);
	return own[0].address;
}

// No STUN or TURN server and no fallback to werift's default one, and the eth0 socket is
// the only one werift binds. werift resolves an mDNS name only for a remote candidate
// holding one, and the answer's are dropped before werift sees them.
const peerConfig = (address) => ({ iceServers: [], iceUseDefaultStunServer: false, iceInterfaceAddresses: { udp4: address }, iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false, certificateScope: 'peerConnection' });

const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const es384 = (signed, key) => crypto.sign('sha384', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

// go-nethernet's identity.go layout: a token naming the key in cpk and x5u, and a JWS with
// its payload detached over the DTLS fingerprints. signer is the same key unless a forged
// identity is wanted.
function identity(keys, fingerprints, signer = keys.privateKey, now = Math.floor(Date.now() / 1000)) {
	const signed = `${b64url({ alg: 'ES384', x5u: keys.der })}.${b64url({ cpk: keys.der, iat: now, exp: now + 60 })}`;
	const head = b64url({ alg: 'ES384' });
	const assertion = { fingerprints: `${head}..${es384(`${head}.${b64url({ fingerprint: fingerprints })}`, signer)}`, token: `${signed}.${es384(signed, keys.privateKey)}` };
	return Buffer.from(JSON.stringify({ assertion: JSON.stringify(assertion), idp: { domain: 'self', protocol: 'default' } })).toString('base64');
}

const candidate = (line) => {
	const f = line.replace(/^a=candidate:/, '').split(' ');
	return { transport: (f[2] || '').toLowerCase(), address: f[4], type: f[7] };
};
const candidates = (sdp) => sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'));

// werift's offer cut to the one UDP host candidate on eth0, then end-of-candidates, with
// the identity at session level.
function offer(sdp, address, keys, signer) {
	const lines = sdp.split(/\r?\n/).filter(Boolean);
	const own = candidates(sdp).filter((l) => {
		const c = candidate(l);
		return c.transport === 'udp' && c.address === address && c.type === 'host';
	});
	if (own.length !== 1) throw new Error(`werift offered ${own.length} UDP host candidates on ${address}, not one`);
	const fingerprints = lines.filter((l) => l.startsWith('a=fingerprint:')).map((l) => {
		const [algorithm, digest] = l.slice(14).split(' ');
		return { algorithm, digest: digest.toUpperCase() };
	});
	if (!fingerprints.length) throw new Error('werift offered no DTLS fingerprint');
	const rest = lines.filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates');
	rest.splice(rest.findIndex((l) => l.startsWith('m=')), 0, `a=identity:${identity(keys, fingerprints, signer)}`);
	return `${[...rest, own[0], 'a=end-of-candidates'].join('\r\n')}\r\n`;
}

const addressClass = (a, own) => (a === own ? 'container eth0' : /^(127\.|::1$|::ffff:127\.)/.test(a) ? 'loopback' : /^(fe80|169\.254\.)/i.test(a) ? 'link-local' : /\.local$/.test(a) ? 'mDNS name' : 'other');

// The transport raknet.js states, with each batch whole on the data channels and no 0xfe.
// DTLS encrypts the channels, and BDS does not run Bedrock's cipher over them.
function transport({ port, info, keys, log, interfaces = os.networkInterfaces(), get = fetch, werift = () => require('werift') }) {
	const base = `http://127.0.0.1:${port}/v1/join`;
	const id = () => crypto.randomBytes(8).readBigUInt64BE().toString();
	const peers = [];
	let [reliable, ended] = [null, false];
	const peer = (RTCPeerConnection, labels) => {
		if (ended) throw new Error('the NetherNet transport is closed');
		const pc = new RTCPeerConnection(peerConfig(hostAddress(interfaces)));
		peers.push(pc);
		return [pc, labels.map(([label, o]) => pc.createDataChannel(label, o))];
	};
	const join = async (pc, signer) => {
		const address = hostAddress(interfaces);
		await pc.setLocalDescription(await pc.createOffer());
		if (pc.iceGatheringState !== 'complete') await pc.iceGatheringStateChange.watch((s) => s === 'complete');
		const res = await get(`${base}/${id()}`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/sdp' }, body: offer(pc.localDescription.sdp, address, keys, signer), signal: AbortSignal.timeout(15000) });
		const body = await res.text();
		const code = /^\d+$/.test(body) ? body : null;
		const theirs = candidates(body).map(candidate).map((c) => `${c.type}, ${addressClass(c.address, address)}`);
		log(`nethernet: POST /v1/join/<id> ${res.status} ${res.headers.get('content-type')}, ${code ? `code ${code}` : `an answer with candidates [${theirs.join('; ')}]`}`);
		return { address, answer: res.ok && !code ? body : null, code };
	};
	const open = async (onMessage, onClose) => {
		const { RTCPeerConnection } = werift();
		const end = (e) => {
			if (!ended) onClose(e);
			ended = true;
		};
		const v = info.version;
		const status = await get(`${base}?${new URLSearchParams({ version: `${v.major}.${v.minor}.${v.patch}`, protocol: v.protocol_version, platform: 7, id: id() })}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
		log(`nethernet: GET /v1/join ${status.status} ${status.headers.get('content-type')} ${JSON.stringify(await status.text())}`);
		// Whether BDS checks the identity is logged on every run, by one offer from a peer of
		// its own whose fingerprints another key signed.
		const [probe] = peer(RTCPeerConnection, CHANNELS.slice(0, 1));
		const forged = await join(probe, crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey);
		log(`nethernet: a forged fingerprint signature gets ${forged.answer ? 'an SDP answer, so BDS does not check it' : `no answer, code ${forged.code}`}`);
		probe.close();
		const [pc, channels] = peer(RTCPeerConnection, CHANNELS);
		const opened = Promise.all(channels.map((c) => c.stateChange.watch((s) => s === 'open')));
		let first = true;
		for (const c of channels) {
			const r = new Reassembly();
			c.onMessage.subscribe((data) => {
				try {
					const m = ended ? null : r.push(Buffer.from(data));
					if (!m) return;
					if (first) log(`nethernet: the first message from BDS starts 0x${m[0].toString(16)}, ${m.length} bytes, on ${c.label}`);
					first = false;
					onMessage(m);
				} catch (e) {
					end(e);
				}
			});
		}
		const { address, answer, code } = await join(pc);
		if (!answer) throw new Error(`BDS refused the offer, code ${code}`);
		const mdns = candidates(answer).filter((l) => /\.local$/.test(candidate(l).address));
		await pc.setRemoteDescription({ type: 'answer', sdp: answer.split(/\r?\n/).filter((l) => !mdns.includes(l)).join('\r\n') });
		pc.connectionStateChange.subscribe((s) => ['failed', 'closed', 'disconnected'].includes(s) && end(new Error(`the NetherNet peer connection is ${s}`)));
		await opened;
		const learnt = [...(await pc.getStats()).values()].filter((s) => s.type === 'remote-candidate');
		log(`nethernet: ${channels.map((c) => c.label).join(' and ')} open; remote candidates [${learnt.map((s) => `${s.candidateType}, ${addressClass(s.address, address)}`).join('; ')}]${mdns.length ? `, ${mdns.length} mDNS dropped` : ''}`);
		reliable = channels[0];
	};
	return {
		bedrockCipher: false,
		open,
		send(batch) {
			const parts = segments(batch);
			if (parts.length > 1) log(`nethernet: sent a ${batch.length}-byte batch in ${parts.length} segments`);
			for (const s of parts) reliable.send(s);
		},
		close() {
			ended = true;
			for (const pc of peers.splice(0)) pc.close();
		},
	};
}

module.exports = { SEGMENT, MAX_SEGMENTS, CHANNELS, segments, Reassembly, hostAddress, peerConfig, identity, offer, addressClass, transport };

# 003 NetherNet transport for the BDS tracer

Date: 2026-11-10
Status: accepted
Milestone: M1
Issue: pmmp-updater#3

## Context

ADR 002's decision table gives 19 files the source "BDS packets", each marked "PR 3",
and its Consequences say "#3, PR 3 decodes a capture and fills in every row marked
PR 3". Those 19 come from eight packets: `StartGamePacket`, `ItemRegistryPacket`,
`CreativeContentPacket`, `CraftingDataPacket`, `BiomeDefinitionListPacket`,
`AvailableActorIdentifiersPacket`, `JigsawStructureDataPacket`, `VoxelShapesPacket`
(`WANTED`, `tools/bds/tracer.js:27`).
`tracer.js` speaks RakNet only, and `run.sh` forces `transport=raknet`, which BDS accepts
while warning that logins need NetherNet. The steward's ruling on #3 (issuecomment
6763815334) item 2 takes the packets over NetherNet, built inside #3, behind this ADR: it
is the first outside runtime dependency in `tools/`, and every later version run
inherits it. The ADR pins the library and its licence, fetches it into the cache
hash-verified before the run, and keeps RakNet as an option. Item 4 keeps the
container's own checksum-pinned Node 22 on the pinned `ubuntu:24.04` (hard rule 7). The
scope ruling (6761625992) sets a throwaway `riftal_smoke_` container, `--rm`, `timeout`,
`-m`, `--cpus`, `--network none`, no published port, BDS from the read-only cache, and
nothing from Mojang committed. The steward's ruling on this ADR (issuecomment
6782703312) accepts decision 7's network shape in place of `--network none`, and sets
its conditions and the live run's proofs; with this ADR merged, it is the acceptance.
The steward's issuecomment on PR #37's third round sets the fixture tests for those
conditions.

## Sources

- The spike's own observations on #3, below.
- `df-mc/go-nethernet`, MIT.
- `PrismarineJS/node-nethernet`, MIT.
- Mojang's `bedrock_server_how_to.html`, in the BDS zip under the Minecraft EULA, read
  from the cache and never committed.

Outside implementations are references only. Our code is our own, and the protocol
number and packets come from `packages/` only.

## Finding

Spike 2026-11-10 on #3, BDS Linux 1.26.63.1, WSL docker engine.

1. **Sockets.** The shipped `server.properties` has `transport=nethernet`. After
   `Server started.` BDS holds only `tcp6 :::19132 LISTEN` and `udp6 :::7551`.
2. **Signalling is plain HTTP on TCP `server-port`.** `GET /v1/join` returns an empty
   body with `enable-lan-visibility=false` in the steward's reproduction and the live
   runs of finding 7. One diagnostic run with it `true`, recorded in the body of closed
   PR #42 and not that branch's setting, returned name, protocol 2225 and version
   1.26.63. The spike's GET returned name, protocol 2225 and version, its setting
   unrecorded. The tracer takes the protocol from `packages/` either way, so the body is
   diagnostic only. `POST /v1/join/1` takes an SDP offer: without `a=identity` it
   answers `37` (identity not allowed), which did reproduce; with a self-signed ES384
   identity it answers `application/sdp` with setup:active, sctp-port 5000, ice
   trickle, no max-message-size, and under `--network none` no `a=candidate`. No Xbox
   Live is needed under `online-mode=false`.
3. **No candidate under `--network none`.** ICE never connected there: with loopback its
   only interface, BDS gathered no candidate and opened no UDP socket, whatever
   `server-ip` and `server-udp-ports` said. On the isolated network BDS answers with a
   host candidate on `eth0` and ICE connects (finding 7).
4. **Framing.** Channels `ReliableDataChannel` and `UnreliableDataChannel`. A reliable
   message is a u8 remaining-segment count plus a fragment, joined until 0. The payload
   is the game batch without RakNet's `0xfe`. BDS's WebRTC is libwebrtc (dcsctp).
5. **Libraries**, tested in a `--network none` container on the cached Node 22.23.4:

| Library | Licence | Shape | Loopback result |
|---|---|---|---|
| werift 0.27.0 | MIT | pure JS, engines node>=22, no install scripts, 11 packages, 22.3 MB installed, includes mediabunny 1.65.2 (MPL-2.0) and multicast-dns | two peers opened both channels in 376 ms with `iceAdditionalHostAddresses:['127.0.0.1']` |
| node-datachannel 0.33.6 | MPL-2.0 | native libdatachannel, prebuilt 9.07 MB N-API binary, OpenSSL 1.1.1w (end of life) statically linked | connected in 84 ms |
| @roamhq/wrtc 0.10.0 | BSD-2 | prebuilt libwebrtc | untested |
| PrismarineJS nethernet 1.1.2 | MIT | pins werift 0.24.4, needs node>=24 | reference only |

6. **Network shapes, measured by the steward (6782703312)**, with a listener on
   `[::]:19132/tcp` standing in for BDS and egress tried to `1.1.1.1:443`, a LAN address
   of the machine and its default gateway.
   - `docker network create --internal` with the default gateway: the distro holds
     172.24.0.1 on the bridge, and a host process reached 172.24.0.2:19132.
   - The same with `com.docker.network.bridge.gateway_mode_ipv4=isolated`: no host
     address or route on the bridge, a connect from the host fails, every egress fails
     with ENETUNREACH, and a container on the default bridge cannot reach it.
   - `--network none` plus a dummy `/32` set up by a short-lived `NET_ADMIN` sidecar
     joined through `--network container:` works and isolates fully.
   - On both internal networks the container's `eth0` has `disable_ipv6=1` and no
     `fe80` address.
   - BDS booted with `transport=nethernet` under `--network none` and under the isolated
     network reaches `Server started.` in both. Under the isolated network it holds
     finding 1's two sockets plus Docker's embedded DNS on `127.0.0.11`, and
     `example.com` and `github.com` resolve to no address.
7. **Live runs**, PRs #41, #44 and #45 and an independent QA live run, BDS Linux
   1.26.63.1, on the isolated network.
   - **Candidates.** BDS's answer carries one host candidate, on the container's
     `eth0`, and none on loopback or a host address. It trickles none, since HTTP
     signalling gives it no way to. P4 passed in every run.
   - **Identity.** BDS checks it: an offer with a forged fingerprint signature gets code
     37 and no answer, and the real one gets an SDP answer.
   - **DTLS and SCTP.** werift 0.27.0 opens `ReliableDataChannel` and
     `UnreliableDataChannel` with BDS's libwebrtc.
   - **Segments.** A login of about 22.5 kB, sent as 3 segments of at most 10000 bytes,
     is accepted, and BDS goes on to `StartGamePacket` with no disconnect.
   - **No `0xfe`.** BDS's first message starts `0x0c`, the length prefix of the 12-byte
     `NetworkSettingsPacket`.
   - **No Bedrock cipher over NetherNet.** BDS sends `ServerToClientHandshakePacket`,
     and neither side encrypts after it: the batches that follow decode plain, and a
     client that starts the cipher gets nothing more from BDS.
   - **DeviceOS.** Over NetherNet (#44), a self-signed login whose client data carries
     `DeviceOS` 7 (Windows 10) is refused with "Connection Request invalid. readNoHeader
     failed! packetId: 1", and 1, 8, 9, 12 and 15 are accepted. BDS 1.26.63.1 refuses
     every RakNet login at the transport, so a RakNet refusal on it is the transport's,
     and no other `DeviceOS` was sent to it over RakNet.
   - **Capture.** `capture.bin` holds all eight `WANTED` packets, 124 to 142 records per
     run, and the tracer exits 0.
   - **Signalling log line.** BDS logs "Signed in to signaling service successfully"
     about 0.1 s before `Server started.`
8. **RakNet control, our own server**, PRs #44 and #45. No BDS run observed the cipher
   over RakNet, since BDS 1.26.63.1 refuses every RakNet login at the transport (#41).
   The record is a control against our own server, `local-pocketmine-mp` at 25085bf:
   the tracer over `--transport raknet` enables encryption after the handshake and logs
   in, and in #45 receives all eight `WANTED` packets.

Finding 7 settles candidate gathering on the isolated network, the identity check,
werift against libwebrtc's DTLS and SCTP, the segment size, the absence of `0xfe` and
encryption over NetherNet. Finding 8 shows the cipher over RakNet against our own server
only. Finding 2 has one diagnostic run as its only record of what `GET /v1/join` returns
with `enable-lan-visibility=true`.

Unknown: what BDS means by "Signed in to signaling service successfully". It is not an
outside connection: the network is isolated by the check before start, P1 and P2, and
P3's outside connect and name resolution fail. The socket dumps cannot show it either
way: `run.sh` takes the first only once `Server started` appears
(`tools/bds/run.sh:56-60`), about 0.1 s after the sign-in line. An outside peer in a
socket dump, or an outside connect or name resolution succeeding in P3, sends the run
back to the steward.

## Decision

1. **Library: werift 0.27.0**, integrity
   `sha512-JgFfqVXZ4s3A+VE2DxMo5QympNAnravCuQdNqQeBiKIrojtpjghYahgnl5Vc+sh0Porsx/LHODNMdZKM/JbksA==`.
   Licence MIT, confirmed on the registry, with mediabunny MPL-2.0 used unmodified and
   never redistributed.
2. **Pinning.** `tools/bds/package.json` is `private: true` with no `type` and no
   `scripts`, and declares exactly `werift: 0.27.0`. `tools/bds/package-lock.json` (npm
   lockfile v3, made with `--package-lock-only --ignore-scripts`) pins all 11 packages by
   `resolved` URL and sha512 `integrity`. A test fails on any `resolved` off
   `https://registry.npmjs.org/`, any entry without sha512, any install script, any
   entry with `os`, `cpu` or `optional`, or any licence outside MIT, ISC, BSD-2-Clause,
   BSD-3-Clause, Apache-2.0 and MPL-2.0. No tarball and no `node_modules` is committed,
   and nothing is unpacked into the tree, so `.gitignore` carries no entry for them. A
   PR that ever needs a `.gitignore` change routes to the steward.
3. **Fetch.** `record.js` downloads each locked tarball into `<cache>/npm/`, checks its
   sha512 and renames it into place only on a match, re-checking cached files on every
   run, as `nodeTarball` does. It never requires or unpacks them. `run.sh` takes
   `<cache>/npm` read-only, checks every hash again, unpacks with `tar` into its
   `mktemp -d` tree at the lockfile's paths, fails on any `.node` file found there, and
   runs the tracer with `NODE_PATH` there. No npm and no install script runs, so the
   dependency executes only inside the throwaway container, never on the host.
4. **Seam.** A transport is `{ open(onMessage, onClose), send(batch), close(),
   bedrockCipher }`, where a batch is the bytes after RakNet's `0xfe`. `open` resolves
   once batches can be sent. A throw from `onMessage` ends the connection and goes to
   `onClose`; `onClose` is called at most once, and no batch reaches `onMessage` after
   it. `bedrockCipher` is true where both sides encrypt batches after the handshake, as
   over RakNet (finding 8), and false over NetherNet (finding 7); `trace()` starts the
   cipher only where it is true. `encodeBatch` and `decodeBatch` carry no `0xfe` and
   handle compression, encryption and packets only.
   - `tools/bds/raknet.js` holds `Session`, the frame codec and the connection control
     `trace()` holds at 7dca91d: the offline handshake (`0x05` to `0x08`), `0x09`,
     `0x10` and `0x13`, ping `0x00`/`0x03` and `0x15`. It lands first, in its own PR, as
     a pure move with the same behaviour and tests, so `0xfe` stays in the batch codec
     there.
   - `raknet.js` adds `0xfe` on send and strips it on receipt (`tools/bds/raknet.js:121`
     and `:142`), and the batches `tools/bds/test/tracer.test.js:27-33` gives
     `encodeBatch` and `decodeBatch` carry no leading `0xfe`.
   - `tools/bds/nethernet.js` holds the HTTP signalling, the identity, the werift peer,
     segmenting and reassembly. It requires werift inside its factory, so every other
     tool and test loads without the dependency.
   - `trace()` keeps only the game layer: NetworkSettings, login, handshake, resource
     packs, recording, deadline. `--transport nethernet|raknet`, default `nethernet`;
     `run.sh` writes the matching `transport=` key. RakNet stays a supported option.
5. **Identity.** Per run, the tracer signs with the P-384 key `makeKeys()` already makes
   for the login, so the identity's `cpk` and the login's agree: a token `{cpk, iat,
   exp}` with an `x5u` header, plus a detached JWS over `{"fingerprint":[...]}` carrying
   werift's DTLS certificate fingerprint, in go-nethernet's `identity.go` layout. The key
   lives in memory only. No Xbox Live, no stored key. The login's client data carries
   `DeviceOS` 15, Linux (`DEVICE_OS`, `tools/bds/tracer.js:25`), on both transports. The
   reason is NetherNet's alone: over NetherNet BDS 1.26.63.1 refuses 7 on a self-signed
   login (finding 7). The accepted values are BDS's, so each version run re-checks that
   the login is accepted with it.
6. **Framing.** Sends go on `ReliableDataChannel` in 10000-byte segments, below SCTP's
   65536-byte default for an answer without max-message-size. Receives come from both
   channels, and reliable ones are joined by count whatever segment size BDS uses. In
   both directions a message is at most 255 segments, one below the 256 a u8
   remaining-segment count can express; a received message announcing more is an error.
7. **Network shape, mandatory.** This shape replaces the scope ruling's `--network none`
   for the run's container. Every other scope-ruling constraint stands. Fixture tests
   drive `record.js` with a fake `--docker` command, which it already accepts
   (`record.js:11`), and land in the NetherNet PR.
   - **Creation.** Per run, `record.js` creates `riftal_smoke_bds_net_<pid>` with
     `docker network create --internal -o
     com.docker.network.bridge.gateway_mode_ipv4=isolated`, IPv4 only, no `--ipv6`. A
     fixture test asserts these exact `network create` arguments: `--internal`, the
     isolated option, no `--ipv6`, and the name.
   - **Check before start.** `docker network inspect` must show `Internal` true,
     `EnableIPv6` false, the isolated option and an empty IPAM `Gateway`. If the engine
     rejects the option or any of these does not hold, `record.js` removes any network
     it created and exits non-zero without starting a container. There is no fallback
     shape: not the default gateway, the default bridge, `host` or a published port.
     Fixture tests cover each of the four fields failing on its own, and the engine
     rejecting the option; each asserts the network is removed, the exit is non-zero
     and no `docker run` is ever issued.
   - **One container.** Only `riftal_smoke_bds_record_<pid>`, BDS with the tracer, is
     ever on the network: no `-p`, no alias, and no second container joins it. A
     fixture test asserts no `-p` or `--publish`, no alias, no `network connect`, and
     exactly one `run` on the network.
   - **Removal.** On every exit path, success, a non-zero exit, a failed check, a
     timeout and a signal, `record.js` removes the container by name and then the
     network. `--rm` is not enough: `timeout --kill-after` (`record.js:192`) can kill the
     docker CLI while the container runs on, and a network with an attached endpoint
     cannot be removed. Fixture tests assert both removes on success, on a non-zero exit
     and on a timeout.
   - **Strays.** Stranded `riftal_smoke_bds_net_*` networks are reported by name and
     never removed by another run. This engine already carries stranded
     `riftal_smoke_*` networks from other jobs.
   - **Candidates.** The tracer's offer carries one host candidate, the container's own
     non-loopback `eth0` address, read inside the container and never a value passed in
     from the host, plus end-of-candidates. werift runs with no STUN or TURN server, no
     default STUN fallback, and ICE on that one address over UDP and IPv4 only
     (`peerConfig`, `tools/bds/nethernet.js:51`), and the offer is cut to that one
     candidate (`nethernet.js:74-89`). No mDNS option is set; any mDNS candidate in
     BDS's answer is dropped before werift sees it (`nethernet.js:151-152`). Unit tests
     assert the offer carries exactly one host candidate, taken from an injected
     container interface list and from no argument or environment value, with no STUN
     or TURN server, and that the answer's mDNS candidate is dropped
     (`tools/bds/test/nethernet.test.js:37-47` and `:86-99`).
     On the isolated network BDS's answer carries one host candidate on its `eth0`
     (finding 7), and BDS's side is that plus the remote candidates werift learns,
     peer-reflexive from BDS's checks included. P4 reports them.
   - **LAN visibility.** `enable-lan-visibility=false` stays asserted by `run.sh`'s key
     check, which needs no new test.

## Why

- **werift over node-datachannel.** Pure JS on the pinned Node, no native binary built
  elsewhere, which the lockfile test and `run.sh`'s `.node` check hold, no end-of-life
  OpenSSL, and an existing NetherNet client (PrismarineJS) is built on it.
  node-datachannel's speed does not matter in a six-minute run.
- **A lockfile we fetch from, not npm.** npm's lockfile is the standard, reviewable form
  of an integrity pin. Our own fetcher keeps install scripts and registry resolution
  out of the run, and puts the hash check where `record.js` already checks Node.
- **The seam at the batch.** Both transports deliver a whole batch. Below that, RakNet
  and NetherNet share nothing, and above it Bedrock's login, compression and handshake
  are the same, so the game layer is written once. Whether the cipher runs after the
  handshake is the one difference above the seam (finding 7 for NetherNet, finding 8
  for RakNet), and `bedrockCipher` carries it as a flag rather than a second game layer.
- **An internal network, in isolated mode only.** By finding 3, BDS needs one
  non-loopback interface, and an internal network gives it one for the run only. The
  default gateway is why isolated mode is mandatory: the host holds an address on the
  bridge and reached BDS's port (finding 6), which with `online-mode=false` is an
  unauthenticated server on a host interface. In isolated mode the host holds no address
  or route, egress fails and no other container reaches it, so BDS is reachable from
  nothing but its own container, and with no `-p` and no host address it is not a
  publication under riftal-pm#491. It is the steward-accepted shape (6782703312), ICE
  connects over it (finding 7), and the check before start holds it there.
- **One candidate, our own address.** STUN, TURN and mDNS would each send traffic or
  advertise an address beyond the container, and BDS needs none of them on one bridge.
  An address read inside the container cannot be a host address handed in by mistake.
- **Removal by name.** `--rm` depends on the docker CLI surviving to the end, which a
  forced timeout does not guarantee, and stranded networks are already real here.

## Rejected

- **node-datachannel 0.33.6.** End-of-life OpenSSL in a binary we cannot rebuild. The
  replacement, by amending this ADR, if werift cannot complete DTLS or SCTP with BDS.
- **@roamhq/wrtc 0.10.0.** Untested, and a prebuilt native libwebrtc to pin.
- **PrismarineJS nethernet 1.1.2.** Needs Node 24, against item 4's Node 22.
- **Our own DTLS, SCTP and ICE.** Far more code than the tracer, and cryptography for
  one tool.
- **Committing the tarballs or `node_modules` into `tools/`.** 22.3 MB installed of
  third-party code in every clone, outside the scope ruling's cache-only pattern.
- **The internal network with its default gateway.** The host reached BDS's port on it
  (finding 6).
- **`--network none` with a dummy interface.** Works and isolates fully, but costs a
  second image and a `NET_ADMIN` container. It is the replacement only by amending this
  ADR under a steward ruling, if the isolated network's live run cannot connect, and
  then only with `NET_ADMIN` on a short-lived sidecar joined through
  `--network container:`, never on the BDS container, the sidecar's image pinned by
  digest, and the address a `/32` in a range this machine does not route.
- **Host networking, the default bridge, or a published port.** Each gives BDS, with
  `online-mode=false`, a path off the machine or onto a host interface.
- **RakNet only.** Kept as `--transport raknet`, not chosen: the ruling takes NetherNet.

## Consequences

- **The live run** of the NetherNet PR, against BDS before it merges, posts each result
  on the PR in this order, packet names, IDs and lengths only. Any of P1 to P5 failing
  stops the run and brings it back to the steward. First the network:
  - P1. The `docker network inspect` line showing `Internal`, `EnableIPv6`, `Options`
    and the IPAM `Gateway`.
  - P2. On the host, during the run: `ip -o addr show dev br-<first 12 of the network
    id>` prints no `inet` or `inet6` line, `ip route show dev br-...` and
    `ip -6 route show dev br-...` print nothing, and a host TCP connect to
    `<container ip>:19132` fails.
  - P3. Inside the container: the local and remote addresses of every socket in
    `/proc/net/{tcp,tcp6,udp,udp6}` after `Server started.` and again after the session,
    `eth0` at `disable_ipv6=1`, a connection to an outside address failing, and an
    outside name resolving to no address.
  - P4. Every BDS-side candidate the session uses, by type and address class only, for
    example "prflx, container eth0": the remote candidates werift learns, peer-reflexive
    included, plus any BDS trickles. It shows none is loopback or a host address, which
    settles finding 3; beside them the tracer's offer carrying only the `eth0` host
    candidate.
  - P5. After exit, no `riftal_smoke_bds_*` container in `docker ps -a` and no
    `riftal_smoke_bds_net_<pid>` in `docker network ls`, shown after the session and
    again after a run that ends at the timeout.

  Then the packets:
  1. BDS reaches `Server started.`
  2. `GET /v1/join`'s body is logged as returned. The tracer takes the protocol from
     `packages/`, never from it.
  3. The identity offer gets an SDP answer; one more offer with a corrupted signature
     shows whether BDS checks it.
  4. Both named channels open, so werift interoperates with libwebrtc's DTLS and SCTP.
  5. The login, over 10000 bytes, goes in segments and BDS answers it without a
     disconnect, which fixes the segment size BDS accepts.
  6. The first message from BDS is logged by its first byte, and `NetworkSettingsPacket`
     decodes with no `0xfe`.
  7. `ServerToClientHandshakePacket` arrives, and the packets after it decode with
     `bedrockCipher` false.
  8. `capture.bin` holds the eight `WANTED` packets and the tracer exits 0. The capture
     stays in the cache.
- **P3 is emitted by `run.sh` itself**, inside the container, after `Server started.`
  It fails closed: `eth0` with IPv6 on, an outside connect succeeding or an outside name
  resolving stops BDS and exits 1 before the tracer starts (`refuse()`). Its socket
  dumps carry each socket's remote address beside its local one, so a non-local peer
  shows in the run's own output.
- **The tool's comments and tests match this shape.** `tools/bds/record.js:4-8` and
  `tools/bds/run.sh:2` describe a container alone on an isolated network,
  `tools/bds/tracer.js:4-5` a join over NetherNet or over RakNet on 127.0.0.1, and
  `tools/bds/run.sh:43` a BDS that listens with `transport=raknet` while logging that
  only NetherNet takes logins. `tools/bds/test/record.test.js:21-22` asserts the
  container is on `riftal_smoke_bds_net_<pid>` and on no other network.
- **Every version run** fetches the same 11 pinned tarballs into the cache and needs an
  engine with isolated gateway mode; on one without it the run refuses, and the dummy
  interface needs an amendment. Bumping werift is its own PR with a new lockfile and
  this live run again. It re-checks that BDS accepts the login's `DeviceOS` and that
  the batches after `ServerToClientHandshakePacket` decode with `bedrockCipher` false.
- **Revisit** if any of P1 to P5 fails, if BDS gathers a candidate on loopback, which
  returns the run to `--network none`, if a later BDS drops HTTP signalling, or if an
  outside peer shows in a P3 socket dump.

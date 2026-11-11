# 003 NetherNet transport for the BDS tracer

Date: 2026-11-10
Status: accepted
Milestone: M1
Issue: pmmp-updater#3

## Context

ADR 002 sources eight BedrockData tables from packets BDS sends: `StartGamePacket`,
`ItemRegistryPacket`, `CreativeContentPacket`, `CraftingDataPacket`,
`BiomeDefinitionListPacket`, `AvailableActorIdentifiersPacket`,
`JigsawStructureDataPacket`, `VoxelShapesPacket` (`WANTED`, `tools/bds/tracer.js:25`).
`tracer.js` speaks RakNet only, and `run.sh` forces `transport=raknet`, which BDS accepts
while warning that logins need NetherNet. The steward's ruling on #3 (issuecomment
6763815334) item 2 takes the tables over NetherNet, built inside #3, behind this ADR: it
is the first outside runtime dependency in `tools/`, and every later version run
inherits it. The ADR pins the library and its licence, fetches it into the cache
hash-verified before the run, and keeps RakNet as an option. Item 4 keeps the
container's own checksum-pinned Node 22 on the pinned `ubuntu:24.04` (hard rule 7). The
scope ruling (6761625992) sets a throwaway `riftal_smoke_` container, `--rm`, `timeout`,
`-m`, `--cpus`, `--network none`, no published port, BDS from the read-only cache, and
nothing from Mojang committed. The steward's ruling on this ADR (issuecomment
6782703312) accepts decision 7's network shape in place of `--network none`, and sets
its conditions and the live run's proofs; with this ADR merged, it is the acceptance.

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
2. **Signalling is plain HTTP on TCP `server-port`.** In the spike, `GET /v1/join` gave
   name, protocol 2225 and version. In the steward's reproduction a plain `GET /v1/join`
   returned an empty JSON body, so that part did not reproduce. `POST /v1/join/1` takes
   an SDP offer: without `a=identity` it answers `37` (identity not allowed), which did
   reproduce; with a self-signed ES384 identity it answers `application/sdp` with
   setup:active, sctp-port 5000, ice trickle, no `a=candidate`, no max-message-size. No
   Xbox Live is needed under `online-mode=false`.
3. **Blocker, unverified.** Under `--network none` ICE never connected: with loopback its
   only interface, BDS gathered no candidate and opened no UDP socket, whatever
   `server-ip` and `server-udp-ports` said. The live run's P4 proves or refutes it.
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

Unknown: whether BDS gathers a candidate on the isolated network, whether it checks the
identity, werift against libwebrtc's DTLS and SCTP, the segment size BDS accepts, the
absence of `0xfe`, whether Bedrock encryption runs over NetherNet, and which request, if
any, returns name, protocol and version.

## Decision

1. **Library: werift 0.27.0**, integrity
   `sha512-JgFfqVXZ4s3A+VE2DxMo5QympNAnravCuQdNqQeBiKIrojtpjghYahgnl5Vc+sh0Porsx/LHODNMdZKM/JbksA==`.
   Licence MIT, confirmed on the registry, with mediabunny MPL-2.0 used unmodified and
   never redistributed.
2. **Pinning.** `tools/bds/package.json` is `private: true` with no `type` and no
   `scripts`, and declares exactly `werift: 0.27.0`. `tools/bds/package-lock.json` (npm
   lockfile v3, made with `--package-lock-only --ignore-scripts`) pins all 11 packages by
   `resolved` URL and sha512 `integrity`. A test fails on any `resolved` off
   `https://registry.npmjs.org/`, any entry without sha512, any install script, or any
   licence outside MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 and MPL-2.0. No
   tarball and no `node_modules` is committed, and nothing is unpacked into the tree, so
   `.gitignore` carries no entry for them.
3. **Fetch.** `record.js` downloads each locked tarball into `<cache>/npm/`, checks its
   sha512 and renames it into place only on a match, re-checking cached files on every
   run, as `nodeTarball` does. It never requires or unpacks them. `run.sh` takes
   `<cache>/npm` read-only, checks every hash again, unpacks with `tar` into its
   `mktemp -d` tree at the lockfile's paths, and runs the tracer with `NODE_PATH` there.
   No npm and no install script runs, so the dependency executes only inside the
   throwaway container, never on the host.
4. **Seam.** A transport is `{ open(onMessage, onClose), send(batch), close() }`, where a
   batch is the bytes after RakNet's `0xfe`. `encodeBatch` and `decodeBatch` carry no
   `0xfe` and handle compression, encryption and packets only.
   - `tools/bds/raknet.js` holds `Session`, the frame codec, `0xfe` and the connection
     control `trace()` holds at 7dca91d: the offline handshake (`0x05` to `0x08`),
     `0x09`, `0x10` and `0x13`, ping `0x00`/`0x03` and `0x15`. It lands first, in its own
     PR, with the same behaviour and tests.
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
   lives in memory only. No Xbox Live, no stored key.
6. **Framing.** Sends go on `ReliableDataChannel` in 10000-byte segments, below SCTP's
   65536-byte default for an answer without max-message-size. Receives come from both
   channels, and reliable ones are joined by count whatever segment size BDS uses. In
   both directions a message is at most 255 segments, one below the 256 a u8
   remaining-segment count can express; a received message announcing more is an error.
7. **Network shape, mandatory.** This shape replaces the scope ruling's `--network none`
   for the run's container. Every other scope-ruling constraint stands.
   - **Creation.** Per run, `record.js` creates `riftal_smoke_bds_net_<pid>` with
     `docker network create --internal -o
     com.docker.network.bridge.gateway_mode_ipv4=isolated`, IPv4 only, no `--ipv6`.
   - **Check before start.** `docker network inspect` must show `Internal` true,
     `EnableIPv6` false, the isolated option and an empty IPAM `Gateway`. If the engine
     rejects the option or any of these does not hold, `record.js` removes any network
     it created and exits non-zero without starting a container. There is no fallback
     shape: not the default gateway, the default bridge, `host` or a published port.
   - **One container.** Only `riftal_smoke_bds_record_<pid>`, BDS with the tracer, is
     ever on the network: no `-p`, no alias, and no second container joins it.
   - **Removal.** On every exit path, success, a non-zero exit, a failed check, a
     timeout and a signal, `record.js` removes the container by name and then the
     network. `--rm` is not enough: `timeout --kill-after` (`record.js:78`) can kill the
     docker CLI while the container runs on, and a network with an attached endpoint
     cannot be removed. Fixture tests assert both removes on success, on a non-zero exit
     and on a timeout.
   - **Strays.** Stranded `riftal_smoke_bds_net_*` networks are reported by name and
     never removed by another run. This engine already carries stranded
     `riftal_smoke_*` networks from other jobs.
   - **Candidates.** The tracer's offer carries one host candidate, the container's own
     non-loopback `eth0` address, read inside the container and never a value passed in
     from the host, plus end-of-candidates. werift runs with no STUN or TURN server and
     mDNS off, so it offers no other candidate. BDS's checks reach the tracer as
     peer-reflexive, so BDS's own candidates need no further signalling.
   - **LAN visibility.** `enable-lan-visibility=false` stays asserted by `run.sh`'s key
     check.

## Why

- **werift over node-datachannel.** Pure JS on the pinned Node, no native binary built
  elsewhere, no end-of-life OpenSSL, and an existing NetherNet client (PrismarineJS) is
  built on it. node-datachannel's speed does not matter in a six-minute run.
- **A lockfile we fetch from, not npm.** npm's lockfile is the standard, reviewable form
  of an integrity pin. Our own fetcher keeps install scripts and registry resolution
  out of the run, and puts the hash check where `record.js` already checks Node.
- **The seam at the batch.** Both transports deliver a whole batch. Below that, RakNet
  and NetherNet share nothing, and above it, Bedrock's login, compression and encryption
  are the same, so the game layer is written once.
- **An internal network, in isolated mode only.** If finding 3 holds, BDS needs one
  non-loopback interface, and an internal network gives it one for the run only. The
  default gateway is why isolated mode is mandatory: the host holds an address on the
  bridge and reached BDS's port (finding 6), which with `online-mode=false` is an
  unauthenticated server on a host interface. In isolated mode the host holds no address
  or route, egress fails and no other container reaches it, so BDS is reachable from
  nothing but its own container, and with no `-p` and no host address it is not a
  publication under riftal-pm#491. It is the steward-accepted shape (6782703312) but
  untested against BDS's ICE, so the check before start and the live run hold it there.
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
  - P3. Inside the container: the local sockets of `/proc/net/{tcp,tcp6,udp,udp6}`
    after `Server started.` and again after the session, `eth0` at `disable_ipv6=1`, a
    connection to an outside address failing, and an outside name resolving to no
    address.
  - P4. BDS's own trickled ICE candidates, by type and address class only, for example
    "host, container eth0", showing none is loopback or a host address, which settles
    finding 3; beside them the tracer's offer carrying only the `eth0` host candidate.
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
  7. The capture shows whether `ServerToClientHandshakePacket` arrived, and so whether
     encryption runs over NetherNet.
  8. `capture.bin` holds the eight `WANTED` packets and the tracer exits 0. The capture
     stays in the cache.
- **The NetherNet PR** corrects the comments that describe a loopback-only container
  joined on 127.0.0.1 over RakNet, at `tools/bds/record.js:4-7`, `tools/bds/run.sh:2`
  and `tools/bds/tracer.js:4-5`, and the RakNet-only comment at `tools/bds/run.sh:17-19`.
- **Every version run** fetches the same 11 pinned tarballs into the cache and needs an
  engine with isolated gateway mode; on one without it the run refuses, and the dummy
  interface needs an amendment. Bumping werift is its own PR with a new lockfile and
  this live run again.
- **Revisit** if any of P1 to P5 fails, if BDS gathers a candidate on loopback, which
  returns the run to `--network none`, or if a later BDS drops HTTP signalling.

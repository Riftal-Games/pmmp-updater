#!/usr/bin/env bash
# Runs inside the container tools/bds/record.js starts, alone on an isolated network.
# Usage: run.sh <bds zip> <node tarball> <node sha256> <nethernet|raknet>
# Checks and unpacks the pinned Node from the read-only /node mount with the container's
# own tools, unpacks BDS from the read-only cache onto the container's disk with it,
# starts BDS offline on the given transport and runs tracer.js against it on the same one.
set -euo pipefail

# Node looks in these before NODE_PATH, so a package installed there would be loaded in
# place of the hash-checked one.
for d in /tool/node_modules /node_modules; do
	if [ -e "$d" ]; then
		echo "$d exists, and would be loaded before the locked packages" >&2
		exit 1
	fi
done

cd "$(mktemp -d)"
echo "$3  /node/$2" | sha256sum --check --quiet
mkdir node bds deps
tar -xzf "/node/$2" -C node --strip-components=1
node=$PWD/node/bin/node

# The locked packages are checked again here and unpacked at their lockfile paths. No npm
# and no install script runs, and no native addon is accepted: it is a binary built
# elsewhere, which we can neither review nor rebuild.
"$node" -e 'for (const [k, e] of Object.entries(require(process.argv[1]).packages)) if (k) console.log(Buffer.from(e.integrity.slice(7), "base64").toString("hex"), k)' /tool/package-lock.json |
	while read -r hex dir; do
		echo "$hex  /npm/$hex.tgz" | sha512sum --check --quiet
		mkdir -p "deps/$dir"
		tar -xzf "/npm/$hex.tgz" -C "deps/$dir" --strip-components=1
	done
if find deps -name '*.node' | grep .; then
	echo "a native .node file is in the locked packages" >&2
	exit 1
fi
"$node" -e 'const l = require(process.argv[1]).packages; const ks = Object.keys(l).filter(Boolean); for (const k of ks) if (require(`${process.cwd()}/deps/${k}/package.json`).version !== l[k].version) throw new Error(`${k} is not ${l[k].version}`); console.error(`unpacked ${ks.length} locked packages`)' /tool/package-lock.json
export NODE_PATH=$PWD/deps/node_modules

"$node" /tool/unzip.js "/bds/$1" bds
cd bds

# BDS still listens with transport=raknet, though it logs that only NetherNet takes logins.
# A key Mojang renames would otherwise leave its default in place, online mode included.
# Hashed block network IDs name a state with no palette of BDS's, which decode.js needs.
for kv in online-mode=false allow-list=false "transport=$4" enable-lan-visibility=false block-network-ids-are-hashes=true; do
	sed -i "s/^${kv%%=*}=.*/$kv/" server.properties
	grep -qx "$kv" server.properties || { echo "server.properties has no ${kv%%=*} key" >&2; exit 1; }
done

sockets() {
	echo "== sockets $1" >&2
	awk 'FNR > 1 { print FILENAME, $2, $3, $4 }' /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6 >&2
}

LD_LIBRARY_PATH=. ./bedrock_server </dev/null >bds.log 2>&1 &
if ! timeout 180 bash -c 'until grep -q "Server started" bds.log; do sleep 1; done'; then
	cat bds.log >&2
	exit 1
fi
sockets "after Server started"
# The rest of ADR 003's P3. Any way off the network stops BDS, job 1, before the session.
refuse() { echo "== $1, so no session" >&2; kill %1; exit 1; }
grep -qx 1 /proc/sys/net/ipv6/conf/eth0/disable_ipv6 && echo "== eth0 disable_ipv6=1" >&2 || refuse "eth0 has IPv6"
! timeout 5 bash -c ': >/dev/tcp/1.1.1.1/443' && echo "== a TCP connect to 1.1.1.1:443 failed" >&2 || refuse "a TCP connect to 1.1.1.1:443 succeeded"
! timeout 10 getent ahosts example.com >&2 && echo "== example.com resolves to no address" >&2 || refuse "example.com resolves"

status=0
timeout 120 "$node" /tool/tracer.js --protocol-info /proto/protocol_info.json --out /out --transport "$4" || status=$?
sockets "after the session"
echo "== bds.log" >&2
cat bds.log >&2
exit "$status"

#!/usr/bin/env bash
# Runs inside the container tools/bds/record.js starts, whose only network is loopback.
# Usage: run.sh <bds zip> <node tarball> <node sha256>
# Checks and unpacks the pinned Node from the read-only /node mount with the container's
# own tools, unpacks BDS from the read-only cache onto the container's disk with it,
# starts BDS offline and runs tracer.js against it on 127.0.0.1.
set -euo pipefail

cd "$(mktemp -d)"
echo "$3  /node/$2" | sha256sum --check --quiet
mkdir node bds
tar -xzf "/node/$2" -C node --strip-components=1
node=$PWD/node/bin/node
"$node" /tool/unzip.js "/bds/$1" bds
cd bds

# The tracer speaks RakNet only, and BDS still listens on it with transport=raknet, though
# it warns that logins need NetherNet. A key Mojang renames would otherwise leave its
# default in place, online mode included.
for kv in online-mode=false allow-list=false transport=raknet enable-lan-visibility=false; do
	sed -i "s/^${kv%%=*}=.*/$kv/" server.properties
	grep -qx "$kv" server.properties || { echo "server.properties has no ${kv%%=*} key" >&2; exit 1; }
done

LD_LIBRARY_PATH=. ./bedrock_server </dev/null >bds.log 2>&1 &
if ! timeout 180 bash -c 'until grep -q "Server started" bds.log; do sleep 1; done'; then
	cat bds.log >&2
	exit 1
fi

status=0
timeout 120 "$node" /tool/tracer.js --protocol-info /proto/protocol_info.json --out /out || status=$?
echo "== bds.log" >&2
cat bds.log >&2
exit "$status"

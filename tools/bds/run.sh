#!/usr/bin/env bash
# Runs inside the container tools/bds/record.js starts, whose only network is loopback.
# Unpacks BDS from the read-only cache onto the container's own disk, starts it offline
# on RakNet, and runs tracer.js against it on 127.0.0.1.
set -euo pipefail

host=(/opt/host/lib/ld-linux-x86-64.so.2 --library-path /opt/host/lib)
cd "$(mktemp -d)"
"${host[@]}" /opt/host/unzip -q "/bds/$1"

# A key Mojang renames would otherwise leave its default in place, online mode included.
for kv in online-mode=false allow-list=false transport=raknet enable-lan-visibility=false; do
	sed -i "s/^${kv%%=*}=.*/$kv/" server.properties
	grep -qx "$kv" server.properties || { echo "server.properties has no ${kv%%=*} key" >&2; exit 1; }
done

LD_LIBRARY_PATH=. ./bedrock_server </dev/null >bds.log 2>&1 &
if ! timeout 180 bash -c 'until grep -q "Server started" bds.log; do sleep 1; done'; then
	cat bds.log >&2
	exit 1
fi
grep -m1 -o 'Version: .*' bds.log

status=0
timeout 120 "${host[@]}" /opt/host/node /tool/tracer.js --protocol-info /proto/protocol_info.json --out /out || status=$?
if [ "$status" -ne 0 ]; then tail -n 20 bds.log >&2; fi
exit "$status"

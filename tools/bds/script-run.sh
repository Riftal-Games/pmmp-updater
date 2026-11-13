#!/usr/bin/env bash
# Runs inside the container tools/bds/script.js starts, with no network. Unpacks Node and
# BDS as run.sh does, loads script-pack into a fresh level and copies its log lines to
# /out/states.log once it reports done.
# Usage: script-run.sh <bds zip> <node tarball> <node sha256>
set -euo pipefail

cd "$(mktemp -d)"
echo "$3  /node/$2" | sha256sum --check --quiet
mkdir node bds
tar -xzf "/node/$2" -C node --strip-components=1
node/bin/node /tool/unzip.js "/bds/$1" bds
cd bds

for kv in online-mode=false allow-list=false enable-lan-visibility=false level-name=riftal_states content-log-console-output-enabled=true; do
	sed -i "s/^${kv%%=*}=.*/$kv/" server.properties
	grep -qx "$kv" server.properties || { echo "server.properties has no ${kv%%=*} key" >&2; exit 1; }
done

cp -r /tool/script-pack behavior_packs/riftal_states
mkdir -p worlds/riftal_states
../node/bin/node -e 'const h = require(process.argv[1]).header; console.log(JSON.stringify([{ pack_id: h.uuid, version: h.version }]))' /tool/script-pack/manifest.json >worlds/riftal_states/world_behavior_packs.json

LD_LIBRARY_PATH=. ./bedrock_server </dev/null >bds.log 2>&1 &
pid=$!
status=0
timeout 240 bash -c 'until grep -qE "RIFTAL_(DONE|ERROR)" bds.log; do kill -0 "$1" 2>/dev/null || exit 1; sleep 1; done' _ "$pid" || status=$?
kill "$pid" 2>/dev/null || true
wait || true
grep -a 'RIFTAL_' bds.log >/out/states.log || true
echo "== bds.log without RIFTAL_STATE lines" >&2
grep -av 'RIFTAL_STATE' bds.log >&2 || true
exit "$status"

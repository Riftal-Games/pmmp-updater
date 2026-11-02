#!/usr/bin/env bash
# Runs inside the pinned ubuntu:24.04 container that tools/bds/inspect.js starts. Reads
# the BDS zip from the read-only /bds mount and reports whether bedrock_server carries
# symbols. It never runs the server.
set -euo pipefail

zip="/bds/$1"
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends file binutils unzip >/dev/null

echo "== zip: $1"
unzip -l "$zip" | tail -n 1
echo "== top-level entries"
unzip -Z1 "$zip" | grep -v '/.' | sort
echo "== debug or symbol files in the zip"
unzip -Z1 "$zip" | grep -Ei '(\.debug|\.sym|\.dbg|\.pdb|symbols)' || echo "none"

work=$(mktemp -d)
unzip -q "$zip" bedrock_server -d "$work"
bin="$work/bedrock_server"

echo "== file"
file "$bin"
echo "== size"
stat -c '%s bytes' "$bin"
echo "== section headers named symtab, debug or debuglink"
readelf -S -W "$bin" | grep -E '\.(symtab|strtab|dynsym|debug_[a-z_]+|gnu_debuglink|gnu_debugdata)\b' || echo "none"
echo "== gnu_debuglink target"
readelf --string-dump=.gnu_debuglink "$bin" 2>&1 | sed -n 's/^ *\[ *0\] *//p' | grep . || echo "none"
echo "== build id"
readelf -n "$bin" | grep -i 'build id' || echo "none"
echo "== dynamic symbols, all"
nm -D "$bin" | wc -l
echo "== dynamic symbols, defined"
nm -D --defined-only "$bin" | wc -l
echo "== static symbols"
nm "$bin" 2>&1 | wc -l
nm "$bin" 2>&1 | head -n 1
echo "== DWARF debug info, first lines"
readelf --debug-dump=info "$bin" 2>&1 | head -n 5

# A stripped binary has no .symtab, so the demangled counts come from whichever table
# is present: the static one when it exists, the dynamic one otherwise.
if readelf -S -W "$bin" | grep -q '\.symtab'; then
	table="static"
	nm -C "$bin" >"$work/names"
else
	table="dynamic"
	nm -D -C --defined-only "$bin" >"$work/names"
fi
echo "== demangled names from the $table table"
for pattern in 'Packet::read' 'Packet::write' 'SharedConstants' 'MinecraftPackets::createPacket' 'StartGamePacket' 'CraftingDataPacket' 'CreativeContentPacket'; do
	printf '%s\t%s\n' "$pattern" "$(grep -cF "$pattern" "$work/names" || true)"
done
echo "== sample Packet::write names"
grep -F 'Packet::write' "$work/names" | head -n 5 || true

# Itanium RTTI keeps a class's mangled name, such as 15StartGamePacket, as a string even
# in a stripped binary. These are what a symbol-less route can anchor on.
strings -n 6 "$bin" >"$work/strings"
echo "== RTTI type names ending in Packet"
grep -cE '^[0-9]+[A-Za-z]+Packet$' "$work/strings" || true
echo "== sample RTTI type names"
grep -E '^[0-9]+(StartGame|CraftingData|CreativeContent|Text)Packet$' "$work/strings" | sort -u || true

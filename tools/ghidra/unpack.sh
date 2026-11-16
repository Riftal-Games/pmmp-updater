#!/usr/bin/env bash
# Usage: unpack.sh <node tarball> <node sha256> <jdk tarball> <jdk sha256> <ghidra zip> <ghidra sha256>
# Runs in analyze.js's unpack container, which has no network, and unpacks the three pinned
# archives into staging/, the image's build context. Paths are relative to the working
# directory, / in the container, so a test can run it on a fixture tree.
set -euo pipefail

refuse() { echo "unpack: $1" >&2; exit 1; }

printf '%s  %s\n' "$2" "node/$1" "$4" "dist/$3" "$6" "dist/$5" | sha256sum --check
mkdir staging/node staging/jdk staging/zip
tar -xzf "node/$1" -C staging/node --strip-components=1
tar -xzf "dist/$3" -C staging/jdk --strip-components=1

# unzip.js reads the 16-bit entry count and finds zip64 only by size and offset, so a zip
# at that ceiling could extract partly with no error.
out=$(staging/node/bin/node bdstool/unzip.js "dist/$5" staging/zip)
echo "$out"
read -r _ count _ <<<"$out"
[[ $count =~ ^[0-9]+$ ]] && ((count < 65535)) || refuse "$count entries, at or over the 16-bit ceiling"
top=(staging/zip/*)
[ ${#top[@]} -eq 1 ] && [ -d "${top[0]}" ] || refuse "the Ghidra zip has no single top directory"
mv "${top[0]}" staging/ghidra
rmdir staging/zip

# unzip.js gives a file 0644 when its zip entry carries no Unix mode.
for f in support/analyzeHeadless Ghidra/Features/Decompiler/os/linux_x86_64/decompile; do
	[ -f "staging/ghidra/$f" ] && [ ! -L "staging/ghidra/$f" ] || refuse "$f is not a regular file"
	((8#$(stat -c %a "staging/ghidra/$f") & 8#100)) || refuse "$f has no owner exec bit"
	echo "$f $(stat -c %A "staging/ghidra/$f")"
done

# The heap is analyze.js's GHIDRA_HEADLESS_MAXMEM only while 12.1.4's line 17, at the start
# of its line, is the one assignment of it, and line 43 passes it to launch.sh as -Xmx.
h=staging/ghidra/support/analyzeHeadless
n=$(awk '!/^[ \t]*#/ { s = " " $0; n += gsub(/[^A-Za-z0-9_]GHIDRA_HEADLESS_MAXMEM=/, "", s) } END { print n + 0 }' "$h")
((n == 1)) && grep -qE '^GHIDRA_HEADLESS_MAXMEM=\$\{GHIDRA_HEADLESS_MAXMEM:=' "$h" || refuse "$h assigns GHIDRA_HEADLESS_MAXMEM $n times, not once in line 17's form"
grep -qE '^[^#]*launch\.sh([[:space:]]+[^[:space:]]+){3}[[:space:]]+"\$\{GHIDRA_HEADLESS_MAXMEM\}"([[:space:]]|$)' "$h" || refuse "$h passes no \"\${GHIDRA_HEADLESS_MAXMEM}\" as launch.sh's fourth word"
echo "support/analyzeHeadless keeps an outside GHIDRA_HEADLESS_MAXMEM and passes it to launch.sh"

#!/usr/bin/env bash
# Runs inside the unpack container tools/ghidra/analyze.js starts, with no network.
# Usage: unpack.sh <node tarball> <node sha256> <jdk tarball> <jdk sha256> <ghidra zip> <ghidra sha256>
# Checks the three pinned archives and unpacks them into staging/, the context the image
# is built from. Paths are relative to the working directory, / in the container, so a
# test can run it on a fixture tree.
set -euo pipefail

refuse() { echo "unpack: $1" >&2; exit 1; }

echo "$2  node/$1" | sha256sum --check
echo "$4  dist/$3" | sha256sum --check
echo "$6  dist/$5" | sha256sum --check
mkdir staging/node staging/jdk staging/zip
tar -xzf "node/$1" -C staging/node --strip-components=1
tar -xzf "dist/$3" -C staging/jdk --strip-components=1

# unzip.js reads the 16-bit entry count and finds zip64 only by size and offset, so a zip
# at that ceiling could extract partly with no error.
out=$(staging/node/bin/node bdstool/unzip.js "dist/$5" staging/zip)
echo "$out"
count=${out#unzipped }
count=${count%% *}
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

# A MAXMEM= the launcher sets itself would override the MAXMEM analyze.js passes.
! grep -nE '^[[:space:]]*MAXMEM=' staging/ghidra/support/analyzeHeadless || refuse "support/analyzeHeadless sets MAXMEM itself"
echo "support/analyzeHeadless has no uncommented MAXMEM= line"

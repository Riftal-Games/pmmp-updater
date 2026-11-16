# 001 Linux BDS ships no symbols, so data extraction is packet-based

Date: 2026-11-03
Status: accepted
Milestone: M1
Issue: pmmp-updater#3

## Context

The BDS container in #3 needs BedrockData's dumps (block palette, item table, creative
inventory, recipes) from each new Bedrock Dedicated Server. Issue #3 plans a fork of
pmmp's archived bds-modding-devkit (`protocol_info_dumper.py`, the mapping mod,
`tracer.py`) and says the data dump, `tracer.py` and the Ghidra pre-analysis in #5 all
depend on whether the Linux BDS zip still ships `bedrock_server_symbols.debug` or an
equivalent. This spike answers that first.

## Finding

Checked 2026-11-03 against both Linux builds the links API offered that day:

| Channel | Build | Zip bytes | `bedrock_server` bytes | Build ID |
|---|---|---|---|---|
| release | 1.26.61.1 | 98,093,051 | 265,500,488 | `68148a98bff8debfbed5574fb9a2c51c7f841adb` |
| preview | 1.26.70.22 | 101,494,898 | 276,717,224 | `9143a5d29c95e2fe41e624c175e2373c4b9a66bc` |

Reproduce with `node tools/bds/inspect.js --channel release|preview`, run where docker
is local (on Nasir's PC, `wsl -d Ubuntu-26.04 -u runner --exec node .../tools/bds/inspect.js`).
It downloads into `~/.cache/pmmp-updater/bds` and runs `tools/bds/probe.sh` in
`ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac`.
Both builds gave the same answer on every check.

1. **No separate symbols download.** `GET .../api/v1.0/download/links` returns five
   entries: `serverBedrockWindows`, `serverBedrockLinux`, `serverBedrockPreviewWindows`,
   `serverBedrockPreviewLinux`, `serverJar`. None is a symbols file.
2. **No symbols file in the zip.** `unzip -l` reports 4103 files (release) and 4118
   (preview). The top level is `bedrock_server`, `bedrock_server_how_to.html`,
   `behavior_packs/`, `config/`, `data/`, `definitions/`, `resource_packs/` and the
   config files. `unzip -Z1 | grep -Ei '(\.debug|\.sym|\.dbg|\.pdb|symbols)'` matches
   nothing.
3. **The binary is stripped.** `file`:
   `ELF 64-bit LSB pie executable, x86-64, ... dynamically linked, ... for GNU/Linux 3.2.0, BuildID[sha1]=68148a98..., stripped`.
4. **No static symbol table and no DWARF.** `readelf -S -W` lists no `.symtab`, `.strtab`
   or `.debug_*` section; the only symbol table is `.dynsym`. `nm` prints
   `bedrock_server: no symbols`. `readelf --debug-dump=info` prints nothing.
5. **The dynamic table is imports only.** `nm -D | wc -l` is 389 (release) and 394
   (preview); `nm -D --defined-only | wc -l` is 0 for both.
6. **The debug file exists at Mojang but is not shipped.** A `.gnu_debuglink` section
   names `bedrock_server.debug`, which is neither in the zip nor in the links API.
7. **No packet names to hook.** Demangled counts in the only table present are 0 for
   `Packet::read`, `Packet::write`, `SharedConstants`, `MinecraftPackets::createPacket`,
   `StartGamePacket`, `CraftingDataPacket` and `CreativeContentPacket`.
8. **RTTI survives.** `strings -n 6` finds 239 (release) and 240 (preview) Itanium RTTI
   type names ending in `Packet`, among them `15StartGamePacket`, `18CraftingDataPacket`,
   `21CreativeContentPacket` and `10TextPacket`.

The answer to #3's question: no. Linux BDS 1.26.61.1 and 1.26.70.22 ship no usable
symbols, in the zip or beside it.

## Decision

#3 takes the packet-based route. BDS runs headless in the container on 127.0.0.1, a
client session against it is recorded by a tracer that sits between client and server,
and the data is read from what BDS sends: `ItemRegistryPacket` for the item table,
`StartGamePacket` for the data-driven blocks, `CreativeContentPacket` for the creative
inventory, `CraftingDataPacket` for recipes. No part of #3 depends on a BDS function name.
Any bds-modding-devkit part that hooks BDS functions by name is not forked.

The vanilla block palette is not on the wire. `StartGamePacket::$blockPalette` carries
only the data-driven entries, which pmmp-core fills from `DATA_DRIVEN_BLOCKS_NBT`
(`src/network/mcpe/cache/StaticPacketCache.php:173`, sent at
`src/network/mcpe/handler/PreSpawnPacketHandler.php:125`), and `blockPaletteChecksum` is a
hash. A capture therefore gives `data_driven_blocks.nbt`, never
`canonical_block_states.nbt`. ADR 002 names the source of each BedrockData file.

## Why

Every symbol route needs names the binary does not carry. The debuglink shows the build
splits its debug info into a separate `bedrock_server.debug` that is not published, and
the release and preview builds agree, so the next build should not be expected to
differ. The packets are the data a real client receives, so they cannot drift from what
the server speaks, and reading them needs no per-build offsets.

## Rejected

- **Symbol-based mapping mod and tracer.** Nothing to hook: zero defined dynamic symbols
  and no `.symtab`.
- **Hooking by hand-found offsets.** Offsets move with every build, and finding them
  again is the per-version work #3 exists to remove.
- **The Windows BDS zip.** Not checked in this spike, and it would put the extraction
  outside the `ubuntu:24.04` container rule. Revisit only if the packet route cannot
  reach some table.

## Consequences

- **#3, next PR:** the BDS image, a headless loopback-only run, and a tracer for a client
  session. Packets carrying the data must be decoded by our own protocol package for
  that version, so the order is: Mojang docs and codegen first, then BDS for the data.
- **#5, Ghidra:** pre-analysis starts with no function names. The RTTI type names in
  finding 8 locate each packet class's typeinfo and from it the vtable, so `read` and
  `write` are reached by vtable slot rather than by name. Whether Ghidra's analysis does
  that unaided on this binary is for #5 to establish; budget for naming by hand.
  ADR 004's import runs with `-noanalysis`, so this budget does not hold as written;
  pmmp-updater#56 settles what replaces it.
- **Cache:** each build costs about 100 MB of zip in the cache. The binary is extracted
  only inside the throwaway container. Neither is committed.
  ADR 004 item 6 amends this: a Ghidra project per Build ID, holding the binary's
  bytes, persists in the cache.
- **Revisit** if a links API entry or a zip ever carries `bedrock_server.debug`.
  `tools/bds/probe.sh` lists any such file in the zip on the next run.

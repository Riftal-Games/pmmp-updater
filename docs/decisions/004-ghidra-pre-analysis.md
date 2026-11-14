# 004 Ghidra pre-analysis of Linux BDS in a throwaway container

Date: 2026-11-14
Status: accepted 2026-11-14, architect under the standing ADR delegation, within the
steward's ruling on #5 (issuecomment 6766225363)
Milestone: M1
Issue: pmmp-updater#5

## Context

ADR 002 leaves five BedrockData files with the source "neither. #5", and ADR 001's
Consequences send #5 into a stripped binary with no function names, where only the
Itanium RTTI names of 239 to 240 `*Packet` classes survive (ADR 001 finding 8). The
steward's ruling on #5 (issuecomment 6766225363) sets the route: Ghidra headless in a
throwaway container, one saved project per BDS build, packet classes found through RTTI
and vtables by a post-script, a `packet-re` skill on top, no REA and no Frida. This ADR
settles, within that ruling, the details an implementer would otherwise guess. It does
not reopen the ruling.

The ruling asks for `-m` and `--cpus` limits and names no values. This PC caps a server
or a build at 2G and 2 CPUs and any other one-shot container at 1G and 1 CPU (riftal-pm
`devtools/container-limits.js:2-4`), and the tree's own BDS runs stay inside it
(`record.js:95`, `inspect.js:57`). This ADR grants no exception to that cap. Fitting a
265 to 277 MB stripped binary inside it is the design problem item 4 settles.

ADR 001 budgets naming `read` and `write` by hand on top of Ghidra's analysis. Item 4
imports with no analysis, so that budget does not hold here. Item 8 replaces it with a
committed rule over facts the import does give, which refuses a build it cannot settle.

## Decision

1. **No REA in the loop.** Ghidra runs only as `analyzeHeadless` inside the containers
   below. A Ghidra install on the host is not a dependency, and no tool or skill calls
   one.
2. **Pins live in the tool, archives in the cache.** `tools/ghidra/analyze.js` holds
   `JDK` and `GHIDRA` constants in the shape of `NODE` in `tools/bds/record.js:28`
   (`file`, `url`, `sha256`), and takes `NODE` from `record.js` rather than a second pin.
   - JDK: one exact Eclipse Temurin 21 release, Linux x64 JDK `.tar.gz`, its SHA-256 from
     Adoptium's published `.sha256.txt` for that asset. Ghidra's install guide names
     Temurin. A JDK, not a JRE, because Ghidra compiles Java scripts at run time.
   - Ghidra 12.1.4, the release zip, its SHA-256 from the release's published notes.
   - Both are fetched by `pinnedFile` (`record.js:42`), which the image PR adds to
     `record.js`'s exports (`record.js:223`) rather than copying, into
     `<cache>/ghidra/dist/<file>`, where `<cache>` is the BDS cache `inspect.parseArgs`
     defaults to (`~/.cache/pmmp-updater/bds`), so the Node tarball stays at
     `<cache>/node/`. A cached file is re-checked on every run.
   - The PR that adds a pin names the page each hash was read from.
3. **The image.** Everything that runs code to make it runs under the cap; the
   `docker build` itself only copies.
   - The tool checks with `docker image inspect` that the `inspect.IMAGE` digest
     (`tools/bds/inspect.js:22`) is present and refuses otherwise, so nothing pulls.
   - Unpacking is a container, `riftal_smoke_ghidra_unpack_<pid>`, under item 4's flags.
     Read-only mounts: `<cache>/ghidra/dist:/dist`, `<cache>/node:/node`,
     `tools/bds:/bdstool`, `tools/ghidra:/tool`. The one writable mount is a fresh
     `<cache>/ghidra/staging/<pid>:/staging`. `tools/ghidra/unpack.sh` checks each
     archive with `sha256sum --check` against the constants, as `run.sh:19` does, untars
     Node and the JDK into `/staging`, and unzips Ghidra there with the pinned Node and
     `tools/bds/unzip.js`, which keeps file modes and refuses zip64 and symlinks. It
     reads the whole zip into memory (`unzip.js:58`), which is why it runs here and not
     in a build step.
   - `unpack.sh` then fails unless all of these hold. The entry count `unzip.js` prints
     is below 65535: it reads the 16-bit count (`unzip.js:18`) and detects zip64 only by
     size and offset (`:24`), so a zip at that ceiling could extract partly with no
     refusal. `support/analyzeHeadless` and
     `Ghidra/Features/Decompiler/os/linux_x86_64/decompile` are regular files with the
     owner exec bit, because a zip without Unix modes falls back to `0o644`
     (`unzip.js:49`). `support/analyzeHeadless` has no uncommented `MAXMEM=` line, so
     item 4's environment value is the one used.
   - `docker build --network none --iidfile` with the staging directory as context and a
     `Dockerfile` `FROM` the digest holding only `COPY` and `ENV`, so no build step runs
     code and none needs a limit. The image carries Node, the JDK and Ghidra. The
     staging directory is removed on every exit.
   - Tagged `riftal_smoke_ghidra:12.1.4` for the build cache only, run by the ID in the
     iidfile, never pushed.
4. **The run, inside the PC cap.** Every container in this ADR, `unpack`, `import`,
   `label` and `decompile`, is named `riftal_smoke_ghidra_<step>_<pid>` and runs with
   `--rm --init --network none -m 2g --cpus 2 --user <uid>:<gid> -e HOME=/tmp -e
   MAXMEM=1400M`, no `-p`, under `timeout --kill-after=10 3600`, and is removed by name
   on every exit path as `record.js:170` does. `analyzeHeadless` gets `-max-cpu 2`.
   Ghidra's own settings and compiled scripts go to `/tmp` and die with the container.
   - **Heap.** `MAXMEM` is `analyzeHeadless`'s setting and becomes the JVM's `-Xmx`.
     Unset, the JVM takes about a quarter of the limit. 1400M leaves about 650 MiB of the
     2048 MiB for what the heap does not hold: metaspace and the code cache for Ghidra's
     classes, thread stacks, the native `decompile` process `Decompile.java` starts, and
     page cache charged to the container. Every `analyzeHeadless` call, the import
     included, passes `-scriptPath /tool/scripts -preScript Heap.java`, and `Heap.java`
     only prints `Runtime.getRuntime().maxMemory()`, so each run's log shows it took.
   - **No auto-analysis.** The import is `-import ... -noanalysis` (item 5), so there is
     no analyzer set to pass. Every fact item 8 needs is a read of memory the import
     gives, or a decode of bytes at an address by Ghidra's `PseudoDisassembler`, which
     needs no analysis and changes nothing. The ELF loader applies the binary's
     relocations at import with analysis off, so a vtable slot holds its target and an
     imported symbol such as `__cxa_pure_virtual` is bound to its external address.
   - **Timeout.** 3600 s per container. Import with no analysis and three passes over
     the data blocks are far below that, so a slow disk does not kill a good run, and a
     run stuck collecting garbage at the heap ceiling frees the PC within the hour. The
     tool takes no flag that changes the limits, the heap or the timeout.
   - **Headroom.** Before any container starts, the tool refuses when `os.freemem()` is
     under 4 GiB, the floor `container-limits.js` holds, or when the cache's filesystem
     (`fs.statfsSync`) has under 8 GiB free: the unpacked JDK and Ghidra, one project
     and its staging copy, and the server the import extracts into its container layer,
     with room left for the CI runners that share the distro's disk.
   - **Engine.** The docker engine inside WSL distro `Ubuntu-26.04`, the tool run as
     `wsl -d Ubuntu-26.04 -u runner --exec node .../tools/ghidra/analyze.js` with
     `docker` as the default `--docker`, as `inspect.js:12-13` and `:26` do for
     `tools/bds`. On this PC only, never on a `hyzensmp` sidecar.
   - **This departs from nothing.** If the first live run cannot finish under the cap,
     by OOM kill, a heap error or the timeout, its evidence goes to the steward, who
     decides whether a raise is within its powers or is Nasir's. No limit is raised
     without that ruling.
5. **Project per build ID, read first.** The key is the ELF GNU Build ID, the 40-hex
   value in ADR 001's table. It names the exact bytes. A version string can be
   republished, and the 8-digit number ADR 002 calls a Build ID is not this key.
   - If a project's `build.txt` already names this zip's SHA-256, the tool reports it and
     runs nothing.
   - The import container's mounts, all read-only but the last: `<cache>:/bds` for the
     zip, `<cache>/ghidra/projects:/projects`, `tools/bds:/bdstool` for `unzip.js`,
     `tools/ghidra:/tool`, and a fresh writable `<cache>/ghidra/staging/<pid>:/staging`.
   - `tools/ghidra/import.sh` works in `cd "$(mktemp -d)"` under the container's own
     `/tmp`, as `run.sh:18` does, writable under `--user` and gone with the container.
     There, before Ghidra starts, it unzips the BDS zip with the image's Node and
     `unzip.js`, which extracts every entry, the whole server of about 4100 files and
     not `bedrock_server` alone; reads the binary's Build ID with
     `tools/ghidra/buildid.js`; and hashes the zip with `sha256sum`.
   - If `/projects/<build-id>/` exists, as for a republished zip with new bytes around
     the same binary, it prints both and exits 3, and the tool reports that the build is
     already analysed and does nothing more.
   - Otherwise it runs `analyzeHeadless /staging/base bds -import <tmp>/bedrock_server
     -noanalysis` with item 4's arguments, then writes `/staging/base/build.txt` (Build
     ID, BDS version, zip name, zip SHA-256, Ghidra and JDK versions). On exit 0 the host
     renames `staging/<pid>/base` to `<cache>/ghidra/projects/<build-id>/base`; on any
     other exit it removes the staging directory. An existing
     `projects/<build-id>/base` is never overwritten or opened for writing.
6. **What persists outside the container, amending ADR 001.** ADR 001 says the binary
   is extracted only inside the throwaway container. That stays true of the extracted
   files, which die with it. What now persists is `<cache>/ghidra/projects/<build-id>/`,
   whose `bds.rep/` copies hold the program's bytes, plus the derived files of items 7,
   8 and 10. All of it stays in the cache on this PC: never committed, never in an image
   layer, a CI artifact, an issue, a PR, a comment or a report, and never copied to
   `hyzensmp`. Decompiled code and `facts.tsv` are held to the same rule. What may leave
   the cache is a short derived summary in our own words: packet names, slot numbers,
   counts and field layouts. Rule 1 is the only rule that allows one ("We commit our own
   code and short derived summaries", said of Mojang's docs). Rule 2 allows nothing of
   BDS to be committed or redistributed, and a summary in our words carries none of its
   bytes.
7. **The post-script is Java, labels a copy, and holds no logic.** `Dump.java` and
   `Label.java` under `tools/ghidra/scripts/`, run by `tools/ghidra/label.sh` in
   `riftal_smoke_ghidra_label_<pid>` under item 4's flags, timeout and removal. Mounts,
   read-only but the last: `<cache>/ghidra/projects/<build-id>:/project`,
   `tools/ghidra:/tool`, `packages/bedrock-protocol/src/ProtocolInfo.php:/proto/ProtocolInfo.php`,
   and a fresh writable `<cache>/ghidra/staging/<pid>:/staging`.
   - `label.sh`, under `set -e`, copies `/project/base` to `/staging/labelled`; runs
     `analyzeHeadless` on it with `-process -noanalysis -readOnly -postScript
     Dump.java`, which writes `facts.tsv`; runs `tools/ghidra/packets.js` on the image's
     Node, which writes `packets.tsv` and `labels.tsv`; then runs `analyzeHeadless`
     without `-readOnly` and with `-postScript Label.java`, which creates a function and
     a label at each address in `labels.tsv` and saves the copy. Every decision is in
     `packets.js`.
   - **Exit 0.** The host removes the old `labelled/` and `.tsv` files in
     `projects/<build-id>/`, renames the new ones in, and removes
     `<cache>/ghidra/failed/<build-id>/`. A crash between the remove and the renames
     loses only those files, and running again rebuilds them from `base/`. Labels never
     stack, because every run labels a fresh copy of the unlabelled import.
   - **Any other exit**, a refusal by `packets.js`, a failed `Dump.java` or
     `Label.java`, the timeout or a signal: the host moves every `.tsv` file staging
     holds into `<cache>/ghidra/failed/<build-id>/<pid>/`, removes the rest of staging,
     `labelled/` included, and leaves the project as it was. Kept runs stay until the
     next exit 0 for that Build ID removes them, and before keeping a fourth the host
     removes the oldest. They are cache under item 6, never committed or posted.
   - Java because Ghidra compiles it with the JDK already in the image; PyGhidra needs
     CPython, which the base image lacks and cannot `apt` with no network. Thin, because
     CI has no Ghidra and no JDK (`.github/workflows/ci.yml`), so only Node is tested.
8. **Facts, then a slot rule.** Tab-separated text, a `#` header, one record per line,
   the first field naming its kind. Java writes it with no library, Node and an agent
   read it, and two builds diff line by line. Slot `i` counts 8-byte entries from 0 at a
   vtable's address point, the word after its typeinfo pointer.
   - **`facts.tsv`**, facts only, from `Dump.java`:
     - `name <addr> <string>`: each RTTI name string matching `^\d+\w*Packet$`.
     - `typeinfo <addr> <name addr> <base>`: each word pointing to a name, minus 8, with
       the word at +16 as `<base>`. Each `<base>` whose word at +8 points to a string of
       RTTI name form gets its own line, up to 8 steps, so an intermediate class whose
       name does not end in `Packet` is in the chain.
     - `vtable <addr> <typeinfo> <offset-to-top>`: each word pointing to a typeinfo,
       plus 8, kept when offset-to-top is 0 or in -65535 to -1 and slot 0 is executable
       or pure. These three are passes over the non-executable initialised blocks, each
       reading every 8-byte-aligned word once against a set.
     - `slot <vtable> <i> <target> <exec> <pure>` for slots 0 to L-1, L being the
       length of `6Packet`'s vtable: its entries from slot 0 while each is executable
       or pure. `pure` is 1 when the target is the external `__cxa_pure_virtual`.
       `Dump.java` exits non-zero if that symbol or a `6Packet` vtable is missing.
     - `insn <run> <n> <mnemonic> <reads> <writes> <imm> <to>`: the straight-line run
       at each target of a slot pure in `6Packet`, decoded by `PseudoDisassembler`. A run
       ends at the first CALL, JMP, RET or indirect branch, or after 64 instructions.
       `reads` and `writes` are the base registers among `rdi`, `rsi`, `rdx` and `rax`
       the instruction takes or sets, `imm` an immediate it moves into `eax`, `to` a
       direct CALL or JMP target. The run at each `to` is emitted too, to 4 levels.
   - **The slot rule**, in `packets.js` over `facts.tsv`:
     1. *Scope.* A row is a packet when its typeinfo's `<base>` chain reaches the
        `6Packet` typeinfo, and concrete when none of its slots 0 to L-1 is pure.
        `6Packet` and abstract bases get status `abstract`, classes off the chain
        `not-packet`. Neither is labelled, and neither is an error.
     2. *Candidates.* The slots that are pure in `6Packet`'s vtable.
     3. *Classes.* Each candidate target's run, followed through each `to` with what is
        already read or written carried along, gets one class. `ID`: after an optional
        `ENDBR64`, exactly a `MOV` of `imm` into `eax` and a `RET`. `R3`: `rdx` read
        before it is written. `R2`: `rsi` read before it is written, and not `R3`.
        `R0`: anything else. An `XOR` or `SUB` whose only register is the same one on
        both sides writes it and reads nothing.
     4. *Roles.* Over concrete packets, the id slot is the one candidate whose targets
        are `ID` for at least 90% of rows, the read slot the one other candidate that is
        `R3` for at least 90%, and the write slot the one remaining candidate that is
        `R2` for at least 90%. The build is refused if a role has no such slot or two, or
        if any other candidate reaches 50% in that role's class.
     5. *Cross-check.* A concrete row whose name maps to a constant in `ProtocolInfo.php`
        (`FooBarPacket` to `FOO_BAR_PACKET`) gets status `id-mismatch`, an error, unless
        its id target is `ID` with that constant's value.
     6. *Shared targets.* In the read and in the write slot, a target held by more than
        one concrete packet is a body the linker folded, such as two empty `write`s.
        Those rows get status `shared` and no label, since a folded body names no single
        packet, and are not an error. The build is refused when more than 8 rows hold one
        target, when rows on shared targets are over a tenth of the slot's rows, or when
        a read target is also a write target. A wrong slot shows as one target for most
        rows and is refused here.
   - **`packets.tsv`** is always written. Then `packets.js` exits non-zero on a refused
     build or any row error, and `Label.java` does not run. Its `#` lines hold no
     address by construction: `# build <id> ghidra 12.1.4 L=<L> pure=<list>`; `# roles
     id=<i> read=<r> write=<w>` or `# refused <reasons>`; per candidate `# slot <i> rows
     <n> distinct <d> ID <a> R3 <b> R2 <c> R0 <e>`; `# ids compared <n> matched <m>`; per
     role `# shared <role> rows <n> largest <k>`; and `# status <s> <count>`. Rows are
     `name typeinfo vtable id read write status`. Error statuses: `two-primary` (two
     vtables with offset-to-top 0), `prefix` (a length prefix not matching the name),
     `short-vtable`, `outside-exec` and `id-mismatch`.
   - **`labels.tsv`**: address and label, `<Name>_getId`, `<Name>_read` and
     `<Name>_write`, from `ok` rows of a build that is not refused.
   - After exit 0 all three live in `projects/<build-id>/`. The slots are computed per
     build, never passed in, and the skill compares them across builds.
9. **Fixtures are recorded text.** `tools/ghidra/test/` holds `facts.tsv` fixtures with
   invented class names (`Foo1Packet` to `Foo24Packet`, `QuxPacket`) and addresses,
   written by hand or generated by the test from a template, and an invented
   `ProtocolInfo.php`. Nothing from Mojang.
   - The good fixture has an abstract intermediate base, a `QuxPacket` off the chain, a
     `write` that zeroes `edx` before a call, a forwarder that sets `rdx` and jumps to a
     helper, and one folded pair in the write slot. The test asserts its roles, the
     `shared` pair, and exit 0.
   - Each mutation is refused, and the test asserts the reason, the exit code and that
     `packets.tsv` was still written: a slot target outside the executable block; one
     write target for every row (a wrong slot); a second candidate `R2` for most rows (an
     ambiguous role); a getId immediate differing from `ProtocolInfo.php`; a folded
     group of 9 rows.
   - `unpack.sh` is tested as `tools/bds/test/run.test.js` tests `run.sh`, under bash
     with stubbed commands on fixture trees, skipped on win32. Each refusal exits
     non-zero on its own fixture: `unzip.js` reporting 65535 entries, `analyzeHeadless`
     or `decompile` without the owner exec bit, and an uncommented `MAXMEM=` line. A
     fixture whose only `MAXMEM=` is commented passes.
   - The Build ID reader is tested on a hand-built ELF note. `analyze.js` is tested as
     `inspect.test.js` tests `dockerArgs`, and through a fake `--docker` command, as
     `record.js` accepts: item 4's flags, `MAXMEM=1400M` and the timeout on every
     container, the headroom refusals, and item 7's exits, with the `.tsv` files moved
     to `failed/<build-id>/<pid>/`, the oldest of four removed, and `failed/<build-id>/`
     removed on exit 0. `tools/**/*.test.js` already runs them, so `ci.yml`, a steward
     path, is unchanged.
10. **The skill.** `.claude/skills/packet-re/SKILL.md` runs the tools through Bash
    against one named packet. Its PR adds `Decompile.java`, run read-only on `labelled/`
    in `riftal_smoke_ghidra_decompile_<pid>` under item 4's flags, which writes that
    packet's labelled `read` and `write` to `projects/<build-id>/out/<Packet>.c`, and the
    skill reads that and `packets.tsv`. It ends with the shared failure block. Frida is
    out of scope.
11. **Delivery.** This ADR; then the image, `unpack.sh` and the import (`analyze.js`,
    `import.sh`, `buildid.js`, `Heap.java`) with its live run; then `Dump.java`,
    `packets.js`, `Label.java` and `label.sh` with theirs, picked only once the import's
    live run shows it completed inside item 4's cap, as the steward ruled on PR #55;
    then the skill. One PR each, at most 392 changed lines; one that would pass that
    splits at an item boundary.

## Why

- **The container shape is ADR 003's, with the PC cap and no network.** The same pinned
  base, hash-checked inputs fetched before the run, a `riftal_smoke_` name, no port,
  `-m 2g --cpus 2` as `record.js:95` passes, and removal by name, so a reviewer checks
  one pattern. It differs in `--network none`, because nothing here talks to anything.
- **Import without analysis.** Full auto-analysis of a binary this size is what does
  not fit 2 GiB, and the facts need none of it. It also makes a project cheap to
  rebuild, which makes items 5 and 7's throw-away-on-failure rules affordable.
- **A fixed heap, logged by every call.** With the default, the JVM sizes the heap, and
  a heap error would look like a limit problem when it is a setting.
- **Read and write by the calling convention.** `void write(BinaryStream&) const` takes
  `this` in `rdi` and the stream in `rsi`. `_read` returns `Bedrock::Result<void>`,
  which is not trivially copyable, so under the x86-64 SysV ABI it returns through a
  hidden pointer in `rdi`, `this` moves to `rsi` and the stream to `rdx`. `getName`
  returns a `std::string` the same way and takes no stream, and `getId` returns a
  constant in `eax`. A compiler never reads an argument register it was not given
  before setting it, so which of `rsi` and `rdx` a body reads first follows from the
  signature, not from code style or declaration order, and fixtures test it in CI.
  Following direct branches keeps a forwarder in the class of what it forwards to. If
  the signatures change, no candidate reaches 90% and the build is refused.
- **Packet IDs as the anchor.** Our own `ProtocolInfo.php` knows each packet's ID. A
  getId target returning that ID for its name shows the row's vtable is that class's and
  the slot numbering is right, independent of the read and write rule.
- **Folded bodies are allowed, bounded.** The linker merges identical functions, so two
  empty `write`s can share one address in a good build. A wrong slot is shared by
  nearly every packet, far past 8 rows or a tenth.
- **An image over unpacking at run time.** The ruling says an image. Built by copying a
  tree that was hash-checked and unpacked under the cap, with `--network none`, it adds
  no source a run could fetch from and no step a limit has to cover.
- **Build ID over version, read first.** A key that can name two binaries could return
  the wrong project, and reading it before Ghidra starts costs one extraction, not one
  import.
- **Staging then rename.** A crashed or timed-out run is never mistaken for a finished
  project or labelling, as `inspect.download` does with `.part`.
- **Logic in Node.** It is the only place this repository's CI can test, and the facts
  and summary are text, so a fixture needs neither Ghidra nor a compiler.

## Rejected

- **REA in the loop.** Ruled out on #5.
- **The host's Ghidra.** Unpinned, unchecked and outside the container rule.
- **Full auto-analysis, at any limit.** Hours of work the facts do not use, and it does
  not fit the PC cap.
- **A reduced analyzer set.** Disassembly and function-start search still walk all of
  `.text`, which grows with the binary, and the analyzer names are Ghidra's to change.
- **Slot numbers found by hand and passed as arguments.** ADR 001's budget assumed
  analysis, and a wrong guess labelled every packet and exited 0.
- **`Decompile.java` in PR 3 to tell read from write.** Decompiled output of a stripped
  binary names nothing either, so it hands the call to whoever reads it, and no CI test
  can hold it.
- **Slot order from third-party headers.** Another project's reading of other builds,
  and the order is Mojang's to change.
- **Refusing any shared target.** Fails good builds where the linker folded bodies.
- **Granting an exception to the PC cap in this ADR.** An ADR merged by the approver
  would grant it with nobody ruling. A raise is the steward's or Nasir's, on evidence
  (item 4).
- **Unpacking in a `RUN` step of the build.** `unzip.js` holds the whole zip in memory,
  and a build step's limit is not one this tool can state the same way as `docker run`'s.
- **Labelling the project in place.** A save killed partway could corrupt the only copy,
  and a second labelling would stack on the first.
- **The matching logic in Java, or a tiny ELF fixture.** Each needs a JDK, Ghidra or a
  compiler in CI, and the fixture would test the analyzer more than our code.
- **Running Ghidra in CI.** A large download per job, and a project holding Mojang's
  bytes would then exist on a runner.
- **JSON for the summary.** Needs a library or hand-written escaping in Java, and diffs
  worse between builds.
- **Committing a project, a fixture from BDS, `facts.tsv` or decompiled code.** Mojang's
  bytes and code, rule 2.
- **Frida.** Out of scope by the ruling.

## Consequences

- **ADR 001** carries pointers here: item 6 amends its cache line, and item 8 replaces
  its hand-naming budget.
- **The Java scripts are not covered by CI.** Each live run posts on its PR, never an
  address, a byte or a line of decompiled code:
  - the import's PR: the image ID, the three hashes checked, `unpack.sh`'s entry count
    and file checks, the full `docker run` arguments of every container, `Heap.java`'s
    `maxMemory()` from the import, the Build ID, the wall time and peak memory of each
    container, the free memory and disk the tool read, and the project's size;
  - the post-script's PR: every `#` line of `packets.tsv`, for the release build and
    for the preview build when its Build ID differs, and whether the two agree on the
    role slots. On a refused run the same lines come from the kept
    `failed/<build-id>/<pid>/packets.tsv`;
  - both: `docker ps -a` showing no `riftal_smoke_ghidra_*` container afterwards.
- **Each new BDS build** costs one import and one project in the cache, plus its
  `labelled/` copy and at most three kept failed runs. Old projects are removed by hand;
  no tool removes a project.
- **Revisit** if the first live run cannot finish under 2g, 2 CPUs and 3600 s (to the
  steward, item 4), if import leaves vtable slots unrelocated or `__cxa_pure_virtual`
  unbound, if `unpack.sh` refuses the Ghidra zip, if item 8's rule refuses a live build
  (to the steward, with the kept files), or if a links API entry or zip ever carries
  `bedrock_server.debug` (ADR 001).

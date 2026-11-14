# 004 Ghidra pre-analysis of Linux BDS in a throwaway container

Date: 2026-11-14
Status: accepted
Milestone: M1
Issue: pmmp-updater#5

## Context

ADR 002 leaves five BedrockData files with the source "neither. #5", and ADR 001's
Consequences send #5 into a stripped binary with no function names, where only the
Itanium RTTI names of 239 to 240 `*Packet` classes survive (ADR 001 finding 8). The
steward's ruling on #5 (issuecomment 6766225363) sets the route: Ghidra headless in a
throwaway container, one saved project per BDS build, packet classes found through RTTI
and vtables by a post-script, a `packet-re` skill on top, no REA and no Frida. This ADR
records that ruling and settles the details an implementer would otherwise guess. It
does not reopen the ruling. As with ADR 003, the steward's ruling is the acceptance of
the route, and this ADR's merge is the acceptance of its details.

The ruling asks for `-m` and `--cpus` limits and names no values. This PC caps every
container at 2G and 2 CPUs for a server or a build, and 1G and 1 CPU for any other
one-shot container (riftal-pm `devtools/container-limits.js:2-4`, riftal-pm ADR 024
item at lines 228-229), and the tree's own BDS runs stay inside it (`record.js:95`,
`inspect.js:57`). This ADR grants no exception to that cap. Fitting a 265 to 277 MB
stripped binary inside it is the design problem item 4 settles.

## Decision

1. **No REA in the loop.** Ghidra runs only as `analyzeHeadless` inside the container
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
   - Unpacking is a container, `riftal_smoke_ghidra_unpack_<pid>`, with item 4's flags.
     Mounts: `<cache>/ghidra/dist:/dist:ro`, `<cache>/node:/node:ro`,
     `tools/bds:/bdstool:ro`, `tools/ghidra:/tool:ro`, and one writable directory, a
     fresh `<cache>/ghidra/staging/<pid>/`. `tools/ghidra/unpack.sh` checks each archive
     with `sha256sum --check` against the constants, as `run.sh:19` does, untars Node
     and the JDK, and unzips Ghidra with the pinned Node and `tools/bds/unzip.js`, which
     keeps file modes and refuses zip64 and symlinks. It reads the whole zip into memory
     (`unzip.js:58`), which is why it runs here and not in a build step.
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
     code and none needs a limit. The staging directory is removed on every exit.
   - Tagged `riftal_smoke_ghidra:12.1.4` for the build cache only, run by the ID in the
     iidfile, never pushed.
4. **The run, inside the PC cap.** `--rm --init --network none -m 2g --cpus 2 --user
   <uid>:<gid> -e HOME=/tmp -e MAXMEM=1400M`, named `riftal_smoke_ghidra_<pid>`, no
   `-p`, under `timeout --kill-after=10 3600`, removed by name on every exit path as
   `record.js:170` does. `analyzeHeadless` gets `-max-cpu 2`. Ghidra's own settings go
   to `/tmp` and die with the container.
   - **Heap.** `MAXMEM` is `analyzeHeadless`'s setting and becomes the JVM's `-Xmx`.
     Unset, the JVM takes about a quarter of the limit. 1400M leaves about 650 MiB of the
     2048 MiB for what the heap does not hold: metaspace and the code cache for Ghidra's
     classes, thread stacks, the native `decompile` process `Decompile.java` starts, and
     page cache charged to the container. Each script logs
     `Runtime.getRuntime().maxMemory()` so the live run shows the setting took.
   - **No auto-analysis.** The pre-analysis is `analyzeHeadless <dir> bds -import
     /work/bedrock_server -noanalysis`. No analyzer runs, so there is no analyzer set
     to pass. Every fact item 8 needs is a read of memory that import already gives:
     the RTTI name strings, the pointers to them, the pointers to those typeinfos, the
     slot values, and which block is executable. The ELF loader applies the binary's
     relocations at import, with analysis off, so a vtable slot holds its target and
     not zero. `Label.java` disassembles and creates a function only at each `ok` slot
     target, which is all `Decompile.java` needs.
   - **Timeout.** 3600 s per container. Import with no analysis and one scan of the
     binary's memory is far below that, so a slow disk does not kill a good run, and a
     run stuck collecting garbage at the heap ceiling frees the PC within the hour. The
     tool takes no flag that changes the limits, the heap or the timeout.
   - **Headroom.** Before any container starts, the tool refuses when `os.freemem()` is
     under 4 GiB, the floor `container-limits.js` holds, or when the cache's filesystem
     (`fs.statfsSync`) has under 8 GiB free: the unpacked JDK and Ghidra, one project,
     and its staging copy at the same time, with room left for the CI runners that
     share the distro's disk.
   - **Engine.** The docker engine inside WSL distro `Ubuntu-26.04`, the tool run as
     `wsl -d Ubuntu-26.04 -u runner --exec node .../tools/ghidra/analyze.js` with
     `docker` as the default `--docker`, as `inspect.js:12-13` and `:26` do for
     `tools/bds`. On this PC only, never on a `hyzensmp` sidecar.
   - **This departs from nothing.** Every container in this ADR sits inside the PC's
     server-or-build cap. If the first live run under it cannot finish, by OOM kill, a
     heap error or the timeout, its evidence goes to the steward, who decides whether a
     raise is within its powers or is Nasir's. No limit is raised without that ruling.
5. **Project per build ID, read first.** The key is the ELF GNU Build ID, the 40-hex
   value in ADR 001's table. It names the exact bytes. A version string can be
   republished, and the 8-digit number ADR 002 calls a Build ID is not this key.
   - If a project's `build.txt` already names this zip's SHA-256, the tool reports it and
     runs nothing.
   - The import container mounts `<cache>:/bds:ro` and `<cache>/ghidra/projects:/projects:ro`,
     extracts `bedrock_server` into `/work`, and reads its Build ID with Node before
     Ghidra starts. If `/projects/<build-id>/` exists, as for a republished zip with new
     bytes around the same binary, it prints both and exits 3, and the tool reports that
     the build is already analysed and does nothing more.
   - Otherwise the container writes `base/` (`bds.gpr`, `bds.rep/`, `build.txt` with
     Build ID, BDS version, zip name, zip SHA-256, Ghidra and JDK versions) into
     `<cache>/ghidra/staging/<pid>/`. On exit 0 the host renames it to
     `<cache>/ghidra/projects/<build-id>/`. On any other exit the host removes the
     staging directory. An existing `projects/<build-id>/` is never overwritten, and
     `base/` is never opened for writing after its rename.
6. **What persists outside the container, amending ADR 001.** ADR 001 says the binary
   is extracted only inside the throwaway container. That stays true of the extracted
   files, which die with it. What now persists is `<cache>/ghidra/projects/<build-id>/`,
   whose `bds.rep/` copies hold the program's bytes, plus the derived files in items 8
   and 10. All of it stays in the cache on this PC: never committed, never in an image
   layer, a CI artifact, an issue, a PR, a comment or a report, and never copied to
   `hyzensmp`. Decompiled code is held to the same rule. What may leave the cache is the
   short derived summary rules 1 and 2 allow: packet names, slot numbers and field
   layouts in our own words.
7. **The post-script is Java, labels a copy, and holds no logic.** Two `GhidraScript`s
   under `tools/ghidra/scripts/`, run in one container with `projects/<build-id>/` mounted
   read-only and a fresh `staging/<pid>/` writable. The container copies `base/` into
   staging as `labelled/`; `analyzeHeadless` on that copy with `-process -noanalysis
   -readOnly -postScript Dump.java` writes `facts.tsv`; `tools/ghidra/packets.js`, on
   the image's pinned Node, turns it into `packets.tsv` and `labels.tsv`; then the same
   `analyzeHeadless` without `-readOnly` and with `-postScript Label.java` applies
   `labels.tsv` and saves the copy. Every decision is made in `packets.js`.
   - On exit 0 the host removes the old `labelled/` and three `.tsv` files and renames
     the new ones in. Any other exit removes staging and leaves the project as it was.
     A crash between the remove and the renames loses only `labelled/` and the `.tsv`
     files, and running the post-script again rebuilds them from `base/`. Labels never
     stack, because every run labels a fresh copy of the unlabelled import.
   - Java because Ghidra compiles it with the JDK already in the image. PyGhidra needs
     CPython, which the base image lacks and cannot `apt` with no network.
   - Thin scripts because CI has no Ghidra and no JDK (`.github/workflows/ci.yml`), so
     only Node can be tested there under CLAUDE.md rule 6.
8. **Formats.** Tab-separated text, a `#` header line, one row per record. Java writes
   it with no library, Node and an agent read it, and two builds diff line by line.
   - `facts.tsv`: per RTTI name string matching `^\d+\w*Packet$`, its address, each
     candidate typeinfo (the pointer to the name minus 8), each candidate vtable (the
     pointer to that typeinfo plus 8) with its offset-to-top, and the first N slot
     targets with whether each is in an executable block.
   - `packets.tsv`, the summary: header `# build <id> ghidra 12.1.4 slots read=<n>
     write=<m>`, then `name typeinfo vtable read write status`. Status is `ok` or a
     reason, such as two primary vtables, a length prefix that does not match the name,
     or a slot target outside `.text`. `packets.js` exits non-zero if any row is not `ok`,
     and then `Label.java` does not run.
   - `labels.tsv`: address and label, from `ok` rows only.
   - The read and write slot numbers are arguments, never guessed. Every packet shares
     `Packet`'s vtable layout, so one number fits every row of a build. The post-script
     PR's live run establishes them by hand on one build, as ADR 001 budgets, and the
     skill re-checks them per build.
   - All three files live in `projects/<build-id>/`, beside `base/` and `labelled/`.
9. **Fixtures are recorded text.** `tools/ghidra/test/` holds hand-written `facts.tsv`
   fixtures with invented class names (`FooPacket`, `BarPacket`) and invented addresses,
   nothing from Mojang. One is the good fixture with one mutation, a slot target outside
   the executable block, and the test asserts `packets.js` refuses it, so the test is
   shown able to fail. The Build ID reader is tested on a hand-built ELF note, not a BDS
   binary. `analyze.js` is tested as `inspect.test.js` tests `dockerArgs`, and through a
   fake `--docker` command, as `record.js` accepts; the tests assert `-m 2g --cpus 2`,
   `MAXMEM=1400M` and the timeout on every container. `tools/**/*.test.js` already runs
   them, so `ci.yml`, a steward path, is unchanged.
10. **The skill.** `.claude/skills/packet-re/SKILL.md` runs the tools through Bash
    against one named packet. Its PR adds a third thin script, `Decompile.java`, run
    read-only on `labelled/` under item 4's flags, which writes that packet's labelled
    `read` and `write` to `projects/<build-id>/out/<Packet>.c`, and the skill reads that
    and `packets.tsv`. It ends with the shared failure block. Frida is out of scope.
11. **Delivery.** This ADR; then the image and `analyze.js` with its live run; then
    `Dump.java`, `Label.java` and `packets.js` with theirs; then the skill. One PR each,
    at most 392 changed lines.

## Why

- **The container shape is ADR 003's, with the PC cap and no network.** The same pinned
  base, hash-checked inputs fetched before the run, a `riftal_smoke_` name, no port,
  `-m 2g --cpus 2` as `record.js:95` passes, and removal by name, so a reviewer checks
  one pattern. It differs in one place: `--network none` instead of ADR 003's isolated
  network, because nothing here talks to anything.
- **Import without analysis.** Full auto-analysis of a binary this size is what does
  not fit 2 GiB, and the facts need none of it. Skipping it also makes a project much
  cheaper to rebuild than a fully analysed one, which is what makes items 5 and 7's
  throw-away-on-failure rules affordable.
- **A fixed heap.** With the default, the heap would be sized by the JVM, not by us, and
  a heap error would look like a limit problem when it is a setting.
- **An image over unpacking at run time.** The ruling says an image. Built by copying a
  tree that was hash-checked and unpacked under the cap, with `--network none`, it adds
  no source a run could fetch from and no step a limit has to cover.
- **Build ID over version, read first.** A project holds the exact bytes; a key that can
  name two binaries could return the wrong one, and reading it before Ghidra starts
  costs one extraction instead of one import.
- **Staging then rename.** A crashed or timed-out run is never mistaken for a finished
  project or labelling, as `inspect.download` does with `.part`.
- **Logic in Node.** It is the only place this repository's CI can test, and the facts
  and summary are text, so a fixture needs neither Ghidra nor a compiler.

## Rejected

- **REA in the loop.** Ruled out on #5.
- **The host's Ghidra.** Unpinned, unchecked and outside the container rule.
- **Full auto-analysis, at any limit.** Hours of work the facts do not use, and it does
  not fit the PC cap.
- **A reduced analyzer set.** Disassembly and function-start search still walk the whole
  of `.text` from every entry point, which grows with the binary, and the analyzer names
  are Ghidra's to change, so every Ghidra bump would re-check the list for no fact the
  post-script reads.
- **Granting an exception to the PC cap in this ADR.** An ADR merged by the approver
  would grant it with nobody ruling. A raise is the steward's or Nasir's, on evidence
  (item 4).
- **Unpacking in a `RUN` step of the build.** `unzip.js` holds the whole zip in memory,
  and a build step's limit is not one this tool can state the same way as `docker run`'s.
- **Labelling the project in place.** A save killed partway could corrupt the only copy,
  and a second labelling would stack on the first.
- **PyGhidra.** Item 7.
- **The matching logic in Java.** Untestable in CI without adding a JDK and Ghidra to
  the runners.
- **A tiny ELF fixture the tests build.** Needs a compiler and Ghidra in CI, neither of
  which is there, and tests the analyzer more than our code.
- **Running Ghidra in CI.** A large download per job, and a project holding Mojang's
  bytes would then exist on a runner.
- **JSON for the summary.** Needs a library or hand-written escaping in Java, and diffs
  worse between builds.
- **Keying by BDS version.** Item 5.
- **Committing a project, a fixture from BDS, or decompiled code.** Mojang's bytes and
  code, rule 2.
- **Frida.** Out of scope by the ruling.

## Consequences

- **ADR 001's cache line** is amended by item 6, and carries a pointer here.
- **The Java scripts are not covered by CI.** Each live run posts on its PR: the image
  ID, the three hashes checked, `unpack.sh`'s entry count and file checks, the full
  `docker run` arguments of every container, the logged `maxMemory()`, the Build ID, the
  wall time and peak memory of each container, the free memory and disk the tool read,
  the project's size, the `packets.tsv` header and its count of rows by status (never
  the rows' addresses), and `docker ps -a` showing no `riftal_smoke_ghidra_*` container
  afterwards.
- **Each new BDS build** costs one import and one project in the cache, plus its
  `labelled/` copy. Old projects are removed by hand; no tool removes a project.
- **Revisit** if the first live run cannot finish under 2g, 2 CPUs and 3600 s (to the
  steward, item 4), if import leaves vtable slots unrelocated, if `unpack.sh` refuses
  the Ghidra zip, if one slot number does not fit every packet of a build, or if a links
  API entry or zip ever carries `bedrock_server.debug` (ADR 001).

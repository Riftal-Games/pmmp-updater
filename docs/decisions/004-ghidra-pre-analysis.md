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
throwaway container, one saved project per BDS build, a post-script and a skill on top,
no REA and no Frida. This ADR settles, within that ruling, the container, the image and
the import, the details an implementer would otherwise guess. It does not reopen the
ruling.

The ruling asks for `-m` and `--cpus` limits and names no values. This PC caps a server
or a build at 2G and 2 CPUs and any other one-shot container at 1G and 1 CPU (riftal-pm
`devtools/container-limits.js:2-4`), and the tree's own BDS runs stay inside it
(`record.js:95`, `inspect.js:57`). This ADR grants no exception to that cap. Fitting a
265 to 277 MB stripped binary inside it is the design problem item 4 settles.

ADR 001 budgets naming `read` and `write` by hand on top of Ghidra's analysis. The
import here runs with `-noanalysis` (item 4), so that budget does not hold as written.
Spike issue pmmp-updater#56 settles what replaces it, after the import's live run.

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
4. **The run, inside the PC cap.** Every container in this ADR, `unpack` and `import`,
   is named `riftal_smoke_ghidra_<step>_<pid>` and runs with `--rm --init --network none
   -m 2g --cpus 2 --user <uid>:<gid> -e HOME=/tmp -e MAXMEM=1400M`, no `-p`, under
   `timeout --kill-after=10 3600`, and is removed by name on every exit path as
   `record.js:170` does. `analyzeHeadless` gets `-max-cpu 2`. Ghidra's own settings and
   compiled scripts go to `/tmp` and die with the container.
   - **Heap.** `MAXMEM` is `analyzeHeadless`'s setting and becomes the JVM's `-Xmx`.
     Unset, the JVM takes about a quarter of the limit. 1400M leaves about 650 MiB of the
     2048 MiB for what the heap does not hold: metaspace and the code cache for Ghidra's
     classes, thread stacks, and page cache charged to the container. Every
     `analyzeHeadless` call, the import included, passes `-scriptPath /tool/scripts
     -preScript Heap.java`, and `tools/ghidra/scripts/Heap.java` only prints
     `Runtime.getRuntime().maxMemory()`, so each run's log shows it took.
   - **No auto-analysis.** The import is `-import ... -noanalysis` (item 5), so there is
     no analyzer set to pass.
   - **Timeout.** 3600 s per container. An import with no analysis is far below that, so
     a slow disk does not kill a good run, and a run stuck collecting garbage at the heap
     ceiling frees the PC within the hour. The tool takes no flag that changes the
     limits, the heap or the timeout.
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
   whose `bds.rep/` copies hold the program's bytes. All of it stays in the cache on this
   PC: never committed, never in an image layer, a CI artifact, an issue, a PR, a
   comment or a report, and never copied to `hyzensmp`. Anything a later step derives
   from a project, decompiled code included, is held to the same rule. What may leave
   the cache is a short derived summary in our own words: packet names, counts and field
   layouts. Rule 1 is the only rule that allows one ("We commit our own code and short
   derived summaries", said of Mojang's docs). Rule 2 allows nothing of BDS to be
   committed or redistributed, and a summary in our words carries none of its bytes.
7. **Tests.** `tools/ghidra/test/` holds fixture trees written by hand or generated by
   the test. Nothing from Mojang.
   - `unpack.sh` is tested as `tools/bds/test/run.test.js` tests `run.sh`, under bash
     with stubbed commands on fixture trees, skipped on win32. Each refusal exits
     non-zero on its own fixture: `unzip.js` reporting 65535 entries, `analyzeHeadless`
     or `decompile` without the owner exec bit, and an uncommented `MAXMEM=` line. A
     fixture whose only `MAXMEM=` is commented passes.
   - The Build ID reader is tested on a hand-built ELF note. `analyze.js` is tested as
     `inspect.test.js` tests `dockerArgs`, and through a fake `--docker` command, as
     `record.js` accepts: item 4's flags, `MAXMEM=1400M` and the timeout on every
     container, the headroom refusals, and item 5's exits, with exit 3 reported and
     nothing renamed, any other non-zero exit removing staging, and exit 0 renaming into
     `projects/<build-id>/base` and never over an existing one. `tools/**/*.test.js`
     already runs them, so `ci.yml`, a steward path, is unchanged.
   - `Heap.java` is not covered by CI, which has no Ghidra and no JDK
     (`.github/workflows/ci.yml`). The import PR's live run covers it.
8. **Deferred to pmmp-updater#56.** The post-script, how the read and write slots are
   found, labelling and the skill are decided under spike issue pmmp-updater#56, after
   the import PR's live run has posted its evidence. This ADR settles none of them.
   Frida is out of scope, as the ruling says.
9. **Delivery.** This ADR; then the image, `unpack.sh` and the import (`analyze.js`,
   `import.sh`, `buildid.js`, `Heap.java`) with its live run; then #56. Nothing after
   #56 is ordered here. One PR each, at most 392 changed lines; one that would pass that
   splits at an item boundary.

## Why

- **The container shape is ADR 003's, with the PC cap and no network.** The same pinned
  base, hash-checked inputs fetched before the run, a `riftal_smoke_` name, no port,
  `-m 2g --cpus 2` as `record.js:95` passes, and removal by name, so a reviewer checks
  one pattern. It differs in `--network none`, because nothing here talks to anything.
- **Import without analysis.** Full auto-analysis of a binary this size is what does
  not fit 2 GiB. It also makes a project cheap to rebuild, which makes item 5's
  throw-away-on-failure rule affordable.
- **A fixed heap, logged by every call.** With the default, the JVM sizes the heap, and
  a heap error would look like a limit problem when it is a setting. `Heap.java` on the
  import lets the import PR's live run show the setting took.
- **An image over unpacking at run time.** The ruling says an image. Built by copying a
  tree that was hash-checked and unpacked under the cap, with `--network none`, it adds
  no source a run could fetch from and no step a limit has to cover.
- **Build ID over version, read first.** A key that can name two binaries could return
  the wrong project, and reading it before Ghidra starts costs one extraction, not one
  import.
- **Staging then rename.** A crashed or timed-out run is never mistaken for a finished
  project, as `inspect.download` does with `.part`.
- **Decisions in Node.** It is the only place this repository's CI can test, so the
  headroom, the flags and the exits live in `analyze.js` and the Java script only prints.
- **Slot identification in its own spike.** The steward ruled a replan on PR #55: the
  import does not depend on it, and the import's live run is the evidence #56 starts
  from.

## Rejected

- **REA in the loop.** Ruled out on #5.
- **The host's Ghidra.** Unpinned, unchecked and outside the container rule.
- **Full auto-analysis, at any limit.** Hours of work, and it does not fit the PC cap.
- **A reduced analyzer set.** Disassembly and function-start search still walk all of
  `.text`, which grows with the binary, and the analyzer names are Ghidra's to change.
- **Deciding slot identification, labelling or the skill in this ADR.** Moved to #56 by
  the steward's replan on PR #55, ahead of the evidence the import's live run gives.
- **Granting an exception to the PC cap in this ADR.** An ADR merged by the approver
  would grant it with nobody ruling. A raise is the steward's or Nasir's, on evidence
  (item 4).
- **Unpacking in a `RUN` step of the build.** `unzip.js` holds the whole zip in memory,
  and a build step's limit is not one this tool can state the same way as `docker run`'s.
- **Running Ghidra in CI.** A large download per job, and a project holding Mojang's
  bytes would then exist on a runner.
- **Committing a project, a fixture from BDS or decompiled code.** Mojang's bytes and
  code, rule 2.
- **Frida.** Out of scope by the ruling.

## Consequences

- **ADR 001** carries pointers here: item 6 amends its cache line, and item 4's
  `-noanalysis` means its hand-naming budget does not hold as written; #56 settles what
  replaces it.
- **The import PR's live run** posts on its PR, never an address, a byte or a line of
  decompiled code: the image ID, the three hashes checked, `unpack.sh`'s entry count
  and file checks, the full `docker run` arguments of every container, `Heap.java`'s
  `maxMemory()` from the import, the Build ID, the wall time and peak memory of each
  container, the free memory and disk the tool read, the project's size, and
  `docker ps -a` showing no `riftal_smoke_ghidra_*` container afterwards.
- **Each new BDS build** costs one import and one project in the cache. Old projects
  are removed by hand; no tool removes a project.
- **Revisit** if the first live run cannot finish under 2g, 2 CPUs and 3600 s (to the
  steward, item 4), if `unpack.sh` refuses the Ghidra zip, or if a links API entry or
  zip ever carries `bedrock_server.debug` (ADR 001).

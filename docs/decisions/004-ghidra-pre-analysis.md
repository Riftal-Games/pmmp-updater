# 004 Ghidra pre-analysis of Linux BDS in a throwaway container

Date: 2026-11-14
Status: proposed
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
does not reopen the ruling.

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
   - Both are fetched by `pinnedFile` (`record.js:42`, exported, not copied) into
     `<cache>/ghidra/dist/<file>`, where `<cache>` is the BDS cache `inspect.parseArgs`
     defaults to (`~/.cache/pmmp-updater/bds`), so the Node tarball stays at
     `<cache>/node/`. A cached file is re-checked on every run.
   - The PR that adds a pin names the page each hash was read from.
3. **The image.** `tools/ghidra/Dockerfile`, `FROM` the `inspect.IMAGE` digest
   (`tools/bds/inspect.js:22`). The tool checks with `docker image inspect` that the base
   is present and refuses otherwise, so nothing pulls. The build context is a fresh
   `mktemp -d` holding copies of the three archives and `unzip.js` and nothing else,
   removed afterwards. `docker build --network none --iidfile`, with the three SHA-256s
   as `--build-arg`s from the constants above; a `RUN` step checks each with
   `sha256sum --check` before unpacking, as `run.sh:19` does. Node and the JDK unpack
   with `tar`; the Ghidra zip unpacks with the pinned Node and `tools/bds/unzip.js`,
   which keeps the zip's file modes and refuses zip64 and symlinks. Tagged
   `riftal_smoke_ghidra:12.1.4` for the build cache only, run by the ID in the iidfile,
   never pushed.
4. **The run.** `--rm --init --network none -m 16g --cpus 4 --user <uid>:<gid>
   -e HOME=/tmp`, named `riftal_smoke_ghidra_<pid>`, no `-p`, under `timeout
   --kill-after`, removed by name on every exit path as `record.js:170` does. Mounts:
   `<cache>:/bds:ro`, `tools/bds:/bdstool:ro`, `tools/ghidra:/tool:ro`, and one writable
   directory: the run's staging directory for pre-analysis, the project's directory for
   the post-script. Ghidra's own settings go to `/tmp` and die with the container. The
   memory, CPU and 6-hour timeout are the tool's starting values; the first live run
   measures them, and raising any above these goes to the steward, because the run
   shares the PC with the dev stack and the CI runners. Runs happen on this PC only,
   never on a `hyzensmp` sidecar.
5. **Project per build ID.** The key is the ELF GNU Build ID, the 40-hex value in ADR
   001's table, read from the extracted `bedrock_server` inside the container. It names
   the exact bytes. A version string can be republished, and the 8-digit number ADR 002
   calls a Build ID is not this key.
   - The container writes into `<cache>/ghidra/staging/<pid>/`: `bds.gpr`, `bds.rep/`
     and `build.txt` (Build ID, BDS version, zip name, zip SHA-256, Ghidra and JDK
     versions). On exit 0 the host renames it to `<cache>/ghidra/projects/<build-id>/`.
     On any other exit the host removes the staging directory.
   - If a project's `build.txt` already names this zip's SHA-256, the tool reports it and
     runs nothing. An existing `projects/<build-id>/` is never overwritten.
6. **What persists outside the container, amending ADR 001.** ADR 001 says the binary
   is extracted only inside the throwaway container. That stays true of the extracted
   files, which die with it. What now persists is `<cache>/ghidra/projects/<build-id>/`,
   whose `bds.rep/` holds the program's bytes, plus the derived files in items 8 and 10.
   All of it stays in the cache on this PC: never committed, never in an image layer, a
   CI artifact, an issue, a PR, a comment or a report, and never copied to `hyzensmp`.
   Decompiled code is held to the same rule. What may leave the cache is rule 1's short
   derived summary: packet names, slot numbers and field layouts in our own words.
7. **The post-script is Java, and holds no logic.** Two `GhidraScript`s under
   `tools/ghidra/scripts/`, run in one container in this order:
   `analyzeHeadless <dir> bds -process -noanalysis -readOnly -postScript Dump.java`
   writes `facts.tsv`; `tools/ghidra/packets.js`, on the image's pinned Node, turns it
   into `packets.tsv` and `labels.tsv`; then the same `analyzeHeadless` without
   `-readOnly` and with `-postScript Label.java` applies `labels.tsv` and saves the
   project. Every decision is made in `packets.js`.
   - Java because Ghidra compiles it with the JDK already in the image. PyGhidra needs
     CPython, which the base image lacks and cannot `apt` with no network, plus the
     pyghidra package and JPype, a native wheel built elsewhere, which ADR 003's
     `.node` rule already refuses for Node.
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
   - All three files live in `projects/<build-id>/`, beside the project.
9. **Fixtures are recorded text.** `tools/ghidra/test/` holds hand-written `facts.tsv`
   fixtures with invented class names (`FooPacket`, `BarPacket`) and invented addresses,
   nothing from Mojang. One is the good fixture with one mutation, a slot target outside
   the executable block, and the test asserts `packets.js` refuses it, so the test is
   shown able to fail. `analyze.js` is tested as `inspect.test.js` tests `dockerArgs`,
   and through a fake `--docker` command, as `record.js` accepts. `tools/**/*.test.js`
   already runs them, so `ci.yml`, a steward path, is unchanged.
10. **The skill.** `.claude/skills/packet-re/SKILL.md` runs the tools through Bash
    against one named packet. Its PR adds a third thin script, `Decompile.java`, which
    writes that packet's labelled `read` and `write` to
    `projects/<build-id>/out/<Packet>.c`, and the skill reads that and `packets.tsv`. It
    ends with the shared failure block. Frida is out of scope.
11. **Delivery.** This ADR; then the image and `analyze.js` with its live run; then
    `Dump.java`, `Label.java` and `packets.js` with theirs; then the skill. One PR each,
    at most 392 changed lines.

## Why

- **The container shape is ADR 003's and the scope ruling's.** The same pinned base,
  hash-checked inputs fetched before the run, no network, limits and removal by name,
  so a reviewer checks one pattern, not two.
- **An image over unpacking at run time.** The ruling says an image. Built from a
  context holding only checked archives, with `--network none`, it adds no source a
  run could fetch from.
- **Build ID over version.** A project holds analysis of exact bytes; a key that can
  name two binaries could return the wrong one.
- **Staging then rename.** A crashed or timed-out analysis is never mistaken for a
  finished project, as `inspect.download` does with `.part`.
- **Logic in Node.** It is the only place this repository's CI can test, and the facts
  and summary are text, so a fixture needs neither Ghidra nor a compiler.

## Rejected

- **REA in the loop.** Ruled out on #5.
- **The host's Ghidra.** Unpinned, unchecked and outside the container rule.
- **PyGhidra.** Item 7.
- **The matching logic in Java.** Untestable in CI without adding a JDK and Ghidra to
  the runners.
- **A tiny ELF fixture the tests build.** Needs a compiler and Ghidra in CI, neither of
  which is there, and tests the analyzer more than our code.
- **Running Ghidra in CI.** A large download and hours of analysis per job, and a
  project holding Mojang's bytes would then exist on a runner.
- **JSON for the summary.** Needs a library or hand-written escaping in Java, and diffs
  worse between builds.
- **Keying by BDS version.** Item 5.
- **Committing a project, a fixture from BDS, or decompiled code.** Mojang's bytes and
  code, rule 2.
- **Frida.** Out of scope by the ruling.

## Consequences

- **ADR 001's cache line** is amended by item 6, and carries a pointer here.
- **The Java scripts are not covered by CI.** Each live run posts on its PR: the image
  ID, the three hashes checked, the full `docker run` arguments, the Build ID, the wall
  time and peak memory, the project's size, the `packets.tsv` header and its count of
  rows by status (never the rows' addresses), and `docker ps -a` showing no
  `riftal_smoke_ghidra_*` container afterwards.
- **Each new BDS build** costs one pre-analysis and one project in the cache, likely
  several GB. Old projects are removed by hand; no tool removes a project.
- **Revisit** if `unzip.js` refuses the Ghidra zip, if analysis cannot finish inside 16
  GB and 6 hours, if one slot number does not fit every packet of a build, or if a links
  API entry or zip ever carries `bedrock_server.debug` (ADR 001).

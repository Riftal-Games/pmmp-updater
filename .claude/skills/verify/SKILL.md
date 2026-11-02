---
name: verify
description: Build the pmmp-core image with this checkout's packages/ and report BUILDS, LOADS (no plugins) and REACHABLE separately, REACHABLE against the protocol these packages speak. Use after any change to packages/, and as /protocol-update's verify stage.
when_to_use: packages/ changed and needs proving in the server image, /protocol-update reached Stage 5, or someone asks whether these packages build and boot in pmmp-core.
argument-hint: --core <pmmp-core dir> [--engine docker|wslc] [--tag <image tag>]
---

# Verify

A package change is only proven once pmmp-core builds with it, boots with it and answers a ping with the protocol it claims. This skill runs those three checks and reports each one on its own line, because "it builds" is not "it loads", and "it loads" is not "a client can reach it".

Its LOADS boots with no plugins and is reported as `LOADS (no plugins)`. It is not the LOADS a protocol update owes, Done with every riftal-game plugin enabled, which stays a separate check.

Read `docs/lessons.md` first.

## Run

```
node tools/verify/verify.js --core <pmmp-core dir>
```

| Option | Default | Means |
|---|---|---|
| `--core` | required | A pmmp-core checkout. Its HEAD commit is built; uncommitted changes there are not. Its `build/php` submodule must be initialised. |
| `--engine` | `docker` | `docker` is the Docker inside the `Ubuntu-26.04` distro, reached from Windows with `wsl ... --exec docker`, or plain `docker` on Linux. Use it. `wslc` is unverified, see below. |
| `--tag` | `local-pocketmine-mp:verify-<core short sha>` | The image tag. The bare `local-pocketmine-mp` and `:latest` are refused, because other runs share them. |

**wslc is unverified.** No live run has used `--engine wslc`; only a fake engine has. wslc wedged the whole container service on 2026-09-27 pulling an image it did not have, so `--engine wslc` first runs `wslc images --digests` and refuses to build unless every image the commit's `docker/Dockerfile` names (each `FROM`, `--from` and syntax frontend that is not one of its own stages) is listed, a digest-pinned one under that digest. Every wslc call has a timeout. wslc builds and runs LOADS but cannot run REACHABLE.

The commit must resolve the four packages by composer `path` from `deps/pmmp-updater/packages/`, which pmmp-core does from Riftal-Games/PocketMine-MP#281. An older commit fails BUILDS with that reason before anything is built.

## What it does

1. Writes the pmmp-core commit, blob by blob, into a temporary tree, with `build/php` from its submodule and this checkout's `packages/` as `deps/pmmp-updater/packages/`. The packages are the working tree, so uncommitted edits are built, and the BUILDS line says so. The pmmp-core checkout is never touched.
2. Reads `CURRENT_PROTOCOL` from `packages/bedrock-protocol/src/ProtocolInfo.php`, and writes it into the tree's copy of `.github/workflows/reachable-smoke.sh` in place of that script's own `EXPECTED_PROTOCOL`. The output names both numbers.
3. **BUILDS**: `build` with `GIT_HASH` set to the core commit. Evidence: the tag and image ID.
4. **LOADS (no plugins)**: boots the image by ID with `stop` on stdin and two `riftal_smoke_verify_*` volumes. Passes only on a `Done (` line, no `ERROR`, `CRITICAL`, `EMERGENCY` or `ALERT` line, no exception or fatal error, no crash upload, and exit 0. PocketMine exits 0 with errors in its log, so the log decides. This boot has no plugins; loading every riftal-game plugin is a separate check.
5. **REACHABLE**: runs the copied `reachable-smoke.sh` on the image ID. Passes on a pong advertising the expected protocol and a clean `stop`. Evidence: the pong line. A smoke script with no `EXPECTED_PROTOCOL` line, or two, fails REACHABLE as not run; BUILDS and LOADS still run.
6. Removes every container and volume it made, then asks the engine about each. Only an explicit "no such" answer counts as gone: anything else, a timeout included, fails the verdict as possibly left behind. The temporary tree is removed. The image is kept under its tag.

On Ctrl-C or SIGTERM it terminates the running command, stops and removes (`rm -v`) every container it created, removes its volumes and the temporary tree, prints anything it could not remove, and exits 130 with no verdict lines. Remove what it names by hand, or ask Nasir where the guard refuses.

Exit 0 when all three pass, 1 otherwise, 2 on a usage error, 130 on an interrupt.

## Report

Quote the three verdict lines on the PR, never in chat:

```
BUILDS PASS | local-pocketmine-mp:verify-<sha> is sha256:..., built from pmmp-core <sha> with pmmp-updater packages at <sha>
LOADS (no plugins) PASS | [..] [Server thread/INFO]: Done (2.164s)! For help, type "help" or "?", exit 0 after stop
REACHABLE PASS | REACHABLE: 127.0.0.1:<port>/udp answered with edition=MCPE motd='riftal-verify-probe' protocol=<n> version=<v>
```

These are BUILDS, REACHABLE and a LOADS with no plugins. LOADS with every riftal-game plugin, SCRIPTED, CLIENT and PLAYABLE are not claimed here.

## Check

`node --test "tools/verify/test/*.test.js"` runs against fixture repositories and a fake engine; nothing is built. `RIFTAL_LIVE_VERIFY=1` adds a real build and boot against `RIFTAL_VERIFY_CORE`, default the `pmmp-core` checkout beside this one, as `riftal-games/` lays them out. A cold PHP stage takes 20 to 40 minutes.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

---
name: protocol-update
description: The whole Bedrock protocol update, done by RiftalGames alone - from Mojang's first preview through docs diff, packet code, BDS data, upgrade schemas, core changes, verification and the version runbook. Use whenever a new Bedrock preview or release exists.
when_to_use: tools/watch filed an update issue, /client-scan says BEHIND, /docs-diff shows a protocol change, or Nasir asks to update to a Bedrock version.
argument-hint: <bedrock version, for example 1.26.70>
---

# Protocol update

We support one protocol version at a time. When Mojang releases a version, every player who updates is locked out until the server speaks it. The budget is 1 day from Mojang's release to a merged, verified image. That only holds if the work starts at the first preview, so this skill runs twice per version: once during previews, once on release day.

No upstream is consulted at any stage. If you find yourself reading axolotl-pm or pmmp code to decide what to write, use Mojang's docs and BDS instead, and record why in the runbook.

Protocol updates are priority one (hard rule 3). Nothing in this procedure is a reason to add game logic, in this repository or in pmmp-core.

## Stage 0: Prepare

1. Read `docs/lessons.md`.
2. Open or create `docs/versions/<version>.md` from the previous runbook's headings. Write the start time of each stage as you begin it.
3. Find the issue for the version (from `tools/watch`, #4) or file one: `owner:updater`, `prep` for a preview, `critical-path` for a release.
4. Work on branch `bedrock-<version>` here, and `bedrock-<version>` in pmmp-core for core changes. Never merge either into a mainline before Mojang releases the version.

## Stage 1: Detect and scope

1. `/client-scan`. Note the verdict and the client's protocol.
2. `/docs-diff --from <our tag> --to <newest tag for the version>`. This is the work list. Paste its summary into the runbook.
3. Read every developer note in the diff. A note about block state permutations or hashed runtime IDs means Stage 3's data work is not optional this version.

## Stage 2: Packets (preview, then again on release day)

1. `packages/bedrock-protocol/src/ProtocolInfo.php`: `CURRENT_PROTOCOL`, `MINECRAFT_VERSION`, `MINECRAFT_VERSION_NETWORK`, and every added, removed or renumbered packet constant, from the diff.
2. Added packets: draft each class and its payload types with `/codegen` (`node tools/codegen/generate.js --all-new --from <ours> --to <target>`). Resolve every `TODO(codegen)` marker, compare each draft against any class the package already has, then apply it. Field order is `x-ordinal-index`. A `Compression` serialization option is a varint.
3. Add each new packet to `PacketPool.php` and `PacketHandlerInterface.php`. Then run `php tools/generate-create-static-methods.php` in `packages/bedrock-protocol`.
4. Changed packets: for each, read the `via` types in the Mojang schema and change encode and decode to match. Removed packets: delete the class, its pool entry and its handler method.
5. Run `php-cs-fixer`, then `vendor/bin/phpstan analyze` and `vendor/bin/phpunit` in the package. Use a container built from pmmp-core's PHP stage, never a host PHP.
6. Where a schema leaves behaviour unclear, for example which variant follows a flag, use `/packet-re` (#5) against BDS, then record the answer in the runbook.

On release day, rerun Stage 1's docs-diff from the last preview tag to the release tag. Only that delta is left.

## Stage 3: Data (release day, needs BDS)

BDS supplies what the schemas cannot: block states, item tables, recipes, creative inventory. `tools/bds` (#3) runs it in a container. Downloading BDS accepts Mojang's EULA. That is Nasir's act and a hard stop: no agent downloads BDS until `../docs/decision-log.md` records his acceptance. Until #3 lands, follow its issue for the manual steps.

1. Dump protocol info and mapping files from BDS into `packages/bedrock-data`. Copy files, not folders.
2. Capture a packet trace by joining BDS with the real client through the root workspace's `../devtools/relay.js --upstream 127.0.0.1:<bds port>` on its own `RELAY_PORT`, then run `php tools/generate-bedrock-data-from-packets.php <trace> <packages/bedrock-data>` from pmmp-core.
3. In `packages/bedrock-protocol`, run `php tools/update-from-bedrock-data.php` and the other `tools/generate-*.php` scripts the new data needs.
4. Block upgrade schema: run pmmp-core's `tools/blockstate-upgrade-schema-utils.php` on the new `*_to_current_block_map.bin` and add the output to `packages/bedrock-block-upgrade-schema/nbt_upgrade_schema/` under the next number.
5. Item upgrade schema: run pmmp-core's `tools/generate-item-upgrade-schema.php` and add the output to `packages/bedrock-item-upgrade-schema/id_meta_upgrade_schema/` under the next number.

## Stage 4: Core (pmmp-core, through the steward)

Core changes go in pmmp-core on `bedrock-<version>`. `src/` changes are gated to the steward.

1. Point pmmp-core at this branch's packages with `install-local-protocol.sh` pointed at `packages/`, or bump the submodule once PocketMine-MP#276 lands.
2. Update `src/data/bedrock/block` and `src/data/bedrock/item` for new or changed types, then `composer update-codegen`.
3. `src/data/bedrock/WorldDataVersions.php`: `LAST_OPENED_IN` and `NETWORK` change every version. `BLOCK_STATES` changes often. `CHUNK`, `SUBCHUNK` and `STORAGE` rarely do.
4. `vendor/bin/phpstan analyze` until clean, `vendor/bin/phpunit tests/phpunit` until green.

## Stage 5: Verify

Run `/verify` (`node tools/verify/verify.js --core <pmmp-core dir>`) for items 1 to 3. Each verdict is reported separately on the PR, never in chat:

1. BUILDS: the image builds from the working branches.
2. LOADS: Done with every riftal-game plugin, no exception in the log.
3. REACHABLE: the pong advertises the new protocol number.
4. SCRIPTED: a bot scenario passes, once the bots speak the new version.
5. CLIENT: a real client on this PC on the new version joins, renders chunks, moves, breaks and places a block, opens a chest, takes damage, respawns, and rejoins.
6. Restart the server and confirm the world reloads with no upgrade errors. This catches a wrong `WorldDataVersions` constant.

PLAYABLE is never claimed. That is Nasir on a device.

## Stage 6: Release

1. Open a PR from `bedrock-<version>` to `main` here with `Closes #<issue>`. The approver or the steward merges it; you never merge it yourself. Tag `v<version>` on the merge commit after it lands, never `bedrock-<version>`, which would share its name with the branch. Never rebase.
2. In pmmp-core: bump the submodule to that tag, bump `BASE_VERSION` in `src/VersionInfo.php` by a **minor** step, and merge through the steward. Record the image tag.
3. If block or item data changed, tell `riftal-game` which, for `/test-server` before rollout.

## Stage 7: Record and improve

1. Finish `docs/versions/<version>.md`: each stage's start and end, downtime from Mojang's release to the merged image, the BDS build, and every incident.
2. Any stage over its budget in `/skill-incident` is an incident, even though it passed.
3. Update `tools/client-scan` snapshots and commit them.
4. Report to the root session: version, protocol, image tag, downtime, incidents.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

---
name: codegen
description: Draft PHP packet classes, and the payload types they need, from Mojang's protocol docs in the style of packages/bedrock-protocol. Use for every packet a Bedrock version adds, after docs-diff has listed them.
when_to_use: /protocol-update reaches new packets, docs-diff reports added packets, or someone asks for a packet class drafted from Mojang's schema.
---

# Codegen

Mojang's schemas give each packet its ID, its fields in wire order (`x-ordinal-index`), each field's wire type (`x-underlying-type`, with `Compression` meaning varint) and each enum's values (`x-enum-binary-value`). This skill turns them into draft classes. A version run reviews the drafts and applies them to `packages/bedrock-protocol`; codegen never writes into `packages/` itself.

Read `docs/lessons.md` first.

## Run

```
node tools/codegen/generate.js --all-new --from v1.26.50 --to v1.26.60 --out <dir>
node tools/codegen/generate.js --tag v1.26.60 --packet SetPassengerOfBlockPacket [--packet <Name> ...] --out <dir>
```

Without `--out`, drafts go to `codegen/<tag>` under the cache (`%LOCALAPPDATA%\pmmp-updater\cache`, or `PMMP_UPDATER_CACHE`). The output is laid out like the package's `src/`: packets at the top, payload types under `types/`.

## Read the report

| Section | Means |
|---|---|
| File list | Every draft. A file the package already has is named with its path there: compare, do not overwrite blindly. |
| `TODO(codegen)` markers | Every place the schema could not decide the code: variant types, maps, bit sets, unknown serialization options, unpublished enum values, a direction the schema does not state. Each marker is also in the draft. Resolve every one before applying a draft. |
| Registration | The `ProtocolInfo` constant, `PacketPool` line and `PacketHandlerInterface` method each new packet needs. |

## What the drafts decide and what they leave

- Known Mojang types use their `CommonTypes` helper: `ActorUniqueID`, `ActorRuntimeID`, `BlockPos`, `Vec3`, `Vec2`, `mce::UUID`.
- A field not in `required` is written with `CommonTypes::writeOptional`.
- A one-field wrapper type, such as `SignedAudioContent`, is read as its field.
- A field typed as another packet's payload embeds that packet class.
- Enums are int-backed with `PacketIntEnumTrait`. Class names are Mojang's, and every type goes into `types\`. Renaming, moving a type into a sub-namespace, or making a class non-final is a choice for whoever applies the draft.

## Check

`node --test "tools/codegen/test/*.test.js"` runs the fixture tests. `RIFTAL_LIVE=1` adds the ground truth: the 8 packets new in 1.26.60 are redrafted and compared with the hand-written classes, and every difference allowed is listed in the test's `TOLERATED` table.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

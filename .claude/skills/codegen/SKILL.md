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
| `TODO(codegen)` markers | Every place the schema could not decide the code, listed below. Each marker is also in the draft: on the class or enum it concerns, or above each read and write of the field. Resolve every one before applying a draft. |
| Registration | The `ProtocolInfo` constant, `PacketPool` line and `PacketHandlerInterface` method each new packet needs. |

## What the drafts decide and what they leave

- Known Mojang types use their `CommonTypes` helper: `ActorUniqueID`, `ActorRuntimeID`, `BlockPos`, `Vec3`, `Vec2`, `mce::UUID`.
- A field not in `required` is written with `CommonTypes::writeOptional`.
- A one-field wrapper type, such as `SignedAudioContent`, is read as its field.
- A field typed as another packet's payload embeds that packet class.
- An enum field with the `Enum-as-Value` serialization option goes on the wire as its binary value: an int-backed enum with `PacketIntEnumTrait`, cases from `x-enum-binary-value`, read and written in the width of `x-underlying-type`.
- An enum field without `Enum-as-Value` goes on the wire as its name (Mojang's developer note `r26u0/bug_1526431`): a string-backed enum with `PacketOrdinalEnumTrait`, cases valued by Mojang's names, read with `fromPacket(CommonTypes::getString(...))` and written with `CommonTypes::putString(..., ->value)`, as the package does for `PersonaSkinPieceType`. `x-underlying-type` is not used. Whether every such field really travels as a string is not yet verified against BDS: pmmp-updater#15 tracks the one 1.26.60 case where the package disagrees.
- Class names are Mojang's, and every type goes into `types\`. Renaming, moving a type into a sub-namespace, or making a class non-final is a choice for whoever applies the draft.

## Markers

Every `TODO(codegen)` marker the generator can emit:

| Marker | Where |
|---|---|
| unknown `x-serialization-options` | the field |
| a variant type (`oneOf`, `anyOf`, `allOf`), on the field or on the schema a `$ref` names | the field |
| a `$ref` with no schema in this tag | the field |
| a `$ref` or object with no properties, such as a map | the field |
| a `$ref` or field with no type in the schema | the field |
| no wire type for an integer or number's `x-underlying-type` | the field |
| `Compression` on a float or double, which has no varint form | the field |
| a boolean or string with serialization options | the field |
| an array with `No size compression`, whose length prefix is not a varint | the field |
| an array with `Compression`, such as a bit set | the field |
| an array with no `items` schema | the field |
| an array of embedded packets | the field |
| an optional embedded packet | the field |
| a packet's payload embedded outside a packet, where its payload methods are protected | the field |
| an enum under `Enum-as-Value` with no integer wire type | the field |
| an enum sent by name with serialization options, which the package has no pattern for | the field |
| one enum sent as its value in one field and as its name in another | the later field |
| an enum that allows unknown values (`Allow unknown enum values`), which `fromPacket` rejects | above each read and write of the field, which is drafted in full |
| enum values not published in `x-enum-binary-value`; index order assumed | the enum |
| field order not given by `x-ordinal-index`; schema order used | the class |
| a payload with no schema, or one that is not a plain object | the packet class |
| a direction the schema does not state | the packet class |

## Check

`node --test "tools/codegen/test/*.test.js"` runs the fixture tests. `RIFTAL_LIVE=1` adds the ground truth: the 8 packets new in 1.26.60 are redrafted and compared with the hand-written classes, call by call and field by field, and every difference allowed is listed in the test's `TOLERATED` table. A difference not yet verified on the wire, such as pmmp-updater#15, is printed as a `DIFFERS, unverified` diagnostic on every run.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

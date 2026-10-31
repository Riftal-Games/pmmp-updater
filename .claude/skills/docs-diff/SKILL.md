---
name: docs-diff
description: Compare two versions of Mojang's official Bedrock protocol docs and check the newer one against our packages - protocol number, added, removed and renumbered packets, packets changed on the wire, and Mojang's developer notes. Use to scope every protocol update, from the first preview.
when_to_use: A Mojang docs tag appeared (preview or release), /protocol-update starts, or someone asks what changed in a Bedrock version.
---

# Docs diff

Mojang publishes `Mojang/bedrock-protocol-docs` with a tag per release and per preview. Each tag holds a JSON schema for every packet and type, with the protocol number, the packet IDs, field order, wire types and enum values. This skill turns two tags into a work list.

Read `docs/lessons.md` first.

## Run

```
node tools/docs-diff/diff.js
```

With no arguments it compares the version our packages speak (`MINECRAFT_VERSION_NETWORK` in `packages/bedrock-protocol/src/ProtocolInfo.php`) against the newest Mojang tag, preview or release. Choose tags with `--from v1.26.60 --to v1.26.70-preview.22`. `--json` prints the full result.

The first run of a tag clones it sparsely into the cache (`%LOCALAPPDATA%\riftal-protocol\cache`, or `RIFTAL_PROTOCOL_CACHE`), a few seconds per tag. Never copy anything from the cache into this repository.

## Read the report

| Section | Means |
|---|---|
| Protocol | The number the server must advertise. Mojang's number is the truth for that tag. |
| Added packets | New classes to write. Each carries its ID and Mojang's one-line purpose. |
| Removed packets | Classes to delete, and any core code that sends or handles them. |
| Packet ID changes | Constants in `ProtocolInfo.php` to renumber. |
| Changed packets | Packets whose schema, or a type they reach, changed on the wire. The `via` list names the types to read. |
| Types | Wire changes and documentation-only changes, counted separately. A documentation-only change, such as Mojang starting to publish an enum's values, needs no code. |
| Developer notes | Mojang's own change list. Read every one: notes about block state permutations or hashed runtime IDs mean BedrockData and the upgrade schemas change too, which the schemas alone do not show. |
| Our packages | Whether our protocol matches the newer tag, packets with no class here, and IDs that differ from our `ProtocolInfo.php`. With `--from` at our version, this is the update's to-do list. |

## Check

`node --test "tools/docs-diff/test/*.test.js"` runs the fixture tests. `RIFTAL_LIVE=1` adds the live check that 1.26.50 to 1.26.60 is protocol 2193 to 2225 with the 8 packets known to be new.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

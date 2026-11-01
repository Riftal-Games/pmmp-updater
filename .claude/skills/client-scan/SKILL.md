---
name: client-scan
description: Read the Minecraft Bedrock client installed on this PC and report its version and protocol, the gap to our packages and to what pmmp-core builds, packet names our packages lack, and the vanilla content that changed. Use as the first check of every protocol update.
when_to_use: The Windows client auto-updated, a player cannot join after a client update, Nasir asks "are we behind", or /protocol-update starts.
---

# Client scan

The Windows client on this PC updates itself, usually before anyone notices. This skill reads its files (it never runs it) and says whether the server can still serve it.

Read `docs/lessons.md` first.

## Run

```
node tools/client-scan/scan.js
```

Needs Node 22 or later, which the host has. No dependencies. Flags: `--client <Content dir>` for another install (default `C:\XboxGames\Minecraft for Windows\Content`), `--offline` to skip Mojang's docs, `--no-save` to skip the snapshot.

It writes `tools/client-scan/snapshots/<game version>-<package version>.json`. Commit the snapshot with the version run, because the next scan diffs its packet names against it.

## What it reads

| Source | Gives |
|---|---|
| `MicrosoftGame.Config` and the exe's version resource | package version, for example `1.26.6005.0`, and file version `1.26.60.5` |
| Newest `data/behavior_packs/vanilla_<version>` | the game version. Each such pack holds only the definitions that changed in that version. |
| Mojang docs tag for that version | the client's protocol number, which the stripped binary does not reveal |
| `.rdata` and `.data` strings in `Minecraft.Windows.exe` | packet class names, compared with `packages/bedrock-protocol/src` |
| `__brarchive/*.brarchive` and `contents.json` in the newest packs | changed and newly introduced entities, items, recipes, structures, textures |
| `data/packetlimitconfig.json` | packet IDs the client rate-limits |
| `../pmmp-core/composer.lock` | what the checked-out pmmp-core branch actually builds |

## Read the verdict

- **CURRENT**: our packages speak the client's protocol and version.
- **CURRENT PROTOCOL**: same protocol number, different version. The boot test decides, because block and item data can differ under one protocol number.
- **CORE BEHIND**: our packages serve the client, but the pmmp-core checkout pins an older version. Players get what pmmp-core builds, so the update is not done until pmmp-core consumes these packages.
- **BEHIND**: the client speaks a newer protocol than our packages. Run `/protocol-update`.
- **CLIENT OLDER**: the client is older than our packages. Update the client, not the server.
- **UNKNOWN PROTOCOL**: Mojang's tag for the client's version names no protocol number. Read that tag's release notes.
- **UNKNOWN**: the client's version could not be read.
- **... BY VERSION**: Mojang's docs could not be reached, so only version strings were compared. Rerun online before acting.

## Read the lists

- **Client packet names with no class in our packages**: mostly client internals (`BadPacket`, `UnknownPacket`) and dropped packets (`AdventureSettingsPacket`). A name new since the previous snapshot is a packet we lack; confirm it with `/docs-diff`.
- **Changed entities, blocks, items**: hand to `riftal-game` for plugin impact. It is not a request for vanilla parity work.

## Check

`node --test "tools/client-scan/test/*.test.js"` runs the fixture tests on a synthetic client. Set `RIFTAL_LIVE_CLIENT` to a Content directory to also scan a real install.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

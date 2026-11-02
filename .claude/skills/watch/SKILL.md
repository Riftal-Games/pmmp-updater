---
name: watch
description: Check Mojang's protocol docs tags and the BDS download links for a Bedrock version newer than our packages, and file the update issue for it here, or comment on the open one when a newer preview or the release appears. Runs daily from the Watch workflow; run it by hand to see what it would do.
when_to_use: Someone asks whether a new Bedrock preview or release is out, the Watch workflow failed, or before /protocol-update to find its issue.
---

# Watch

A Bedrock release locks out every player who updates until the server speaks it, so the update starts at Mojang's first preview. This skill notices that preview the day it appears.

Read `docs/lessons.md` first.

## Run

```
node tools/watch/watch.js --dry-run
```

`--dry-run` prints what it would file or comment, with each body, and writes nothing to GitHub. Without it the tool files and comments through `gh`, which needs `GH_TOKEN` or a `gh auth login`. `--repo <owner/name>` targets another repository; the default is `GITHUB_REPOSITORY`, else `Riftal-Games/pmmp-updater`.

## What it reads

| Source | How | Gives |
|---|---|---|
| `Mojang/bedrock-protocol-docs` tags | `git ls-remote`, then a sparse clone into the cache of each tag that needs a diff | Version, preview number, protocol, and the docs-diff scope |
| BDS download links JSON | One HTTPS GET of the JSON. The zip is never downloaded | The Linux release and preview builds |
| `packages/bedrock-protocol/src/ProtocolInfo.php` | `MINECRAFT_VERSION_NETWORK` | The version we speak, which every tag is compared against |

A BDS preview build `1.26.70.22` is docs tag `v1.26.70-preview.22`; a release build `1.26.61.1` is `v1.26.61`.

## Read the output

| Line | Means |
|---|---|
| `FILE` | No issue exists for the version. It files one, labelled `owner:updater`, `route:steward`, `M1`, `prep`, plus `critical-path` for a release. |
| `COMMENT #<n>` | An open issue exists and a newer preview, the release or a BDS build ahead of the docs appeared. On a release it also adds `critical-path`. |
| `NOTHING` | Every new tag and build for the version is already on an issue. |
| `SKIP` | A newer tag whose protocol and schemas match ours, such as a hotfix. No update is needed. |
| `WARNING` | The BDS links API failed. Docs tags were still checked; the run exits 1. |

Every body it writes carries a marker, `<!-- watch:<tag> -->`, or `<!-- watch:bds:<tag> -->` for a BDS build Mojang's docs have no tag for yet. Markers make it idempotent: never edit or remove one. An issue filed by hand, such as #10, counts as covering a tag its body names in full. A closed issue covers its tags too; a new tag for a version whose only issue is closed files a new issue.

## Check

`node --test "tools/watch/test/*.test.js"` runs the tests against a fake `gh` and fixture docs; nothing reaches GitHub or Mojang. `RIFTAL_LIVE=1` adds the live check that the docs tags and the BDS links JSON still parse.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

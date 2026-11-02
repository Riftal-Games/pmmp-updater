# pmmp-updater

This repository owns the Minecraft Bedrock protocol for the RiftalGames server: the protocol and data libraries pmmp-core runs on, the tools that produce each new version of them, and the skills that drive those tools. It exists so that a Bedrock release never waits on a maintainer outside RiftalGames. Nasir decided this on 2026-11-01.

The design source of truth is `../docs/design-plan.md`. Hard rules 2 and 3 apply here most directly: one supported protocol version at a time, and protocol updates are priority one.

## Owns and never touches

| Owns | Never touches |
|---|---|
| `packages/`: our forks of BedrockProtocol, BedrockData, BedrockBlockUpgradeSchema, BedrockItemUpgradeSchema | Game logic of any kind. That lives in `riftal-game`. |
| `tools/`: client scan, Mojang docs diff, codegen, BDS extraction, watch, reverse engineering, verify | `pmmp-core/src/`. Core changes a protocol update needs are made there, through the steward. |
| `.claude/skills/`: the protocol update pipeline and its self-improvement loop | Deployment and rollout. That is `riftal-infra`. |
| `docs/`: lessons, incidents, one runbook per Bedrock version | |

## Rules

1. **Mojang's protocol docs are read, never committed.** `Mojang/bedrock-protocol-docs` is "all rights reserved, subject to the Minecraft EULA". Tools fetch it into a cache outside the repository. We commit our own code and short derived summaries, never their JSON.
2. **BDS is never committed or redistributed.** Downloading it accepts Mojang's EULA, which is Nasir's act. Tools download it into a cache or a container layer.
3. **Packages keep their upstream names** (`axolotl-pm/*`) until a steward-approved rename, because pmmp-core `src/CoreConstants.php` hardcodes the vendor paths. Licences stay with each package: BedrockProtocol is LGPL-3.0, the other three are CC0.
4. **Unreleased versions stay off `main`.** Preview work lives on `bedrock-<version>` branches until Mojang releases that version.
5. **Bytes are exact.** A Windows clone must run `git config core.autocrlf false` and `git config core.eol lf`, because the packages carry their own `* text=auto` attributes. Without it, the vendor tree pmmp-core builds stops matching the commit it claims.
6. **Every tool has a test** under its own `test/` that runs against fixtures, and CI runs it. A tool change without a test that would have caught the problem it fixes is not done.

## Layout

| Path | What |
|---|---|
| `packages/<name>/` | A fork, imported with `git subtree --squash`. The import commit names the upstream commit. |
| `tools/<tool>/` | Node 22 or later, no dependencies unless stated. `node --test "tools/**/*.test.js"` runs every test; `RIFTAL_LIVE=1` adds the checks against Mojang's published docs. |
| `.claude/skills/<skill>/SKILL.md` | Procedures. Each ends with the shared failure block. |
| `docs/lessons.md` | One line per lesson. Every skill reads it before doing anything. |
| `docs/incidents/` | One file per failure, `YYYY-MM-DD-<slug>.md`, from `skill-incident`. |
| `docs/versions/` | One runbook per Bedrock version: what was done, how long each stage took, downtime. |

## How pmmp-core consumes it

pmmp-core carries this repository as a submodule and resolves the four packages through composer `path` repositories, with `options.symlink: false` and `options.versions` giving each package its version. Until that switch-over lands, pmmp-core still resolves them from Packagist.

## Self-improvement

When a skill or tool fails, the run stops and follows `skill-incident`. The incident is recorded, the run is fixed, and a separate `lesson` PR updates the skill or script, adds a line to `docs/lessons.md` and adds a regression test. A fresh reviewer approves it; the author never does. No lesson PR may touch `CLAUDE.md`, `.claude/settings.json`, hooks or agent files, widen anyone's permissions, or delete a test. The same incident twice goes to the steward instead of a second patch.

## Branches and conventions

- `main` is the mainline. Never push to it, never force-push, never rebase published history.
- Working branches: `updater/<issue>-<slug>`. Lesson PRs: `updater/<issue>-lesson-<slug>`. Preview work: `bedrock-<version>`.
- Commits `<type>: <summary>` with `Refs #<issue>`. The PR description must contain `Closes #<issue>`. Squash merge.
- The comment rules in the root `CLAUDE.md` apply to every file here.

## Communication style

Direct and concise. Short points, minimal words.
Never use em dashes.
Answer what was asked. No unrequested analysis.
When you need a decision, ask one clear question with options.

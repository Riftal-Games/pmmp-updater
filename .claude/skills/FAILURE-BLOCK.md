# Shared failure block

Every SKILL.md in this repository ends with the block below, copied verbatim. `tools/skills-lint` checks that it is present and unchanged, so a skill cannot quietly drop its route to `/skill-incident`.

<!-- failure-block:start -->
## When this fails

Stop and follow `/skill-incident`. Do not retry blindly or work around the failure. Read `docs/lessons.md` first: the fix may already be known. Every failure ends in an incident file, and every new one in a reviewed lesson PR with a regression test.
<!-- failure-block:end -->

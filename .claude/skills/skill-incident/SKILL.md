---
name: skill-incident
description: What every skill and tool in pmmp-updater does when it fails - stop, record the incident, fix the run, then open a reviewed lesson PR that updates the skill or script and adds a regression test. Use whenever a step in any pmmp-updater skill fails or produces a result that contradicts another source.
when_to_use: A step fails, a tool errors, a verdict contradicts another source (for example the client scan and Mojang's docs disagree on a version), a stage runs over its time budget, or a skill's instructions turned out to be wrong.
---

# Skill incident

The pipeline gets better only if every failure leaves something behind that stops it happening again unnoticed. This is that procedure. Follow it in order. It is deliberately the same for every skill.

## 1. Stop

Do not retry the failing step blindly, and do not route around it with a different command. A retry that happens to pass hides the cause; a workaround becomes an undocumented second procedure.

Retry once only when the failure is plainly transient and outside us: a network timeout, a GitHub API 5xx, a rate limit. Note the retry in the incident anyway.

## 2. Check whether it is known

Read `docs/lessons.md` and search `docs/incidents/` for the symptom.

- **Known, and the lesson says what to do:** do it, then continue. If the lesson's fix did not work, this is a repeat. Go to step 7.
- **Not known:** continue to step 3.

## 3. Record

Copy `docs/incidents/TEMPLATE.md` to `docs/incidents/<YYYY-MM-DD>-<slug>.md` and fill in symptom and evidence now, before investigating. Evidence written after the fix tends to describe the fix, not the failure.

The incident file is committed in the lesson PR of step 6, never in the run's PR. A PR that touches `docs/incidents/` or `docs/lessons.md` is judged as a lesson, and a run's PR edits `packages/`, which a lesson may not. Until step 6, keep the file uncommitted, and link it from the version runbook by its path.

## 4. Find the cause

Investigate until you can state why it happened, or until you can say what you ruled out. Use the real files and real output. If the cause is outside this repository (pmmp-core, the client, BDS, Mojang's docs), say which and stop at what this repository can change.

## 5. Fix the run

Make the smallest change that lets the current run continue, on the run's working branch. Fill in the incident's "Fix for this run" section. Continue the original skill.

The bounds below apply to this fix too. A run fix that needs a protected path, a deleted test or a widened permission is not a run fix; stop and hand it to the steward.

## 6. Change the pipeline

Separately from the run, so the run's PR stays about the version and the lesson stays reviewable on its own:

1. File an issue in `Riftal-Games/pmmp-updater` labelled `lesson`, `owner:updater`, `route:loop`, linking the incident.
2. Branch `updater/<issue>-lesson-<slug>` from `main`.
3. Change what failed: the SKILL.md step that was wrong or missing, or the script that broke.
4. Add a regression test or fixture under the tool's `test/` that fails without the change and passes with it. For a pure instruction change with no code, add the check to the skill's own steps as an explicit command whose output proves the condition.
5. Add one line to `docs/lessons.md`: the date, what to do, and a link to the incident.
6. Open the PR with `Closes #<issue>`. A fresh `reviewer` reviews it and the `approver` merges it, through the normal pipeline. You never approve your own lesson.

## 7. Repeat incidents go to the steward

If this symptom already has an incident and a merged lesson, the lesson did not hold. Do not write a second patch. Record the repeat in a new incident file that links the first, and hand it to the steward with both incident files. The steward decides whether the approach itself is wrong.

The repeat incident file lands in a PR of its own that changes nothing else, so it passes the lesson guard. The steward decides the fix, and an implementer writes it in a separate PR that does not touch `docs/incidents/` or `docs/lessons.md`. The steward merges that PR, because it will usually touch a protected path, which fails the guard.

## Bounds

A lesson PR may change skills under `.claude/skills/`, tools under `tools/`, their tests and fixtures, and `docs/`, except the protected paths below. It may not:

- touch a protected path. These are the rules that bound lessons, so a lesson changing them would be loosening its own limits:
  - `CLAUDE.md` or `CLAUDE.local.md` here or anywhere, `.gitattributes` and `.gitignore` anywhere, `.mcp.json`, `.claude/settings.json`, `.claude/hooks/`, `.claude/agents/`, `.claude/commands/`;
  - `.claude/skills/skill-incident/` (this file) and `.claude/skills/FAILURE-BLOCK.md`;
  - `tools/skills-lint/`, `tools/lesson-guard/` and `tools/test-support/`, which enforce them or every test depends on;
  - `.github/`, which runs the enforcement;
  - `packages/`.

  Write a `needs an issue:` line for the steward instead. A change to any of them is a steward decision, and one that widens a power goes to the two-instance panel the root contract requires;
- widen what any skill, agent or tool is allowed to do;
- change an existing test file in any way, which includes every file under a `test/` directory. A lesson adds its regression test in a new `*.test.js` file. A test whose expectation is wrong is corrected in a steward-merged PR, not by a lesson. Weakening a test to make a run pass is a hard stop for Nasir;
- weaken a fixture;
- delete or rename any file.

Package changes belong to a version run, never a lesson.

CI is a backstop for these rules, not a proof. The `Lesson guard` workflow runs on `pull_request_target`, so it always uses the base branch's copy of itself and of `tools/lesson-guard`, and it never runs the PR's code. It treats a PR as a lesson when any of these holds, in any letter case:

- the branch name contains `-lesson-`;
- the PR carries the `lesson` label;
- the PR touches `docs/lessons.md` or `docs/incidents/`.

It fails such a PR when:

- the PR touches a protected path, in any letter case;
- the PR deletes a file. A rename counts as a deletion;
- the PR changes a `*.test.js` file or any file under a `test/` directory that already existed, so a helper or fixture cannot be weakened either.

It fails every other PR that touches a protected path other than `packages/`, with a message that it needs a steward merge. Version runs change `packages/`, so that path is judged only for lessons.

These bounds have no mechanical check, and only the reviewer reading the diff enforces them:

- the rest of the run fix in step 5, because run PRs are not lessons and the guard judges only their protected paths;
- not widening what a skill, agent or tool may do;
- not weakening a fixture kept outside a `test/` directory;
- not weakening assertions by other means, such as non-test code that patches `node:assert` or the code under test so a new test passes vacuously.

A PR that touches a protected path is a steward merge, whoever opened it and whatever its branch is called.

## Budgets that trigger an incident

A stage that runs over its budget is an incident even if it eventually passed, because the budget is how the 1-day downtime target holds.

| Stage of `/protocol-update` | Budget |
|---|---|
| Detect | 30 minutes from the watch issue |
| Release-day diff and codegen | 2 hours |
| BDS data dump and upgrade schemas | 3 hours |
| Verify | 2 hours |
| Mojang release to merged image | 1 day |

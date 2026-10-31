---
name: skill-incident
description: What every skill and tool in riftal-protocol does when it fails - stop, record the incident, fix the run, then open a reviewed lesson PR that updates the skill or script and adds a regression test. Use whenever a step in any riftal-protocol skill fails or produces a result that contradicts another source.
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

## 4. Find the cause

Investigate until you can state why it happened, or until you can say what you ruled out. Use the real files and real output. If the cause is outside this repository (pmmp-core, the client, BDS, Mojang's docs), say which and stop at what this repository can change.

## 5. Fix the run

Make the smallest change that lets the current run continue, on the run's working branch. Fill in the incident's "Fix for this run" section. Continue the original skill.

## 6. Change the pipeline

Separately from the run, so the run's PR stays about the version and the lesson stays reviewable on its own:

1. File an issue in `Riftal-Games/riftal-protocol` labelled `lesson`, `owner:protocol`, `route:loop`, linking the incident.
2. Branch `proto/<issue>-lesson-<slug>` from `main`.
3. Change what failed: the SKILL.md step that was wrong or missing, or the script that broke.
4. Add a regression test or fixture under the tool's `test/` that fails without the change and passes with it. For a pure instruction change with no code, add the check to the skill's own steps as an explicit command whose output proves the condition.
5. Add one line to `docs/lessons.md`: the date, what to do, and a link to the incident.
6. Open the PR with `Closes #<issue>`. A fresh `reviewer` reviews it and the `approver` merges it, through the normal pipeline. You never approve your own lesson.

## 7. Repeat incidents go to the steward

If this symptom already has an incident and a merged lesson, the lesson did not hold. Do not write a second patch. Record the repeat in a new incident file that links the first, and hand it to the steward with both incident files. The steward decides whether the approach itself is wrong.

## Bounds

A lesson PR may change skills under `.claude/skills/`, tools under `tools/`, their tests and fixtures, and `docs/`. It may not:

- touch `CLAUDE.md` here or anywhere, `.claude/settings.json`, `.claude/hooks/`, or any agent definition. Write a `needs an issue:` line for the steward instead;
- widen what any skill, agent or tool is allowed to do;
- delete or weaken a test or fixture to make a run pass. That is a hard stop for Nasir;
- edit `packages/` to make a tool's output match. Package changes belong to a version run, not a lesson.

## Budgets that trigger an incident

A stage that runs over its budget is an incident even if it eventually passed, because the budget is how the 1-day downtime target holds.

| Stage of `/protocol-update` | Budget |
|---|---|
| Detect | 30 minutes from the watch issue |
| Release-day diff and codegen | 2 hours |
| BDS data dump and upgrade schemas | 3 hours |
| Verify | 2 hours |
| Mojang release to merged image | 1 day |

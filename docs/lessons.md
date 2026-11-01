# Lessons

Read this before running any skill in this repository. One line per lesson, newest last, each linking the incident it came from. A lesson that no longer applies is deleted in a lesson PR, not left to rot.

- 2026-11-01: A Windows clone checks the packages out with CRLF, because their own `.gitattributes` say `text=auto`. Set `core.autocrlf false` and `core.eol lf` in every clone. No incident file: found while bootstrapping, #1.
- 2026-11-01: The global git excludes on Nasir's machine ignore `CLAUDE.md` and `.claude/`. This repository's `.gitignore` re-includes them; after changing a skill, check `git status` lists it before committing. Found while bootstrapping, #1.
- 2026-11-01: The whole clone vanished from `riftal-games/` mid-run, untracked in the root repository, which riftal-pm#1604 says gets cleaned of untracked files by an unknown process. Until the root `.gitignore` lists this repository (riftal-pm#1854), keep `pmmp-updater/` in the root's `.git/info/exclude`, and push work early: unpushed commits are what get lost. Found while bootstrapping, #1.

# Lessons

Read this before running any skill in this repository. One line per lesson, newest last, each linking the incident it came from. A lesson that no longer applies is deleted in a lesson PR, not left to rot.

- 2026-11-01: A Windows clone checks the packages out with CRLF, because their own `.gitattributes` say `text=auto`. Set `core.autocrlf false` and `core.eol lf` in every clone. No incident file: found while bootstrapping, #1.
- 2026-11-01: The global git excludes on Nasir's machine ignore `CLAUDE.md` and `.claude/`. This repository's `.gitignore` re-includes them; after changing a skill, check `git status` lists it before committing. Found while bootstrapping, #1.

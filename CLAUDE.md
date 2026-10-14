# CLAUDE.md

The canonical instructions for all AI agents are in [AGENTS.md](AGENTS.md) and are imported
below. This file only adds a short summary; if anything here conflicts with `AGENTS.md`,
`AGENTS.md` wins.

@AGENTS.md

## Summary of the mandatory `.ai/` workflow

- `.ai/specs/` — SDD specifications named `YYYY-MM-DD-slug.md`; verified specs move to
  `.ai/specs/implemented/`, deprecated ones to `.ai/specs/archive/`. Index: `.ai/specs/README.md`.
- `.ai/runs/` — one log per autonomous run, `YYYY-MM-DD-slug.md`, created at the start and
  finalised before you finish.
- `.ai/lessons.md` + `.ai/lessons/YYYY-MM-DD-slug.md` — durable lessons; read before work, add
  one after fixing a non-obvious bug or learning a constraint.
- `.ai/decisions/` — ADRs for significant design decisions.
- `.ai/templates/` — templates for specs, proposals, run logs and lessons.

Every task: read specs and lessons first → spec before significant code → tests and quality gate →
update implementation status only after verification → record lessons → finalise the run log →
commit on a feature branch with Conventional Commits and open a PR with `gh`.

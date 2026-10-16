# D04 — Skills are read from project repositories; that is the product's premise

- Date, owner: 2026-10-16, Mateusz Minkiewicz (maintainer)
- Context and the options weighed: the agent found that many skills on the maintainer's machine
  sit in `~/.claude/skills`, which SPEC-102 §3 puts out of scope, and asked where the skills the
  maintainer updates for client projects live.
- Decision and why: the maintainer's words (translated from Polish): "in the projects'
  repositories, and that should be the premise of this application — pulling skills etc. from the
  repo and testing them."
- Consequences, and what would make us revisit it: the Registry as roadmap M1 specifies it
  (repositories and local directories) covers the skills the maintainer updates; no spec change
  is needed for Now.
- Status: active
- Origin: the maintainer's answer to an extra question asked after the three planned rounds.

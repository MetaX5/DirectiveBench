# D05 — User-level skill folders are an opt-in option, off by default

- Date, owner: 2026-10-16, Mateusz Minkiewicz (maintainer)
- Context and the options weighed: the agent asked whether Now should include user-level folders
  such as `~/.claude/skills` (including claude.ai-synced skills), which SPEC-102 §3 lists as
  "future, opt-in only".
- Decision and why: the maintainer's words (translated from Polish): "we can do it as an
  additional option, off by default. It could serve to check how the user's global skills
  interact with a given project/repo."
- Consequences, and what would make us revisit it: consistent with SPEC-102 §3 as written. The
  stated purpose is about testing interaction, so the brief places it with the comparison work
  (Later); that placement is the agent's reading of the answer, not an explicit choice by the
  maintainer.
- Status: active (opt-in, off by default, purpose); placement: proposal.
- Origin: the maintainer's answer to an extra question asked after the three planned rounds.

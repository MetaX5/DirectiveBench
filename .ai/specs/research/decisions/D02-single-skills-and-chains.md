# D02 — Benchmarking must cover single skills and chains of skills

- Date, owner: 2026-10-15, Mateusz Minkiewicz (maintainer)
- Context and the options weighed: the agent asked whether "checking that our own flow works"
  meant one skill at a time or a chain of skills that hand work to each other (for example an
  issue → spec → PR pipeline).
- Decision and why: both ("oba przypadki" — "both cases").
- Consequences, and what would make us revisit it: chains of skills are not specified today;
  SPEC-112 lists multi-artifact candidates only as future work. Benchmarking chains needs its own
  spec before it can be planned. Placement after the Registry follows from D01.
- Status: active
- Origin: the maintainer's answer to a clarifying question.

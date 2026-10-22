# D08 — The comparison work goes next; the rest of the Registry waits

- Date, owner: 2026-10-22, Mateusz Minkiewicz (maintainer)
- Context and the options weighed: after using 0.1.1-rc.0 on 2026-10-22 (register, scan, browse,
  preview — the D07 slice) the maintainer said the preview is nice but the product's main job is
  benchmarking skills and building one's own benchmarks, and that today it has no other use. That
  answers the D07 value checkpoint early: the Registry alone does not carry the product (A02).
  Options discussed in the brainstorm
  ([brief](../../briefs/2026-10-22-benchmark-own-skills-s1.md)): build nothing (a YAML file, a
  shell loop over `claude -p` and a diff script), try Promptfoo first (A04, #26), a builder first,
  no-skill vs skill only with A/B later, or a real-agent comparison including version-vs-version.
- Decision and why: switch from the Registry (D01) to the comparison work now; the remaining E02
  stories (#20, #21) and categories (E03, #22) wait. The first slice (S1, SPEC-118) is Claude Code
  running a user's suite against a scanned artifact version, with the baseline either no artifact
  or another version of the same artifact. The work is generic: users build their own scenarios,
  requirements and grading; a project-estimation skill is only the reference scenario.
  Rejected: building nothing — no history per skill version, no comparability guarantees and no
  binding to the catalogue, which the maintainer named as the product's value; a builder first —
  on the mock agent it produces no real result; deferring A/B — for a skill under revision the
  real question is "is v(n) better than v(n-1)?".
  Promptfoo (A04) is consciously skipped, not tested: DirectiveBench binds benchmarks to skills
  scanned from repositories, keeps results per skill version, will offer a builder UI (also for
  non-developers) and runs as one local tool without provider configuration.
- Consequences, and what would make us revisit it: SPEC-118 (S1) is next, then S2 (builder and
  running from the UI) and S3 (chains of skills, D02; LLM-judge grading). D01 is superseded; D07's
  checkpoint is answered and A02 is answered against the Registry-alone premise. A04 stays
  untested, so DirectiveBench may still duplicate parts of Promptfoo. D03 still has no metric (Q05).
  Revisit if S1 runs do not help the maintainer decide whether a skill revision is better, or if
  results under Claude Code do not transfer to the harness that runs the skill in practice.
- Status: active
- Origin: the maintainer's statement after using 0.1.1-rc.0 and the choices made in the
  2026-10-22 brainstorm; the S1/S2/S3 split and the rejected alternatives were worked out in that
  conversation and recorded in the brief.

# Project estimate document — specification-only example

**Status: specification only.** `benchmark.yaml` validates against the schema, and its three
document assertions are evaluated against the sample documents in [`documents/`](documents/) by
the benchmark engine's unit tests. Running the suite needs the planned `claude-code` adapter and
`directivebench benchmark run` ([SPEC-118](../../../.ai/specs/2026-10-22-benchmark-own-skills-s1.md)
Phases 3 and 4).

This is the reference scenario of SPEC-118 §8.4: a skill that turns a project brief into a
Markdown estimate. It is illustrative only — the assertion types are generic and grade any
Markdown document an agent writes.

## Fixture (`./fixture`)

`brief.md` — a short project brief the agent estimates.

## Assertions

| Id | Type | Checks |
| --- | --- | --- |
| `structure` | `markdown-sections` | Headings "Assumptions", "Estimate" and "Risks", in that order (ATX or setext, any level; fenced code does not count). |
| `mentions-qa-and-pm` | `required-phrases` | The literal `QA`, and project management as the pattern `project manag\|PM\b` (case-insensitive). |
| `backend-hours-realistic` | `markdown-table-value` | The "Hours" cell of the first table row whose first cell matches `Backend API` is between 16 and 40 (weight 3). |

`file: "**/*.md"` selects the one Markdown file the agent added or modified; zero or several
matches fail the assertion with the list of matches.

## Sample documents (`./documents`)

- `estimate-passing.md` passes all three assertions.
- `estimate-failing.md` fails all three: "Risks" occurs only inside a fenced code block and the
  headings are out of order, QA and project management are not mentioned, and the backend
  estimate (80 hours) is outside the range.

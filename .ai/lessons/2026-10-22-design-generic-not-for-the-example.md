---
title: A concrete example is a reference scenario, not the design target — build generic capabilities
date: 2026-10-22
tags: [product, specs, design]
source: .ai/runs/2026-10-22-benchmark-own-skills-s1-spec.md
---

# A concrete example is a reference scenario, not the design target — build generic capabilities

## Context

While shaping the benchmark comparison work (S1, SPEC-118) the maintainer described a
project-estimation skill whose output is a Markdown file with prose and tables. The conversation
drifted towards estimation-specific grading (checks for hours, QA and PM lines). The maintainer
corrected it: DirectiveBench must let users build their own scenarios, requirements and grading;
the estimation skill is only an example to check that the design is sufficient.

## Lesson

When a user's concrete case comes up (one skill, one client, one document type), extract the
generic capability it needs — here: Markdown headings, required phrases, a table value in a range,
a target file found by glob — and use the case only as a reference scenario to test the design.
Never add names, fields, defaults or UI copy that only make sense for that case.

## How to apply

- In specs, put the concrete case in an "illustrative only" example and state that nothing in the
  product knows about it (SPEC-118 §8.4).
- Review every new field, assertion type, flag and label with the question "would a user with a
  different skill need this unchanged?" If not, generalise it or leave it out.
- Prefer composable primitives (several small assertions with weights) over one assertion shaped
  like the example's output.

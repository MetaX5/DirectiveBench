---
title: First real D03 check, wp-block-development v3 against v2 and against no skill
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (D03/Q05 cheap check approved 2026-10-29)
status: completed
branch: docs/d03-check-wp-block-development
specs: [SPEC-118]
---

# Run: First real D03 check, wp-block-development v3 against v2 and against no skill

## Objective

This was the cheap D03 check that SPEC-118 §18 suggests. Two realistic briefs were run with the
real Claude Code against two versions of one skill. The goal was to see whether DirectiveBench's
verdict tells the versions apart, and whether a human would agree. The maintainer chose an
actively maintained public skill: `wp-block-development` from WordPress/agent-skills. The tasks
were Gutenberg blocks. The maintainer's criteria were how the work went, code quality, the
solutions used and alignment with the latest WordPress.

## Plan

- Register a local clone of WordPress/agent-skills in the UI. Scan it at `95e374f` (artifact v2)
  and rescan it at `ad7156c` (v3, "Update wp-block-development skill for WordPress 6.9 apiVersion
  3"). The diff adds an "Ensure apiVersion 3" section and adds to two references.
- The first scanned commit, `8356b20`, became v1. It was not used: its frontmatter is not valid
  YAML (an unquoted colon), and both the scanner and FR-118-26 reject it.
- Scaffold a suite with `benchmark init` and replace its case with two cases (suite in the
  appendix):
  1. `new-dynamic-block`: a new server-rendered "Featured posts" block plugin.
  2. `extend-existing-block`: make an existing static block with `apiVersion: 2`, used on about
     400 published pages, dismissible, and bring it up to current standards.
- Grading was deterministic: apiVersion 3, `$schema`, `render` in block.json, metadata
  registration, `get_block_wrapper_attributes`, escaping, `no_found_rows`, a deprecation, an
  accessible close button and `viewScriptModule`.
- Two runs with 3 repetitions each: `--baseline v2` and `--baseline none`. That is 24 sessions in
  Local Subscription Mode, with the edit-only profile.
- Hypothesis recorded before the run: v3 sets apiVersion 3 more often than v2, especially in case
  2. Everything else should be about equal.

## Decisions

- Commit `95e374f` was used as the earlier version instead of `8356b20`, because `8356b20` has
  invalid frontmatter.
- The suite stayed unchanged between the two runs after the deprecation assertion showed false
  failures, so the two runs stay comparable. A score without that assertion was computed
  separately.

## Work performed

1. `directivebench init` and `serve` on a fresh data directory in the scratchpad. The repository
   was registered and scanned three times through the UI (Claude in Chrome).
2. `benchmark init --artifact wp-block-development`, then the cases were written. A run without
   `--yes` and without a TTY printed the plan and refused to start (as specified).
3. `benchmark run … --artifact-version 3 --baseline v2 --yes --json`: `run_5vR9G7vctEeBOibk`.
4. `benchmark run … --artifact-version 3 --baseline none --yes --json`: `run_kA9HPpy69K8BrTPJ`.
5. Per-assertion results were read from SQLite, and failed runs were checked against the tool
   calls in their traces.

## Verification

| Run | Baseline | Baseline score | Candidate score | Delta | Display status | Skill invoked (cand./base.) |
| --- | --- | --- | --- | --- | --- | --- |
| `run_5vR9G7vctEeBOibk` | v2 | 93.3% | 91.5% | -1.9 pts | Unstable (medium) | 6/6, 6/6 |
| `run_kA9HPpy69K8BrTPJ` | none | 88.1% | 88.1% | 0 pts | Unstable (medium) | 6/6, 0/6 |

All 24 agent runs completed with no errors and no `not-comparable` issue. Every run used the
execution model `claude-opus-5-5`, chosen by the CLI because the suite did not pin a model.
Sessions took about 60 s each. Both runs appear under v3 on the artifact page ("Results by
version", one comparability group), with the baseline, the agent profile and the
ambient-configuration warning.

Without the flawed deprecation assertion, the scores are 95.8% vs 94.0% (v3 vs v2) and 94.0% vs
94.0% (v3 vs none).

Per assertion, every variant passed every check every time, with these exceptions:

| Check | v3 | v2 | none |
| --- | --- | --- | --- |
| `viewScriptModule` (case 2) | 2/6 | 0/3 | 0/3 |
| `aria-label` on the close button | 4/6 | 3/3 | 3/3 |
| `esc_url` in render.php | 4/6 | 3/3 | 2/3 |
| `deprecated` registered (case 2) | 3/6 | 2/3 | 1/3 |

(v3 appears in both runs, so its column covers 6 runs per case. The v2 and none columns cover 3
runs each.)

Findings:

- **The hypothesis was refuted.** Every variant set apiVersion 3 in every run, without the skill
  too. `claude-opus-5-5` already knows what the v3 change teaches. Neither run shows a difference
  that DirectiveBench or a reader could attribute to the skill. The verdict "unstable" with about
  0 delta is the correct answer for this data, and the tool did not invent a difference.
- **The suite has a ceiling effect.** The tasks are too easy for the model, so these checks
  cannot tell the versions apart. A discriminating suite needs tasks where the model without the
  skill fails measurably.
- **An assertion produced false failures.** `deprecation-registered` failed 6 of 12 runs of
  case 2. In both failed runs whose traces were checked (baseline-2 and candidate-3 of the v2
  run), the agent kept the saved markup byte-identical while `dismissible` is off. That is a
  valid way to keep the 400 published blocks valid. The other 4 were not checked. See the
  lesson.
- **The output cannot be reviewed by a human.** Agent workspaces are deleted after the run, and
  tool-call inputs in the trace are truncated (about 2,000 characters), so the files the agent
  wrote cannot be rebuilt. The blind comparison with the maintainer's own judgement that D03
  needs is therefore not possible today. This was not verified further.

Not verified: API Key Mode; a pinned model; the maintainer's blind review (blocked by the
missing output files).

## Problems and deviations

- Planned blind A/B review by the maintainer: not done (outputs not retained, see above).
- An attempt to rebuild outputs from the traces failed on truncated JSON inputs.

## Lessons recorded

- [A deterministic assertion must check the outcome, not one way of reaching it](../lessons/2026-10-29-assert-outcomes-not-one-solution.md)

## Follow-ups

- Proposal: keep each agent run's changed files (bounded, redacted, local) and show them on the
  run page, or offer a `--keep-workspaces` option. This is needed for the human side of D03.
- D03/Q05 (#31): the metric must include a discrimination check, meaning the suite must separate
  "no skill" from "skill" before version verdicts mean anything.
- Repeat with a harder or less well-known task, or a skill the model does not already know (for
  example the maintainer's own internal-tool skill, OQ-118-02).
- #93 "Done when" was exercised for real (CLI with Claude Code, both baselines, both runs on the
  artifact page). Closing it is the maintainer's call.

## Appendix: suite

The fixtures were two `README.md` briefs, plus for case 2 a minimal plugin (`acme-notice.php`,
`package.json`, `blocks/notice/src/{block.json,index.js,edit.js,save.js,style.scss}` with
`apiVersion: 2` and static `save`).

```yaml
# D03 check (2026-10-29): does the WordPress/agent-skills wp-block-development skill change
# measurably between 95e374f (v2) and ad7156c (v3, "apiVersion 3 for WordPress 6.9")?
# Two realistic client briefs; graded deterministically on current-WordPress block practice.
schemaVersion: 1
id: wp-block-development-benchmark
name: "wp-block-development: Gutenberg block briefs"
description: >-
  Build a new server-rendered block plugin and extend an existing static block used on
  published pages. Graded on block.json conventions for current WordPress, registration,
  escaping, block validation (deprecations) and accessibility.
technologies: [wordpress, gutenberg, php, javascript]
artifactTypes: [skill]
execution:
  agent: claude-code
  model: null
  repetitions: 3
  timeoutSeconds: 900
cases:
  - id: new-dynamic-block
    name: New server-rendered "Featured posts" block plugin
    prompt: |
      Read README.md and implement the brief in this folder. Use the WordPress block development
      skill if you have one.
    fixture:
      path: fixtures/new-dynamic-block
    assertions:
      - id: block-json-exists
        type: file-exists
        path: src/featured-posts/block.json
        required: true
      - id: api-version-3
        description: WordPress 6.9 expects apiVersion 3 (iframed editor)
        type: file-contains
        path: src/featured-posts/block.json
        pattern: '"apiVersion"\s*:\s*3\b'
        weight: 3
      - id: schema-reference
        type: file-contains
        path: src/featured-posts/block.json
        pattern: '"\$schema"\s*:\s*"https://schemas\.wp\.org/'
      - id: render-in-metadata
        description: dynamic rendering declared in block.json, not a PHP render_callback
        type: file-contains
        path: src/featured-posts/block.json
        pattern: '"render"\s*:\s*"file:\./render\.php"'
        weight: 2
      - id: attributes-and-supports
        type: required-phrases
        file: src/featured-posts/block.json
        phrases:
          - '"postsToShow"'
          - '"displayExcerpt"'
          - { pattern: '"align"\s*:\s*\[[^\]]*"wide"[^\]]*"full"|"align"\s*:\s*\[[^\]]*"full"[^\]]*"wide"' }
          - '"color"'
          - '"spacing"'
          - '"textdomain"'
        weight: 2
      - id: render-wrapper-attributes
        type: file-contains
        path: src/featured-posts/render.php
        pattern: 'get_block_wrapper_attributes\s*\('
        weight: 2
      - id: render-escapes-output
        type: required-phrases
        file: src/featured-posts/render.php
        phrases: [esc_url, { pattern: 'esc_html|wp_kses_post' }]
        weight: 2
      - id: efficient-query
        description: no pagination count query for a fixed list
        type: file-contains
        path: src/featured-posts/render.php
        pattern: no_found_rows
      - id: edit-uses-block-props
        type: required-phrases
        file: src/featured-posts/edit.js
        phrases: [useBlockProps, InspectorControls]
      - id: metadata-registration
        type: file-contains
        path: acme-featured-posts.php
        pattern: 'register_block_type(_from_metadata)?\s*\(|wp_register_block_(types_from_metadata_collection|metadata_collection)\s*\('
        weight: 2
      - id: no-build-output
        type: changed-files
        forbidden: ['build/**', 'node_modules/**']

  - id: extend-existing-block
    name: Make an existing published block dismissible without breaking saved content
    prompt: |
      Read README.md and implement the brief in this folder. Use the WordPress block development
      skill if you have one.
    fixture:
      path: fixtures/extend-existing-block
    assertions:
      - id: api-version-3
        description: brief asks to bring the block up to current standards (WordPress 6.9)
        type: file-contains
        path: blocks/notice/src/block.json
        pattern: '"apiVersion"\s*:\s*3\b'
        weight: 3
      - id: schema-reference
        type: file-contains
        path: blocks/notice/src/block.json
        pattern: '"\$schema"\s*:\s*"https://schemas\.wp\.org/'
      - id: dismissible-attribute
        type: file-contains
        path: blocks/notice/src/block.json
        pattern: '"dismissible"\s*:\s*\{[^}]*"type"\s*:\s*"boolean"'
        flags: s
        weight: 2
        required: true
      - id: deprecation-registered
        description: changed save markup needs a deprecation, or 400 pages show invalid blocks
        type: file-contains
        path: blocks/notice/src/index.js
        pattern: '\bdeprecated\b'
        weight: 3
      - id: save-markup
        type: required-phrases
        file: blocks/notice/src/save.js
        phrases: [acme-notice__close, is-dismissible]
        weight: 2
      - id: accessible-close-button
        type: required-phrases
        file: blocks/notice/src/save.js
        phrases: [{ pattern: 'type\s*=\s*"button"' }, aria-label]
      - id: sidebar-toggle
        type: file-contains
        path: blocks/notice/src/edit.js
        pattern: ToggleControl
      - id: frontend-script-module
        description: the close button needs front-end code; current practice is viewScriptModule
        type: file-contains
        path: blocks/notice/src/block.json
        pattern: '"viewScriptModule"'
      - id: no-build-output
        type: changed-files
        forbidden: ['blocks/notice/build/**', 'node_modules/**']
```

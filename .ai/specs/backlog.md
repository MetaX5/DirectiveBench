# Backlogs

One section per backlog source, written by `om-backlog`. The tracker is the authority; this file
keeps the source-to-issue map and reserved ids.

## .ai/specs/product-brief.md

Backlog source: .ai/specs/product-brief.md
Last filed: 2026-10-16

| Id | Issue | Title | Parent | Depends on | Adopted |
|---|---|---|---|---|---|
| E01 | [#10](https://github.com/MetaX5/DirectiveBench/issues/10) | See the skills from my project repositories in one place | — | — | no |
| E01-S01 | [#15](https://github.com/MetaX5/DirectiveBench/issues/15) | A skill author can register a local project repository by path and sees it in the Repositories list | #10 | — | no |
| E01-S02 | [#16](https://github.com/MetaX5/DirectiveBench/issues/16) | Scanning a registered repository discovers its skills, instructions and rules | #10 | E01-S01 (#15) | no |
| E01-S02-T01 | [#23](https://github.com/MetaX5/DirectiveBench/issues/23) | Recompute content hashes server-side before storing repository content | #16 | — | no |
| E01-S02-T02 | [#24](https://github.com/MetaX5/DirectiveBench/issues/24) | Repository tree walker (discoverArtifacts) | #16 | — | no |
| E01-S03 | [#17](https://github.com/MetaX5/DirectiveBench/issues/17) | A skill author browses all discovered artifacts in one place and previews their content | #10 | E01-S02 (#16) | no |
| E01-S04 | [#18](https://github.com/MetaX5/DirectiveBench/issues/18) | A skill author can add a public GitHub repository by URL and sees its skills without any credentials | #10 | E01-S02 (#16), E01-S04-T01 (#25) | no |
| E01-S04-T01 | [#25](https://github.com/MetaX5/DirectiveBench/issues/25) | Update SPEC-105 to fetch only candidate paths (resolve OQ-105-04) | #18 | — | no |
| E02 | [#11](https://github.com/MetaX5/DirectiveBench/issues/11) | Keep the catalogue current as repositories change | — | — | no |
| E02-S01 | [#19](https://github.com/MetaX5/DirectiveBench/issues/19) | A rescan creates new versions only for changed content | #11 | E01-S02 (#16) | no |
| E02-S02 | [#20](https://github.com/MetaX5/DirectiveBench/issues/20) | The same skill in two repositories shows as one artifact with two occurrences | #11 | E02-S01 (#19) | no |
| E02-S03 | [#21](https://github.com/MetaX5/DirectiveBench/issues/21) | Removed files are marked missing and their history is kept | #11 | E02-S01 (#19) | no |
| E03 | [#12](https://github.com/MetaX5/DirectiveBench/issues/12) | Organise the catalogue with categories | — | — | no |
| E03-S01 | [#22](https://github.com/MetaX5/DirectiveBench/issues/22) | A skill author creates, renames and archives categories and assigns them to artifacts | #12 | E01-S03 (#17), E04-T03 (#30) | no |
| E04 | [#13](https://github.com/MetaX5/DirectiveBench/issues/13) | Discovery: check the riskiest assumptions before the comparison work | — | — | no |
| E04-T01 | [#26](https://github.com/MetaX5/DirectiveBench/issues/26) | Find out what Promptfoo already answers for the maintainer's skills (A04) | #13 | — | no |
| E04-T02 | [#27](https://github.com/MetaX5/DirectiveBench/issues/27) | Find out whether PMs, developers and testers at the company have this problem (A01) | #13 | — | no |
| E04-T03 | [#30](https://github.com/MetaX5/DirectiveBench/issues/30) | Value checkpoint: does the maintainer use the Registry when working on skills? (A02, D07) | #13 | — | no |
| E04-T04 | [#31](https://github.com/MetaX5/DirectiveBench/issues/31) | Decide how D03 is measured before the comparison work (Q05) | #13 | — | no |
| E05 | [#14](https://github.com/MetaX5/DirectiveBench/issues/14) | Later | — | — | no |

## .ai/specs/2026-10-22-benchmark-own-skills-s1.md

Backlog source: .ai/specs/2026-10-22-benchmark-own-skills-s1.md
Last filed: 2026-10-22

| Id | Issue | Title | Parent | Depends on | Adopted |
|---|---|---|---|---|---|
| E06 | [#93](https://github.com/MetaX5/DirectiveBench/issues/93) | Benchmark my own skill with a real agent (S1, SPEC-118) | — | — | no |
| E06-S01 | [#94](https://github.com/MetaX5/DirectiveBench/issues/94) | A skill author grades an output document by required sections, required phrases and a table value within a range | #93 | — | no |
| E06-S02 | [#95](https://github.com/MetaX5/DirectiveBench/issues/95) | A benchmark run records which skill version it was compared with and keeps results comparable per agent profile | #93 | — | no |
| E06-S03 | [#96](https://github.com/MetaX5/DirectiveBench/issues/96) | Claude Code runs a skill in an inspected, workspace-confined session | #93 | E06-S02 (#95) | no |
| E06-S03-T01 | [#99](https://github.com/MetaX5/DirectiveBench/issues/99) | Pure builders and pre-spawn inspection (argv/env, fixture config refusal, import scan, bundle inspection) | #96 | — | no |
| E06-S03-T02 | [#100](https://github.com/MetaX5/DirectiveBench/issues/100) | Stream parser: execution model, skill activation and error normalisation | #96 | E06-S03-T01 (#99) | no |
| E06-S03-T03 | [#101](https://github.com/MetaX5/DirectiveBench/issues/101) | Process control with the fake claude (timeout, cancellation, process group) | #96 | E06-S03-T01 (#99) | no |
| E06-S03-T04 | [#102](https://github.com/MetaX5/DirectiveBench/issues/102) | Readiness: auth status, API key presence and detection ready/missing | #96 | — | no |
| E06-S03-T05 | [#117](https://github.com/MetaX5/DirectiveBench/issues/117) | Compose ClaudeCodeAdapter from the S03 pieces and prove #96 end to end with the fake claude | #96 | E06-S03-T01 (#99), E06-S03-T02 (#100), E06-S03-T03 (#101), E06-S03-T04 (#102) | no |
| E06-S04 | [#97](https://github.com/MetaX5/DirectiveBench/issues/97) | A skill author scaffolds a suite and runs it against a skill version from the CLI, with or without an A/B baseline, and gets a verdict and exit code | #93 | E06-S01 (#94), E06-S02 (#95), E06-S03 (#96) | no |
| E06-S04-T01 | [#103](https://github.com/MetaX5/DirectiveBench/issues/103) | Opt-in live check in both auth modes; record results in SPEC-203 before S04 ships | #97 | E06-S03 (#96) | no |
| E06-S05 | [#98](https://github.com/MetaX5/DirectiveBench/issues/98) | A skill author sees runs per skill version, the baseline, comparability and regressions on the artifact page | #93 | E06-S02 (#95) | no |

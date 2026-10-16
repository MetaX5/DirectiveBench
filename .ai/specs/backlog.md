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

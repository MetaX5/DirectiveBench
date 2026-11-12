---
id: SPEC-126
title: The same skill in two repositories is one artifact with two occurrences; moves keep identity (E02-S02)
status: draft
created: 2026-11-12
updated: 2026-11-12
category: feature
related: [SPEC-101, SPEC-103, SPEC-105, SPEC-104, SPEC-125, SPEC-124, SPEC-118, SPEC-013, SPEC-006, SPEC-014]
---

# SPEC-126 — The same skill in two repositories is one artifact with two occurrences; moves keep identity (E02-S02)

## 1. Summary

**Proposed, not implemented.** Today a scan identifies an artifact only by its location (SPEC-101
§8.3 rule 1: same repository and path) and otherwise creates a new artifact (rule 4). A skill
copied unchanged into a second repository therefore becomes a second artifact (`review`,
`review-2`) with its own versions, categories and history, and a skill directory moved inside one
repository becomes one missing occurrence plus a new artifact (SPEC-125 A12).

This spec is the story slice of SPEC-101 §8.3 rules 2 and 3, SPEC-103 FR-103-09 and SPEC-105
FR-105-16 that issue #20 (E02-S02) asks for:

1. **Exact copies link (rule 3).** A new occurrence (a path its repository has no occurrence row
   for) whose content hash and format equal a version of an existing artifact is linked to that
   artifact: one artifact, one version, two occurrences. Only skills with a frontmatter `name`
   and rules named after their file link (their name is part of the hashed content, A2, A3);
   repository-level files (`AGENTS.md`, `CLAUDE.md`, Copilot instructions, GitLab Duo chat rules)
   never do. Links stay within one trust class: local repositories with local ones, public
   GitHub repositories with each other (A16). Every new version records the version it replaced
   (`parent_version_id`), so diverging copies are compared along their own line (A19).
2. **Moves keep identity (rule 2).** Within one scan of one repository, a new path whose content
   matches exactly one occurrence that disappeared in the same scan (and vice versa) moves that
   occurrence: same occurrence row, same artifact, new path.
3. **Same name, different content stays apart.** Such artifacts keep their own identity and
   suffixed slugs, and the UI marks them as "possible duplicates" on the list and the artifact
   page.
4. **No slug matching for repository content** (already true since issue #16, pinned by tests).

Existing duplicates are not merged (A6); they get the possible-duplicate hint. No new component is
planned; one migration adds a nullable column and two indexes. Every UI decision in §11 is **to be approved with
Storybook before code**.

## 2. Motivation and problem statement

- Issue #20 (backlog E02-S02, epic #11): "Skills are copied between repositories. Exact copies
  should be one artifact with several occurrences, and same-name skills with different content
  must not be merged, because false merges corrupt evaluation history (SPEC-101 §8.3)." The four
  acceptance criteria are AC-1 to AC-4 in §16. SPEC-013 M1 AC3: "Identical content in two
  repositories is one artifact version with two occurrences."
- The maintainer copies their own skills into client project repositories (brief, Target group;
  D04). Today every copy is a separate artifact, so benchmark results, categories, tags and notes
  gathered on one copy are invisible on the others, and the list shows the same skill N times
  with suffixed slugs and no hint that they are related (US-101-03).
- SPEC-125 (just implemented) made deletions visible. Its A12 left moves as "one missing
  occurrence plus one new artifact", which loses a skill's history every time a directory is
  renamed or moved (`.claude/skills/x` to `.agents/skills/x`).
- Since SPEC-125 Phase 2 the removal panel already counts "artifacts left missing from every
  repository". With one artifact in two repositories, its "No artifact became missing" outcome
  becomes reachable for the first time (§14).
- Product direction: D08 parked E02 until S1 shipped; S1 has shipped and #21 is done; #20 is the
  last story of E02. Issue #20 lists SPEC-104 OQ-104-05 (one directory registered under two local
  providers) as to be decided before this story: A14.

Prior art (from the tools' public documentation, not re-checked in this run):

- **git** detects exact renames first by identical blob, then by similarity, and breaks ties
  with path heuristics. This spec keeps the exact step only and refuses ties (A11): a guessed
  move would silently re-label evaluation history.
- **Backstage's software catalog** identifies an entity by kind, namespace and name; when a second
  location declares an existing entity, it reports a conflict instead of merging. Name-only
  identity is the slug rule the maintainer rejected (lesson 2026-10-19); this spec requires the
  content hash as well and flags same-name, different-content artifacts instead of refusing them.
- **Content-addressed stores** (pnpm's store, git objects) dedupe by hash and keep locations as
  references, which is the artifact/occurrence split of SPEC-101; they have no user metadata to
  protect, so they can merge freely, while DirectiveBench must not merge histories (A6).
- Skill installers that copy skills into projects key them by name and keep no history, so they
  give no guidance on divergence; A8 follows SPEC-101 US-101-03.

## 3. Goals

- G1: An exact copy of a skill or named rule (A3) in another repository, or at another path of the same
  repository, is found as the same artifact with one more occurrence and no new version.
- G2: A skill, rule or instruction moved or renamed inside one repository between two scans keeps its artifact
  and occurrence (rule 2); only an unambiguous one-to-one match is applied.
- G3: Same-named artifacts of the same type with different content are never merged and are
  visibly marked as possible duplicates.
- G4: Identity is independent of scan order and of the slug: scanning A then B gives the same
  artifacts as B then A (up to which copy was first seen). Version **numbers** of edits made in
  two copies between scans follow scan order; lineage (A19) and comparisons do not.
- G6: A diverged copy is compared with its own earlier versions, never with a parallel edit of
  another copy (A19).
- G5: Linking and moving never touch user-owned metadata, versions or benchmark runs (FR-105-13,
  FR-103-01).

## 4. Non-goals

- Merging artifacts that are already duplicated before this spec ships (A6), and the manual
  **link** / **unlink** action (SPEC-101 §19, FR-103-10). Proposed follow-up issue (§19).
- Detecting a move combined with a content change, or similar (not identical) content
  (FR-103-10; similarity matching, SPEC-101 §19).
- Moves across repositories as moves: a file deleted in A and added in B is a missing occurrence
  in A plus a linked occurrence in B (rule 3), not one moved row.
- Linking instructions across locations (A3), and bundled examples to scanned content (A5).
- A "possible duplicates" filter on the list, and the planned `SyncPlan` / `sync_runs` history
  (FR-105-08, FR-105-14).
- A version pinned as "current" (OQ-101-02 stays: the highest version number is the latest).

## 5. User stories

- US-126-01: As a skill author, I copy `skills/review` from my project into a client repository,
  scan both, and see one `review` artifact with two occurrences, its versions, categories and
  benchmark results in one place.
- US-126-02: As a skill author, I edit the copy in the client repository; the artifact gets the
  next version and its occurrence table shows that the client copy has diverged from the other one.
- US-126-03: As a skill author, I rename `.claude/skills/review` to `.agents/skills/review` and
  rescan; the artifact, its history and its occurrence are kept, with the new path.
- US-126-04: As a skill author, two different skills both named `review` exist in two client
  repositories; they stay two artifacts, and both are marked as possible duplicates with a link to
  each other.

## 5a. Resolved assumptions (autonomous defaults)

Written by `om-spec-writing --autonomous` for issue #20. Each row is a decision for the
maintainer; the default is the recommendation. UI decisions are in §11.1.

| # | Question | Default chosen | Alternative | Why this default |
| --- | --- | --- | --- | --- |
| A1 | One spec or several (moves, copies and duplicate hints are separately deployable)? | One spec, three phased PRs (§21): Phase 1 exact copies and version lineage, Phase 2 possible-duplicate hints, Phase 3 moves | Three specs (Phase 3, moves, is the most separable: it has its own acceptance criterion and touches `core`) | The issue is one story with one set of criteria; the three share the identity contract, the scan summary and the occurrence table. If the maintainer prefers, Phase 3 becomes its own spec without changing Phases 1 and 2 |
| A2 | What makes a copy "exact" (rule 3)? | Equal manifest `content_hash` (SPEC-103 FR-103-04) and equal format, for a **linkable format** (A3) whose name is determined by the hashed content: `skill-md` with a frontmatter `name` (the name is in the bytes of `SKILL.md`), `cursor-rule`, `claude-rule` and `copilot-path-instructions` (the name is the file basename, which is the manifest path). Neither side may have skipped files (A20). The artifact's current `name` is not compared | Hash plus `artifacts.name`; or name only | `artifacts.name` changes with later versions, so comparing it would make linking depend on scan order (a copy of v1 links before a rename in v2 and not after); with linkable formats, equal bytes already imply an equal name. A skill named only by its directory (no frontmatter `name`) is not linked, because two such skills with identical files but different directories are different skills. Name-only matching is the slug-style merge the maintainer rejected on 2026-10-19 |
| A3 | Which formats does rule 3 cover? | The linkable formats of A2: skills with a frontmatter `name` and the three rule formats named after their file. Never instructions (`agents-md`, `claude-md`, `copilot-instructions`) or `gitlab-duo-chat-rules` (a fixed, repository-level file, type `rule`), which are identified by location only | All formats, as SPEC-101 §8.3 and SPEC-013 M1 AC3 are written | Repository-level files describe one repository; identical ones are usually boilerplate (`@AGENTS.md`, an empty template) and after a link every repository's later edits would interleave in one artifact's history: a false merge, which cannot be undone without the future unlink action. Skills and named rules are the units people copy. SPEC-013 M1 AC3 and SPEC-101 §8.3 get "skills and named rules" in the implementation PR |
| A4 | Which existing artifacts are candidates? | Artifacts with at least one occurrence, active or missing (SPEC-125), in a repository of the scanned repository's trust class (A16). An artifact with no occurrence left (all its repositories were removed) is not a candidate | Also artifacts with no occurrence left; or only artifacts with an active occurrence | A missing skill found again elsewhere is the same skill, and linking restores its history. An artifact with no occurrence has no trust class left to check (its repositories are gone), and SPEC-125 promised that registering a removed repository again creates new artifacts; that stays true for those. The promise needs one qualifier for artifacts still recorded in another repository (§11.1 UD-6) |
| A5 | Bundled examples (`bundled-examples` provider) | Never a rule-3 candidate and never linked by rule 3; the example import keeps its own identity rule (slug or name and type within the provider) | Treat them like any artifact | Linking a scanned copy of the demo skill to the demo artifact would show mock-agent demo runs on the user's skill and let the next `demo` import write into it (lesson 2026-10-19 "suffixed slugs") |
| A6 | Artifacts already duplicated before this ships | Not merged. A rescan keeps them separate (rule 1 wins); they get the possible-duplicate hint, which says when their latest content is identical | A one-time migration merging exact duplicates | A merge moves versions to another artifact and renumbers them, which breaks the immutability of `artifact_versions` (FR-103-01), changes `vN` labels users and run reports already show, and unions categories, notes and suite assignments; it is the manual link action's job, with a confirmation (follow-up) |
| A7 | Several candidate artifacts (only possible with pre-existing duplicates) | Link to the oldest candidate (`created_at`, then `id`), which keeps one stable target; the result line counts these links separately | Link to none and create another artifact (SPEC-105 FR-105-16 d as written) | With legacy duplicates `review` and `review-2`, "link to none" would create `review-3` on every new copy, so duplicates would grow with every repository. Every candidate already has the same type, format, name and an identical version, so the choice cannot merge unrelated content. FR-105-16 (d) is updated |
| A8 | After a link, an edit in one copy | Stays the same artifact (rule 1): the edited copy adds the next version of the shared artifact; the other occurrence keeps its version. The occurrence table shows each occurrence's version (UD-3) | Split the edited copy into a new artifact | SPEC-101 US-101-03 ("one copy has diverged") is exactly this; splitting on every edit would undo G1 for any skill that is ever customised |
| A9 | Which copy names the artifact (`name`, `description`)? | Once per scan, after its writes and the SPEC-125 marking: when the highest version held by the artifact's active occurrences is one this scan wrote, the name and description come from that copy; otherwise they stay (FR-126-07) | Last write wins (today) | Last write wins makes the name flip with scan order once two copies differ. The new rule is order-independent, ignores a copy deleted in the same scan, and for an artifact with one occurrence behaves exactly as today (a revert still sets the reverted name) |
| A10 | Which version is "latest" for the list, the header and "Run benchmark"? | Unchanged: the highest version number (SPEC-101 §8.2, OQ-101-02) | The version of a chosen occurrence | No contract change in this story; UD-3 makes divergence visible |
| A11 | Rule 2 matching (moves) | Per scan of one repository: a **new** path (no occurrence row) and an **unseen** active occurrence (SPEC-125 `unseenOccurrencePaths`) of the same format match when, for a directory skill, the content hash is equal, or, for a single file, the primary file's `sha256` is equal (FR-103-09). Only a one-to-one match moves; any other match is ambiguous and nothing moves | Pick a best match on ties (git's rename heuristics) | FR-103-09 as written; a wrong move silently re-labels history, an unapplied one only leaves a missing row |
| A12 | An ambiguous move | Not applied (counted in the result line). The new path then goes through rule 3, so a directory skill whose candidates all belong to one artifact still links to it | New artifacts with a warning (FR-103-09 as written) | Rule 3 already guarantees an exact copy is never a false merge; FR-103-09's last sentence is updated to "rules 3 and 4 decide" |
| A13 | Do moves and links change the version or provenance? | A link reuses the version (no new version, FR-103-07); a move of a directory skill reuses its version; a single-file rename adds the next version because the manifest path (basename) changes (SPEC-103 §14). Provenance stays the first observation (FR-103-15) | Record every observation (OQ-103-03) | No contract change |
| A14 | OQ-104-05: one directory registered as `local-git` and as `local-directory` | Keep both rows (no block). Each row's skills and rules link to the same artifacts through rule 3, so the artifact shows two occurrences with the same path in two repositories of the same location. Registration does not warn today (FR-104-18 treats the same location under the other provider as no overlap). A notice "also registered as a plain folder" stays a follow-up | Block the second registration, or a notice in this story | The maintainer deferred OQ-104-05 to "a notice rather than a block"; rule 3 makes the double row harmless for identity (one artifact, not two), which removes the urgency. Out of this story's scope |
| A15 | Possible duplicates: definition | Two or more artifacts whose latest versions have the same linkable format (A3) and whose names are exactly equal, whatever their occurrences, providers and trust classes (bundled examples included: a user's modified copy of the demo skill is worth flagging) | Case-insensitive or slug-base matching; all formats | Exact match is deterministic and indexable; a slug-base match is the rejected slug rule (lesson 2026-10-19); repository-level files (A3) would flag every repository's `AGENTS.md` |
| A16 | Trust boundary: may a copy in a public GitHub repository link to the user's local skill? | No. Rule 3 links only within one **trust class**: local providers (`local-git`, `local-directory`) link among themselves, and `github` links only among `github` repositories. Across classes the copies stay separate and show as possible duplicates with "Same latest content" | Link across every scannable provider | After a link, an edit in any copy adds the next version of the shared artifact, which becomes its latest version: the default target of "Run benchmark" and `benchmark run --artifact <slug>`, which hand that content to a real agent CLI. Across classes that would let any registered public repository set the latest version of the user's own skill. Widening later only affects new occurrences, so this default is the reversible one |
| A17 | Words | UI: "linked" is not shown; the scan result line says "matched an existing artifact"; "possible duplicate" as in SPEC-101 | "merged" | Nothing is merged; the occurrence is added to an existing artifact |
| A18 | ADR | None: no new dependency or pattern; the identity rules live in SPEC-101 §8.3 and this spec | ADR for rule 3 | AGENTS.md asks ADRs for significant design decisions only; this implements an existing spec rule |
| A19 | Version lineage once copies diverge | Every new version records `parent_version_id`: the version its occurrence held before this write (null for a new occurrence and for versions stored before the migration, whose parent is the previous number of the same artifact). "Results by version" compares a version with its nearest tested ancestor along that chain instead of the previous number (SPEC-111 FR-111-50, SPEC-118 FR-118-50/51) | Keep comparing with the previous number; or no lineage and a "diverged" warning only | After a link, edits in two copies become one numbered sequence (A8): copy A's v2 and copy B's v3 are parallel edits, and comparing them would report a "regression" between copies that never followed each other. The parent can only be recorded when the version is inserted (immutable rows, FR-103-01), so it must ship with the first link in Phase 1 |
| A20 | Skipped files (binary or too large supporting files, `parsedMetadata.skipped`) | Rule 3 does not link when the discovered artifact or the candidate version has skipped files | Add the skipped list to the match key | Skipped files are not in the manifest, so two directories that differ only in them hash the same; refusing the link keeps "exact copy" true at the cost of a false split, which is cheap |

## 6. Functional requirements

### 6.1 Exact copies (rule 3, Phase 1)

| ID | Requirement |
| --- | --- |
| FR-126-01 | **Order.** For every artifact a repository scan discovered, `applyRepositoryScan` resolves identity in this order: rule 1 (an occurrence row at the same repository and path, `active` or `removed`: same artifact, unchanged, SPEC-125 FR-125-05); rule 2 (Phase 3, §6.3); rule 3; rule 4 (a new artifact with the first free slug). |
| FR-126-02 | **Rule 3.** A discovered artifact of a linkable format (A2, A3) at a new path, with no skipped files, is linked to an existing artifact `X` when `X` is not a bundled example (FR-126-05), `X` has at least one occurrence (any status) and all of them are in repositories of the scanned repository's trust class (A4, A16), and `X` has a version with no skipped files whose `content_hash` and `format` equal the discovered ones. The occurrence is inserted for `X`, pointing at that version; no version is created (FR-103-07). The artifact's `name` is not compared (A2). |
| FR-126-03 | **Several candidates.** When more than one artifact qualifies, the oldest by `created_at`, then `id`, is chosen (A7) and the scan counts it in `ambiguousLinks`. |
| FR-126-04 | **Within one scan.** Artifacts created or linked earlier in the same apply transaction are candidates for later ones: two identical new paths in one scan become one artifact with two occurrences, as do identical paths in two scans of different repositories (the second apply transaction sees the first, `BEGIN IMMEDIATE`). |
| FR-126-05 | **Bundled examples.** An artifact with an occurrence in a `bundled-examples` repository is never a rule-3 candidate; `importArtifactVersion` never applies rule 3 (A5). |
| FR-126-06 | **Repository-level files.** Formats outside the linkable set (instructions, `gitlab-duo-chat-rules`, skills without a frontmatter `name`) skip rule 3 (A2, A3); rules 1, 2 (§6.3) and 4 apply to them as to any artifact. |
| FR-126-07 | **Source fields.** After the scan's writes and SPEC-125's marking, once per artifact the scan wrote: if the highest version held by the artifact's `active` occurrences is a version this scan wrote, `artifacts.name` and `description` are set from that discovered artifact; otherwise they stay (A9). One grouped read over the written artifacts, in batches of `IDENTITY_LOOKUP_BATCH_SIZE`, never one query per write (NFR-126-01). With one occurrence this is today's behaviour, a revert included. `slug` never changes (FR-105-13). |
| FR-126-08 | **User data.** Linking, like every scan write, never changes notes, tags, categories, suite assignments, versions or runs (FR-105-13, FR-103-01). The linked occurrence shares the artifact's user metadata. A missing artifact (SPEC-125 A8) that gains an active linked occurrence is no longer missing. |
| FR-126-09 | **Summary.** `RepositoryScanSummary` and the job result (`repositoryScanResultSchema`, `ok` branch, `.strict()`) gain `linkedOccurrences` (rule 3 links, ambiguous ones included) and `ambiguousLinks`, counts with `.default(0)` so stored results still parse. `createdArtifacts` no longer counts linked occurrences. |
| FR-126-10 | **Scan result line.** `describeScan` adds "N matched an existing artifact" when `linkedOccurrences > 0` (§11.1 UD-1). |

### 6.1a Version lineage (Phase 1)

| ID | Requirement |
| --- | --- |
| FR-126-19 | **Parent.** `artifact_versions.parent_version_id` (nullable, references `artifact_versions.id`, `ON DELETE SET NULL`) is set when a version is inserted, never updated (FR-103-01): the `latest_version_id` the writing occurrence held before this write when that version belongs to the same artifact, else null (a new occurrence, a new artifact). Rows inserted before migration 0006 keep null. |
| FR-126-20 | **Effective parent.** `effectiveParent(version)` = `parent_version_id` when set; otherwise, for `version > 1`, the version numbered `version - 1` of the same artifact (all versions before this spec form one line, since nothing was linked); otherwise none. |
| FR-126-21 | **Comparisons.** "Results by version" (SPEC-118 FR-118-50/51, SPEC-111 FR-111-50/51, `apps/web/lib/artifact-runs.ts`) compares a version with its nearest ancestor along `effectiveParent` that has a comparable run in the same group, instead of the previous tested version number. For an artifact with one line the result is unchanged. A/B runs with an explicit baseline version (SPEC-118 FR-118-13) are unchanged: the user chose the pair. |

### 6.2 Possible duplicates (Phase 2)

| ID | Requirement |
| --- | --- |
| FR-126-11 | **Definition.** An artifact is a possible duplicate when its latest version has a linkable format (A3) and at least one other artifact whose latest version has the same format has exactly the same name (A15). Computed on read, nothing stored. |
| FR-126-12 | **List.** `ArtifactListItem` gains `possibleDuplicates: number` (the count of the others). The Name cell shows a "Possible duplicate" Badge when it is greater than 0 (UD-4). Counts, filters, the SPEC-124 bulk action and its fingerprint are unchanged. |
| FR-126-13 | **Artifact page.** `getArtifactDetail` gains `possibleDuplicates`: each other artifact's id, slug, name, active occurrence count, repositories (names) and whether its latest version's `content_hash` equals this artifact's latest (`sameLatestContent`), ordered by `created_at`, `id`, at most `MAX_LISTED_DUPLICATES = 20` plus the total. The Overview shows them in a "Possible duplicates" card (UD-5). |

### 6.3 Moves (rule 2, Phase 3)

| ID | Requirement |
| --- | --- |
| FR-126-14 | **Candidates.** Inside the apply transaction, before any write, the scan computes the **new** discovered paths (no occurrence row of this repository at that path) and the **unseen** active occurrences (`unseenOccurrencePaths`, SPEC-125 FR-125-03/04: not discovered and not covered by an unobserved path). With no artifact discovered (SPEC-125 A7) nothing moves. |
| FR-126-15 | **Match.** A new path and an unseen occurrence match when their formats are equal and: for format `skill-md`, the discovered content hash equals the occurrence's latest version's `content_hash`; for every single-file format, the discovered primary file's recomputed `sha256` equals the `sha256` of the occurrence's latest version's primary file (FR-103-09). A pure function `matchMoves` in `@directivebench/core` pairs them; a pair is applied only when each side has exactly one match (A11). Every other matching path is counted once in `ambiguousMoves`. |
| FR-126-16 | **Apply.** A move updates the unseen occurrence in place: `path` to the new path, `latest_version_id` (reused for a skill, the next version for a renamed single file, A13), `commit_sha`, `status = 'active'`, `last_seen_at`, `updated_at`. Same occurrence id and artifact; not counted as removed or created. The source fields follow FR-126-07. |
| FR-126-17 | **Unmatched.** An unseen occurrence that did not move is marked `removed` (SPEC-125); a new path that did not move goes on to rule 3, then rule 4 (A12). |
| FR-126-18 | **Summary and line.** The summary and job result gain `movedOccurrences` and `ambiguousMoves` (`.default(0)`); `describeScan` adds "N moved" and "N possible moves were not applied because several files matched" (UD-1). |

## 7. Non-functional requirements

- NFR-126-01: Rule-3 lookups and the FR-126-07 read are batched, never one query per discovered
  artifact inside the write transaction (lesson 2026-10-20 "never probe one query per
  candidate"): one read of the candidate versions for all new paths' hashes in batches of at most
  `IDENTITY_LOOKUP_BATCH_SIZE = 500`, with each candidate artifact's occurrence trust classes and
  bundled flag, into an in-memory map keyed by `(content_hash, format)` that the transaction's own
  creations update (FR-126-04).
- NFR-126-02: Migration `0006` adds `artifact_versions_content_hash_idx` on
  `artifact_versions(content_hash)` (the unique index leads with `artifact_id` and cannot serve a
  hash lookup) and `artifacts_type_name_idx` on `artifacts(type, name)` (duplicate counts), and the nullable column `artifact_versions.parent_version_id` (FR-126-19).
  Plain DDL, portable to the planned PostgreSQL backend (SPEC-117). Up and down tested
  (lesson 2026-10-22 "pin each migration's up/down test").
- NFR-126-03: Move matching reads the latest version of unseen occurrences only (their `files`
  for the primary `sha256`), so a rescan without deletions reads no extra file content; matching
  is O(n log n) in new plus unseen paths (maps keyed by hash).
- NFR-126-04: The identity step's cost grows linearly with the scan: a database test asserts the
  statement count (one candidate read per 500 new paths, one FR-126-07 read per 500 written
  artifacts) and linear growth with `expectLinearTime` (3,000 linked skills against 300); no
  wall-clock bound.
- NFR-126-05: Every changed page works by keyboard alone, has no page scroll at 320px, keeps the
  issue #122 full-HD list width, and meets contrast in both themes (AGENTS.md §7).
- NFR-126-06: Local-first, no network call, no new dependency.

## 8. Domain entities and contracts

### 8.1 Data model

Migration `0006_artifact_identity.sql`: the two indexes of NFR-126-02 and the nullable column
`artifact_versions.parent_version_id` (FR-126-19, references `artifact_versions.id`, `ON DELETE
SET NULL`), set only on insert. No new table.
Existing columns carry the feature: `artifact_occurrences.artifact_id` (a link inserts an
occurrence for an existing artifact; a move updates `path`), `artifact_versions.content_hash`,
`format`, `files` (primary file `sha256`), `artifacts.name`, `type`, `created_at`.

### 8.2 Core (`@directivebench/core`, Phase 3)

```ts
export interface MoveCandidate { key: string; format: string; matchHash: string }
/**
 * Pairs new paths with unseen occurrences that have the same format and match hash
 * (content hash for skill-md, primary file sha256 otherwise). Only one-to-one pairs are moves.
 * Pure; O(n log n).
 */
export function matchMoves(input: {
  added: readonly MoveCandidate[];   // key = new path
  unseen: readonly MoveCandidate[];  // key = occurrence id
}): { moves: { path: string; occurrenceId: string }[]; ambiguous: number };
```

### 8.3 Database (`@directivebench/database`)

```ts
export interface RepositoryScanSummary {
  // … existing counts …
  linkedOccurrences: number;  // FR-126-09 (Phase 1)
  ambiguousLinks: number;     // FR-126-03 (Phase 1)
  movedOccurrences: number;   // FR-126-18 (Phase 3)
  ambiguousMoves: number;     // FR-126-18 (Phase 3)
}

export interface ArtifactListItem { /* … */ possibleDuplicates: number }   // Phase 2

export interface PossibleDuplicate {                                       // Phase 2
  id: string; slug: string; name: string;
  activeOccurrences: number;
  repositories: { id: string; name: string }[];
  sameLatestContent: boolean;
}
// artifact_versions gains parentVersionId: string | null (FR-126-19), written on insert only.
// getArtifactDetail(...) gains:
//   possibleDuplicates: { items: PossibleDuplicate[]; total: number }
//   occurrences[i].version: number   (the occurrence's latest_version_id's number, Phase 1, UD-3)
```

`writeArtifactVersion` gets the identity decision from the caller instead of finding it itself
for repository scans: `applyRepositoryScan` resolves rules 1 to 4 for the whole scan (one read of
the repository's occurrences, the batched rule-3 read, Phase 3's move pairs) and passes
`{ artifactId } | { create: slugBase }` and, for a move, the occurrence id to update. The
`slug` identity of `importArtifactVersion` stays as it is.

### 8.4 Runner and web

- Runner: none beyond copying the new counts into the job result.
- Web (`apps/web/lib`): `describeScan` clauses; occurrence version label; possible-duplicate
  card model. No new Server Action.

## 9. Data flow

```mermaid
flowchart TD
  D[DiscoveryResult: artifacts, unobserved] --> T[applyRepositoryScan transaction]
  T --> O[read repository occurrences]
  O --> R1{row at same path?}
  R1 -- yes --> W1[rule 1: same artifact<br/>reactivate if removed]
  R1 -- no --> NEW[new paths]
  O --> UNSEEN[unseen active occurrences<br/>SPEC-125]
  NEW --> M{rule 2, Phase 3:<br/>one-to-one match?}
  UNSEEN --> M
  M -- yes --> MV[move: update path]
  M -- no --> C{rule 3: linkable format,<br/>same hash and format,<br/>same trust class, not bundled?}
  C -- one or more --> L[link to candidate<br/>oldest if several]
  C -- none --> N[rule 4: new artifact, suffixed slug]
  UNSEEN -- not moved --> X[mark removed, SPEC-125]
  W1 & MV & L & N --> S[source fields by FR-126-07,<br/>summary counts, sync_status ok]
```

Existing: rule 1, rule 4, the marking. New: rule 2, rule 3, FR-126-07 and the counts. All in the
one apply transaction, so identity, versions, marking and the `ok` status commit together.

## 10. API and interface design

- No HTTP API, no CLI change. `benchmark run --artifact <slug|id>` keeps resolving by slug or id
  (SPEC-118); slugs never change, so existing references stay valid.
- Job result: four new counts with `.default(0)` (FR-126-09, FR-126-18).
- No new Server Action and no URL parameter.

## 11. UI/UX considerations

Built from existing components (`apps/web/design-system.md`): Badge (`muted`, `outline`), Card,
Table, Link. **Every point in §11.1 is to be approved with Storybook before code**: the
implementation PR of each phase first adds or updates the stories (both themes, axe), the
maintainer approves them, then the page code follows (the SPEC-125 §11.2 / §11.3 model).

### 11.1 UI decisions for the maintainer to approve (Storybook first)

| # | Point | Proposed default |
| --- | --- | --- |
| UD-1 | Scan result line on `/repositories` | Clauses after the existing ones: "2 matched an existing artifact" (Phase 1); "1 moved", "1 possible move was not applied because several files matched" (Phase 3). Plain text in the existing line; no new kind |
| UD-2 | Artifacts list for a linked artifact | No change: the Repository cell already shows the first repository plus "+N" and Occurrences counts active occurrences across repositories, which is AC-1 visible |
| UD-3 | Occurrences table on the artifact page (Phase 1) | New column "Version" after Path: "v3"; when it is not the artifact's latest version, a `muted` Badge "older version" next to it, so a diverged copy is visible (US-126-02). The column is a link to `?tab=content&version=3` |
| UD-4 | List Name cell (Phase 2) | Under the name, an `outline` Badge "Possible duplicate" with `title` "N other artifacts have the same name"; no icon; keeps the issue #122 widths (the badge wraps under the name, never widens the column) |
| UD-5 | Artifact page (Phase 2) | Overview, after Occurrences: Card "Possible duplicates", description "Other artifacts with the same name and format. DirectiveBench links only identical copies within local or within GitHub repositories; these are kept apart." Table: Artifact (link, slug in `font-mono`), Repositories, Content ("Same latest content" / "Different content"). When more than 20: "and N more" with a link to `/artifacts?q=<name>`. A note under the card when any row has the same latest content: "Identical copies are kept apart when they were registered before this version, are in a local and a GitHub repository, or have skipped files." |
| UD-6 | SPEC-125 removal panel reason (Phase 1) | Replace "Registering it again later creates new artifacts instead of reusing these ones." with "Registering it again later creates new artifacts for these ones. Unchanged skills and rules still recorded in another repository are matched to their existing artifact." (A4) |
| UD-7 | Words | "possible duplicate", "matched an existing artifact", "moved", "older version"; no "merged" (A17); no en or em dash in any of it |

### 11.2 Accessibility

Badges carry text, not colour alone; the Version link has an accessible name ("Version 3 of
<name>"); the duplicates table is a normal table with a caption for screen readers; keyboard
order unchanged except the new links; contrast of `outline` and `muted` Badges is already
verified (SPEC-125) but is re-checked on the new cells in both themes (`text-contrast.spec.ts`).

## 12. Security considerations

- No new input: names, hashes and paths come from discovery and reach queries only as
  parameters; IN lists are batched (NFR-126-01).
- Trust boundary (A16): a registered public GitHub repository can never add an occurrence to an
  artifact found in a local repository, nor the other way round. Without this, editing its copy
  would add the next version of the user's own skill, which becomes the default of "Run
  benchmark" and `benchmark run --artifact <slug>` and is handed to a real agent CLI. Within one
  trust class, an occurrence is added only for identical manifest content (SHA-256 over paths and
  file hashes) of the same format and with no skipped files on either side (A20); skipped files
  are not hashed, so this is what "exact copy" can promise. Existing versions never change.
- The UI shows where every version came from (Versions tab First seen) and which version each
  occurrence holds (UD-3); "Run benchmark" keeps naming the version it runs.
- Bundled examples stay isolated (A5), so demo mock runs never attach to user content.
- Nothing is logged or shown that was not shown before; artifact content is not echoed.

## 13. Error handling

- Rule 3 and rule 2 run inside the existing apply transaction: any failure rolls back
  everything, including SPEC-125's marking, and the scan fails with the existing
  `ArtifactStoreError` message naming the path where it stopped.
- A unique violation on `(repository_id, path)` cannot come from a move (the target path has no
  row by definition, checked in the same transaction); if it happens, the transaction fails as any
  store failure does.
- The cancellation, removed-repository and job checks of `applyRepositoryScan` run before the new
  reads, unchanged.

## 14. Edge cases

- **Same content, same name, two paths in one repository** (`.claude/skills/x`, `.agents/skills/x`):
  one artifact, two occurrences, one version (SPEC-101 §14, SPEC-103 §14).
- **Copy of an older version**: repository B holds the content of v1 of artifact X (latest v3):
  linked to X at v1; the occurrence table shows "v1 older version"; name and description stay
  those of v3 (A9).
- **Skill without frontmatter `name`** (named after its directory) copied unchanged: never
  linked (A2), even under the same directory name; two artifacts, flagged as possible duplicates
  when the directory names are equal. Moving it inside one repository is a move (rule 2).
- **Renamed artifact, old copy found later**: X's v2 changed the frontmatter `name`; a copy of
  v1 found after that still links to X at v1, because the name is part of v1's bytes and the
  artifact's current name is not compared (A2).
- **Renamed single-file rule** (`a.mdc` to `b.mdc`, same bytes): a move (rule 2), the next version
  (manifest basename changed), name follows (`b`). In another repository the same rename is a
  missing `a` plus a new `b` (no rule 3: the hash differs).
- **Two copies moved at once** (identical skills at `x` and `y` both moved): ambiguous, no move;
  both old occurrences go missing; both new paths link to the artifact through rule 3 when all
  candidates are one artifact.
- **Moved into a path that had a missing occurrence**: rule 1 reactivates that row; the old one
  goes missing (no move, the target is not new).
- **Artifact in two repositories, one copy deleted**: that occurrence goes missing, the artifact
  stays active (no Missing badge); SPEC-125's removal of the other repository then reports "No
  artifact became missing." (first reachable now; a Playwright check is added).
- **Repository removed, then registered again**: artifacts left with no occurrence are not
  candidates, so its files become new artifacts as SPEC-125 promised; an unchanged skill or named
  rule that is still recorded in another repository of the same trust class links back to that
  artifact (A4, UD-6).
- **The same skill in a local repository and in a registered public GitHub repository**: two
  artifacts (A16), both flagged as possible duplicates with "Same latest content".
- **Legacy duplicates `review` and `review-2` (identical), then a third repository**: links to
  `review` (oldest, A7), `ambiguousLinks = 1`; all three show as possible duplicates of each
  other.
- **Bundled demo skill copied into a repository**: never linked (A5); flagged as a possible
  duplicate of the demo artifact when the name and type match (A15).
- **Same directory under `local-git` and `local-directory`** (OQ-104-05): its skills and rules
  link, so each artifact shows two occurrences with the same path (A14); its instructions stay two
  artifacts per location.
- **Edit in one copy, then the other copy is edited to the same new content**: the second write
  finds the version by hash within the artifact (FR-103-07), no new version.
- **Name edit in one copy only** (frontmatter `name` changed): rule 1 keeps it in the artifact;
  the artifact's name follows the copy with the highest version (A9).
- **Diverged copies and results by version**: A holds v2 (an edit of v1), B then edits v1 into
  v3: v3's parent is v1 (FR-126-19), so v3's runs are compared with v1's, never with A's v2
  (FR-126-21).
- **A run of a version of the other copy as baseline** (SPEC-118 A/B with `--baseline v<n>`):
  allowed, the user chose the pair; both are versions of the same artifact.
- **Scan order**: A then B links B to A's artifact; B then A links A to B's. Same artifacts, same
  counts; only `created_at` and provenance differ (G4). Two copies edited between scans get
  their version numbers in scan order, but each version's parent is its own copy's previous one.

## 15. Testing strategy

Per SPEC-012 and the 100% coverage rule; mock agent only, no network.

- Core (Phase 3): `matchMoves` table-driven: one-to-one, two added for one unseen, two unseen for
  one added, different formats, empty inputs, 10,000 pairs (linear growth).
- Database (`packages/database/test/identity.test.ts`): rule 3 across repositories and within one
  repository; within one scan; both scan orders (G4); several candidates (oldest,
  `ambiguousLinks`); different format; every non-linkable format and a skill without a
  frontmatter `name` never linked; skipped files on either side (A20); local and `github`
  never linked to each other (A16); bundled example never a candidate and the demo import never
  linking (both orders, lesson 2026-10-19); a missing candidate linked and an artifact without
  occurrences not (A4); an old copy linking after a rename (A2); FR-126-07 with two diverged
  copies in both scan orders, with a single-occurrence revert, and with the highest copy deleted
  in the same scan; `parent_version_id` on insert (new occurrence, rule-1 edit, link then edit,
  move) and never updated; user metadata, versions and runs untouched; rollback
  through a SQLite trigger (lesson 2026-11-05); batched lookup with one statement per 500 hashes
  (count the statements, lesson 2026-11-05 "assert the seam fired"); migration 0006 up and down;
  the job result with and without the new counts; Phase 2 duplicate counts and detail rows; Phase
  3 moves (skill directory, single-file rename, ambiguous, unobserved paths never moved, the A7
  empty scan, move into a missing row's path).
- Runner (`packages/runner/test`): `local-git`, `local-directory` and `github` (local bare remote)
  scans of two repositories sharing a skill; a moved skill directory and a renamed rule between
  two scans; counts in the job result.
- Web unit (`apps/web/test`): `describeScan` clauses, occurrence version label, duplicate card
  model, the UD-6 sentence; `artifact-runs` comparisons along `effectiveParent` (one line
  unchanged, two diverged lines, a legacy null parent, a parent without runs skipped to the
  nearest tested ancestor).
- Playwright (`apps/web/e2e/identity.spec.ts`, cleaning up the shared database as found, lesson
  2026-11-10): two fixture repositories with one identical skill, one same-named different skill
  and one instruction: list shows one artifact with "+1" and 2 occurrences (AC-1), the other pair
  with "Possible duplicate" badges and the card linking each other (AC-2); between two scans a
  renamed `.cursor/rules/*.mdc` file and a moved skill directory without a frontmatter `name`
  (neither can be explained by rule 3) keep their artifact URL and show one occurrence row with
  the new path and no missing row (AC-3); removing one repository says "No
  artifact became missing."; keyboard, 320px, both themes, contrast; Storybook stories for UD-3 to
  UD-5 (`pnpm test:storybook`).

## 16. Acceptance criteria

- [ ] AC-1: Given identical skill content in two repositories, when both are scanned (either
  order), then it is one artifact version with two occurrences (SPEC-013 M1 AC3 for skills with
  a frontmatter `name` and rules named after their file, within one trust class; SPEC-101 §8.3
  rule 3).
- [ ] AC-2: Given two skills with the same name but different content in different repositories,
  when they are scanned, then they are not merged, their slugs differ by a suffix, and the list
  and both artifact pages mark them as possible duplicates.
- [ ] AC-3: Given a skill moved within one repository between two scans, when it is scanned, then
  it stays the same artifact and the same occurrence row with the updated path (rule 2), shown
  by a case rule 3 cannot explain (a renamed rule file, a skill without a frontmatter `name`);
  an ambiguous move is not applied.
- [ ] AC-4: Given repository content, slug matching never decides identity (regression tests in
  both orders with the bundled example).
- [ ] AC-5: Linking and moving keep categories, tags, notes, suite assignments, versions and runs;
  a linked occurrence shows its version and whether it is older than the latest.
- [ ] AC-6: Repository-level files, skills without a frontmatter `name`, artifacts with skipped
  files and bundled examples are never linked; a local and a public GitHub copy are never linked.
- [ ] AC-9: After two copies of one artifact diverge, "Results by version" compares each version
  only with its own ancestors (FR-126-21); an artifact with one line shows the same comparisons
  as before.
- [ ] AC-7: The SPEC-125 removal panel and result line stay true (UD-6; "No artifact became
  missing." reachable and tested).
- [ ] AC-8: Every UI point of §11.1 was approved in Storybook before its page code; Playwright,
  Storybook, keyboard, 320px and contrast in both themes pass; the full gate passes.

## 17. Dependencies

- Issues: #20 (this), epic #11, #19 and #21 (closed), #53 (lifecycle filter), OQ-104-05.
- Specs changed by the implementation PRs: SPEC-101 §8.3 (rule 3: linkable formats, trust class,
  A7 several candidates), §14, FR-101-10 note, §20; SPEC-103 FR-103-02 (`parent_version_id`),
  FR-103-09 in full (ambiguous moves: rules 3 and 4 decide; "no new version" holds for directory
  skills only, a single-file rename adds the next version as §14 already says), §16, §20; SPEC-105
  FR-105-09 (A9 source-field rule), FR-105-16 (b) (ambiguous moves) and (d) (A7), §20; SPEC-111
  FR-111-50 and SPEC-118 FR-118-50/51 (compare along the lineage, FR-126-21); SPEC-104 OQ-104-05
  (A14); SPEC-125 FR-125-15 / §11.3 D15 reason text (UD-6), A17; SPEC-013 M1 AC3 (linkable
  formats, trust class); SPEC-006 (migration 0006).
- Packages: `core` (Phase 3), `database`, `runner`, `apps/web`. No new dependency.

## 18. Open questions

None blocking: every question has a recommended default in §5a and §11.1 for the maintainer to
confirm or change before approval. The most consequential ones are A3 (repository-level files
excluded), A16 (no links across the local / public GitHub trust boundary), A19 (version lineage,
a new column, changing how "Results by version" compares), A6 (no merge of existing duplicates)
and A7 (oldest candidate instead of none).

## 19. Future extensions

- Manual link and unlink of occurrences between artifacts, with a confirmation and a version
  renumbering plan (the way to merge pre-existing duplicates, A6).
- Similarity-based duplicate detection and moves with content changes (FR-103-10).
- A "Possible duplicates" filter on the list (with issue #53's lifecycle filter).
- A notice for one directory registered under both local providers (OQ-104-05, A14).
- Per-version observation history (OQ-103-03).

## 20. Implementation status

Not implemented. Today (`packages/database/src/repositories/artifacts.ts`, `findArtifact` with
`identity: 'location'`): rule 1 and rule 4 only; no rule 2 or 3; name and description follow the
last write; no possible-duplicate hint.

## 21. Phasing and implementation plan

Each phase is one PR that leaves the app working and passes the full gate. Phase 1 must not ship
in an npm release without the UD-6 text change (it is in Phase 1). The PR of Phase 3 closes #20.

### Phase 1: exact copies link (rule 3) and version lineage

1. Storybook: UD-3 (Occurrences table with the Version column), UD-6 (removal reason) and the
   "Results by version" block with two diverged lines (FR-126-21) stories;
   maintainer approval before step 5.
2. Database: migration 0006 (both indexes and `parent_version_id`) with up/down test; the parent
   written on every version insert; the identity resolution in
   `applyRepositoryScan` (rules 1, 3, 4, batched lookup, in-transaction map), FR-126-07, the counts
   and the result schema; `occurrences[i].version` in `getArtifactDetail`; tests (§15).
3. Runner: copy the counts; runner tests for the three providers.
4. Web lib: `describeScan` clause (UD-1), the UD-6 sentence, `artifact-runs` comparisons along
   `effectiveParent` (FR-126-20/21, with the version list's parent ids from the database); unit
   tests.
5. Web pages: the Version column and badge (UD-3); Playwright for AC-1, AC-5, AC-6, AC-7, AC-9.
6. Spec updates of §17 for rule 3; this spec's §20.

### Phase 2: possible duplicates

1. Storybook: UD-4 and UD-5 stories; approval.
2. Database: `possibleDuplicates` count on the list (one grouped subquery on the new index) and
   the detail list; tests including 10,000 artifacts (linear).
3. Web: Name cell badge, the card; Playwright for AC-2 incl. issue #122 full-HD width and 320px.
4. SPEC-101 FR-101-10 note and §20.

### Phase 3: moves (rule 2)

1. Core: `matchMoves` and tests.
2. Database: the move step before rule 3 (FR-126-14 to FR-126-17), counts; tests.
3. Runner tests (directory move, single-file rename, ambiguous) for the three providers.
4. Web: UD-1 move clauses; Playwright for AC-3.
5. SPEC-103 FR-103-09, §16, §20; SPEC-105 §20; move this spec to `implemented/` only when AC-1 to
   AC-9 are verified. The PR closes #20.

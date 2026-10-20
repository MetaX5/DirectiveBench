---
title: Fix the three Codex review findings on PR #44 (partial skills, scan byte cap, Windows no-follow)
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: coordinator request — the maintainer ran an adversarial Codex review of PR #44 (issue #16) at b0689cd and asked for its findings to be fixed
status: completed
branch: feat/issue-16-scan-local-repository
specs: [SPEC-102, SPEC-105]
---

# Run: PR #44 Codex findings

## Objective

Fix the three high-severity Codex findings, all triaged as valid against b0689cd, on the PR
branch without merging and without changing the maintainer's decisions of 2026-10-19 (working-tree
scan, extra registration slot, one transaction per scan, no slug merging, user-level folders always
skipped — D05). Acceptance: each finding fixed with tests that fail on the old code, 100% coverage
without threshold or exclusion changes, the full gate and Playwright green, a real run of the built
CLI, SPEC-102 updated, and an independent review of the final head.

## Plan

1. Base: `origin/main` (355e8f6) is already contained in the PR head; no merge.
2. Finding 1 (partial versions): the walker returns unreadable or changed directories without an
   error code; assembly charges each to the deepest skill at or above it (`owningSkill`, now
   directory-based) and that skill becomes one `read-failed` error for its `SKILL.md`; directories
   outside every skill stay standalone errors. Supporting-file read failures were already
   all-or-nothing (the read error propagates out of `discoverSkill`) — keep and test. Verify in the
   database and the runner that an artifact missing from a scan leaves its occurrence untouched.
3. Finding 2 (no aggregate cap): `DISCOVERY_LIMITS.maxScanBytes` = 256 MiB, checked before each
   file is kept; a typed `DiscoveryLimitError` (also used for `maxCandidatesPerScan`) aborts
   discovery, so the scan fails through the existing FR-105-15 path.
4. Finding 3 (Windows): open with `O_NOFOLLOW ?? 0`, then require `fstat(handle)` and `lstat(path)`
   to be the same regular file (no symlink, equal `dev`/`ino` as bigint, `ino` not 0). Tests on
   Linux swap files around the open, patch stats, and remove `O_NOFOLLOW` to simulate Windows.
5. SPEC-102 FR-102-16, §13, §14, §20 and SPEC-105 §20; lesson; gate; real run; review.

## Decisions

- `maxScanBytes` = 256 MiB: discovery returns all content at once, so the per-artifact limits
  alone allow 10,000 × 20 MiB. Real instruction repositories typically hold well under 10 MiB
  of text (an estimate, not measured in this run), 256 MiB still fits a dozen
  maximal (20 MiB) skills, and the runner — which holds the content again as JS strings and SQLite
  parameters — stays within an ordinary development machine's memory. Bytes counted are those of
  the files actually kept (binary files skipped and artifacts that fail are not counted).
- An unreadable or changed directory inside a skill makes the skill an error whose message names
  the first such directory by path (sorted, so deterministic) — one error per artifact.
- The scan-wide abort reuses the generic `scan-failed` outcome (message "The scan failed:
  Discovery aborted: …"), as `maxCandidatesPerScan` already did; no new result code.
- The identity check reports `read-failed` ("… changed during the scan and is no longer the
  regular file the walk found"), the same code a Linux `O_NOFOLLOW` refusal (`ELOOP`) produces.

## Work performed

- `packages/core/src/discovery.ts`: `UnreadableDirectory`/`SkillContents`, directory-based
  `owningSkill`, skill-level `read-failed` for unreadable directories, `maxScanBytes` and
  `DiscoveryLimitError`, `isSameRegularFile` identity check in `readUpTo`.
- Tests: `packages/core/test/discovery.test.ts` (unreadable directory inside a skill, deepest-skill
  attribution incl. a root `SKILL.md`, unreadable `.agents/skills` stays standalone, byte cap with a
  small limit, typed candidate-cap error); `discovery-simulated-fs.test.ts` (directory inside a
  skill swapped during the walk; file → symlink after the open; file → directory before the open;
  handle with different `ino`, different `dev`, `ino` 0; with `O_NOFOLLOW` removed: unchanged
  reads, a symlink swapped in before the open, and one swapped back right after it);
  `packages/database/test/artifacts.test.ts` (an occurrence missing from a scan keeps its row,
  versions and artifact exactly); `packages/runner/test/repository-scan.test.ts` (end to end: an
  unreadable `templates/` with changed content and an unreadable `.agents/skills` keep the skill's
  occurrence row identical and add no version; readable again → next version; byte cap lowered →
  job failed, `sync_status = 'error'`, nothing written).
- Specs: SPEC-102 FR-102-16, §13, §14, §20; SPEC-105 §20. Lesson recorded.

## Verification

- Old-code checks: with the identity check disabled, 5 of the new simulated-fs tests fail. Not
  every identity condition had a test of its own at this head: the path-is-not-a-symlink check was
  covered only together with the inode comparison, which already rejects a symlink (corrected by
  the independent review; the next round adds a test that isolates it — see
  [2026-10-19-pr-44-second-codex-review.md](2026-10-19-pr-44-second-codex-review.md)). The runner test's unreadable-`templates/` case
  would store a smaller version on the old walker (the old code emitted the skill without the
  unreadable directory's files).
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`: all green; core 152, database
  105, runner 97, web 92, CLI 75, benchmark-engine 110, agent-adapters 34 tests; 100% statements,
  branches, functions and lines in every package; no threshold, exclusion or `v8 ignore` change.
- `pnpm build && pnpm verify:pack`: passed. `pnpm test:e2e`: 27 passed.
- Real app (built CLI `serve` with a temporary data directory and `HOME`, driven by Playwright):
  a project with `.agents/skills/review/{SKILL.md,templates/report.md}` and `AGENTS.md`.
  Scan 1: "2 artifacts found (2 new, 2 new versions), 0 errors". Then `report.md` changed and
  `templates/` set to mode 000 — scan 2: "1 artifact found (0 new, 0 new versions), 1 error",
  error `.agents/skills/review/SKILL.md read-failed Skill … is incomplete and was not discovered.
  Cannot read directory .agents/skills/review/templates (EACCES); …`; the occurrence's
  `latest_version_id`, `status`, `last_seen_at` and `updated_at` unchanged, still 2 versions.
  `.agents/skills` set to 000 — scan 3: standalone `.agents/skills read-failed` error, occurrence
  unchanged. Readable again — scan 4: "1 new version", new `latest_version_id`, 3 versions.
- Not verified: Windows itself (no Windows run; the Windows path is verified on Linux by removing
  `O_NOFOLLOW` in a test), macOS, a file system that reports inode 0, a real scan above 256 MiB
  (verified with lowered limits only).

## Problems and deviations

- A `Proxy` over `fs.constants` to hide `O_NOFOLLOW` threw an uncoded `TypeError` (proxy
  invariant: `fs.constants` is frozen); the test mock uses a copied object with a getter (lesson).
- No deviation from the maintainer's decisions.

## Lessons recorded

- [2026-10-19 — A missing open flag ORs to 0 silently — verify the opened handle's identity instead](../lessons/2026-10-19-verify-opened-file-identity.md)

## Follow-ups

- Independent review of `871393c`: APPROVE with minors and nits (Windows file IDs, this log's
  overclaim, `O_NOFOLLOW`/`O_NONBLOCK` tests, error messages). A second Codex review of `871393c`
  found two medium issues (an aborted scan committing during shutdown; sibling homes' symlinked
  agent folders). All of them are handled in
  [2026-10-19-pr-44-second-codex-review.md](2026-10-19-pr-44-second-codex-review.md).
- Filed #47 (FIFO swapped in before the open); fixed in the next round.

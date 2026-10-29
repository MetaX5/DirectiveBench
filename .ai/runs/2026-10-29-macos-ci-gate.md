---
title: macOS unit-test gate in CI (issue 120)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request ("120"), via om-auto-fix-issue 120
status: in-progress
branch: feat/issue-120-macos-windows-ci
specs: [SPEC-012]
---

# Run: macOS unit-test gate in CI (issue 120)

## Objective

Issue #120: run the full unit suite with the 100% threshold on macOS and Windows as required
checks, fix the three macOS failures found by hand, list every Windows skip with a reason, and
record the gates in SPEC-012.

## Plan

1. Probe: add `macos-latest` and `windows-latest` jobs on a draft PR, so the runners give the
   real failures (the work machine is Linux).
2. Fix every macOS failure at its root cause, red first where it can be reproduced on Linux.
3. Decide the Windows scope from the inventory.
4. SPEC-012, lesson, run log, review, PR.

## Decisions

- **One PR, no separate spec PR** (the maintainer chose this in chat): the issue itself says to
  record the gates in SPEC-012, which this PR updates.
- **Platform jobs run on every PR** (the maintainer's choice), as required checks.
- **Windows moved to its own issue (#160)** (the maintainer's choice). The first full Windows
  run failed 154 tests in 6 packages, 30 of them with "git was not found on PATH", and coverage
  fell to 61-99%: days of work, and best effort under NFR-118-04. #48 is closed as replaced by #160.
- **`--continue` on the macOS job**, so every package reports its failures; the first probe
  stopped at the first failing package.
- **Perl for `setsid`** rather than Node: the command assertions run with an environment
  allowlist, and Perl is on the Linux and macOS runners and on developer machines.

## Work performed

1. `ci: run the unit tests on macOS and Windows` and `--continue`; probe runs 40950352308 and
   40950867608.
2. macOS failures and fixes:
   - `agent-adapters` escape-session test and two `benchmark-engine` command tests: `setsid`
     is missing on macOS; replaced by `perl -MPOSIX -e 'setsid() …; exec @ARGV'`.
   - `benchmark-engine` exit 137: with `setsid` missing, stdout was empty and
     `process.kill(Number(''))` became `kill(0)`, which SIGKILLed vitest and turbo. The tests
     now require a positive pid before killing.
   - `agent-adapters` kill-escalation tests (the issue's EPERM and kill-grace failures, plus two
     with the same pattern): the fixed 100-200 ms timeout raced the fake's start. They now
     abort with a `TimeoutError` after the fake wrote its pid, i.e. after its `trap`.
   - `runner` "rejects a file name that is not valid UTF-8": APFS rejects the name (`EILSEQ`).
     The name is now committed through the git index (`FixtureRemote.commitRawPath`), and the
     test runs on every platform.
   - `web` "groups many distinct keys in linear time": a hand-made wall-clock ratio measured
     48 > 40. Moved to the shared `expectLinearTime` helper.
3. Windows job removed; issue #160 filed with the inventory by package and by error.
4. SPEC-012 §8 and §9; lesson `2026-10-29-tests-must-run-on-macos-too.md`.

## Verification

| Check | Result |
| --- | --- |
| Red first, kill race on Linux: a `sleep 0.3` before the fake's `trap` | old tests: 4 failed (SIGTERM instead of SIGKILL, one 10 s pid wait); new tests: 26 passed |
| Red first, UTF-8 test: decoder made lenient | the new raw-path test fails; restored, it passes |
| Red first, linear-time test: `run` made quadratic | ratio 13.2 > 3.5, it fails |
| macOS CI before the fixes (run 40950867608) | 4 packages failed: agent-adapters 1, runner 1 (coverage 99.86%), web 1, benchmark-engine killed (137) |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (Linux) | pass, 100% coverage |
| macOS CI after the fixes | see the PR |

Not verified: a real Mac outside CI; Windows (issue #160).

## Problems and deviations

- The issue's EPERM and kill-grace failures did not reproduce in the first CI run on macOS (they
  passed there); the escape-session failure did. The race was reproduced on Linux with a
  delayed start instead.

## Review

- **Codex adversarial review, round 1 (needs-attention, 2 × P2, both confirmed):**
  - The escalation test measured the grace from the spawn, so a slow start could hide a SIGKILL
    sent without waiting. It now measures from the abort. Red first: with the grace set to 0 and
    a 0.4 s start, it fails (12.8 ms < 290).
  - SPEC-012 called the macOS job required, but branch protection does not enforce it yet. The
    spec now says so; the setting waits for the maintainer.

## Lessons recorded

- [Tests must run on macOS too; never kill a pid parsed from output without checking it](../lessons/2026-10-29-tests-must-run-on-macos-too.md)

## Follow-ups

- Issue #160: Windows unit gate.
- Make `Unit tests (100% coverage, macOS)` a required check in the `main` branch protection (a
  repository setting; needs the maintainer's go-ahead).

---
title: Excluding items from a budget must not leave the work they cost unbounded
date: 2026-10-21
tags: [security, limits, git, runner]
source: .ai/runs/2026-10-21-issue-61-hosted-fetch-deviations.md
---

# Excluding items from a budget must not leave the work they cost unbounded

## Context

PR #73 stopped counting binary candidate blobs toward `maxScanBytes`, so a hosted scan matches
the local walker. `maxScanBytes` had also been the only bound on how many bytes step 5 reads, and
each 32 MiB batch had its own fresh read timeout. The Codex adversarial review found that a public
repository of 50 000 distinct, highly compressible 5 MiB binaries fits in the 500 MiB cache and
costs about 244 GiB of inflating and reading, holding the single long-job slot for hours. The
first security review had even accepted "step 5 has no total byte cap" as intended.

## Lesson

A budget usually bounds two things at once: what is *kept* (memory, results) and what is *done*
(bytes downloaded, inflated, read, time spent). Exempting items from it to fix the first silently
removes the second. Per-batch timeouts do not bound the total either: the work grows with the
number of batches.

## How to apply

- When you exclude anything from a limit, list every cost the limit was bounding and give each
  remaining one a named bound of its own (here `HOSTED_READ_TOTAL_BYTES` for all loadable blobs,
  binary included, and `HOSTED_GIT_TIMEOUTS.readTotal` across all batches).
- Check a size bound before the work, from sizes already known (step 4's `cat-file --batch-check`),
  and fail closed with a fixed message.
- Pair per-batch timeouts with one deadline that spans all batches.
- Ask whether the input is amplified (compression): the local walker reads plain files once and
  needs no such cap; a compressed download does.
- Test with many distinct, compressible items over a lowered limit, and assert the work was not
  started (no read calls), not just that the scan failed.

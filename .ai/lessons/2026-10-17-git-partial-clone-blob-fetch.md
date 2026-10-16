---
title: Fetching blobs by ID into a shallow partial clone needs noop negotiation, and lazy fetch spawns processes
date: 2026-10-17
tags: [git, security, repository-sync]
source: .ai/runs/2026-10-17-spec-105-partial-fetch.md
---

# Fetching blobs by ID into a shallow partial clone needs noop negotiation, and lazy fetch spawns processes

## Context

While specifying SPEC-105 §9.1 (fetch only candidate paths), a local experiment with git 2.48 and a
`file://` bare remote showed:

- `git fetch --stdin origin` with blob object IDs on stdin, run in a `--depth 1 --filter=blob:none`
  bare clone, fails with `fatal: bad revision '<oid>'` and "did not send all necessary objects".
  Adding `-c fetch.negotiationAlgorithm=noop` (what git itself uses for lazy fetches) makes it
  download exactly the requested blobs.
- Reading a missing blob (`cat-file`, `ls-tree --long`) in a promisor repository silently runs
  `git fetch` and then `git maintenance run --auto --detach`. `GIT_NO_LAZY_FETCH=1` (git ≥ 2.44)
  turns the read into an error; `ls-tree --long` then prints `BAD` sizes.
- In a bare partial clone the promisor settings are `remote.origin.promisor=true` and
  `remote.origin.partialclonefilter`, not `extensions.partialClone`.
- The test remote needs `uploadpack.allowFilter=true` or the filter is ignored.

## Lesson

Blob-by-ID fetches into a shallow partial clone need `fetch.negotiationAlgorithm=noop`; any read in
a promisor repository can trigger network access and background processes unless lazy fetching is
disabled.

## How to apply

In `packages/git-providers`, fetch candidate blobs explicitly in one `fetch --stdin` call with
`-c fetch.negotiationAlgorithm=noop -c maintenance.auto=false -c gc.auto=0`, and run every read
(`ls-tree`, `cat-file`) with `GIT_NO_LAZY_FETCH=1`. Do not use `ls-tree --long` before the blobs
are present. Configure fixture remotes with `uploadpack.allowFilter=true`.

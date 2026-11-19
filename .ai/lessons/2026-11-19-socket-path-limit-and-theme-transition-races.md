---
title: Test special files without Unix sockets, and scan contrast only on settled colours
date: 2026-11-19
tags: [testing, ci, flaky, macos, e2e, contrast]
source: .ai/runs/2026-11-19-ci-socket-path-and-theme-transition.md
---

# Test special files without Unix sockets, and scan contrast only on settled colours

## Context

Issue 270, found on Dependabot PRs 268 and 269; neither failure came from the bumped dependency.

1. Two core tests created a Unix socket under `os.tmpdir()` to check that discovery ignores
   entries that are neither files, directories nor links. The runner image
   `macos-26-arm64/20261112.0504` has a longer `TMPDIR`, so the socket path reached 111 bytes,
   above the `sun_path` limit (104 bytes on macOS, 108 on Linux). `server.listen` emitted
   `EINVAL`, the test never listened for `error`, and it hung until the 5 s Vitest timeout.
2. `repository-branch.spec.ts` switched the theme with `page.emulateMedia({ colorScheme })` and
   scanned text contrast at once. next-themes disables transitions only until its next 1 ms
   timer, so on a loaded runner a later style recalculation still started the navigation
   links' `transition-colors`, and the scan read mid-transition colours (ratio 2.5 to 4.4).
   It failed 1 in 30 under CPU load and never unloaded.

## Lesson

- A Unix socket path has a hard length limit that depends on the OS and on `TMPDIR`, which CI
  images change without notice. A `listen()` without an `error` handler turns that failure
  into a silent timeout.
- A contrast measurement taken while a CSS transition runs measures neither theme. A theme
  library's "disable transitions on change" is a timer, not a guarantee.

## How to apply

- For a "special file" fixture, use a FIFO (`execFileSync('mkfifo', [path])`): same kind for
  `Dirent` checks, no path limit, and it throws synchronously instead of hanging. Never open
  it in the code under test (a FIFO read blocks). If a socket is unavoidable, check its path
  length against 104 bytes and reject the promise on `error`.
- Reproduce path-length bugs on Linux with a long `TMPDIR` (path at least 108 bytes).
- `scanTextContrast` (`apps/web/e2e/contrast.ts`) now disables transitions before measuring,
  which cancels running ones; any other colour measurement after a theme switch or hover does
  the same (`* { transition: none !important; }`), as `ui-contrast.spec.ts` does.
- Prove a race fix deterministically where possible (stretch every transition to make the race
  certain), and with `--repeat-each 30 --workers 1` under `yes` load pinned by `taskset`.

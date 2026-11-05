---
title: Inject a real database error with a SQLite trigger, not a mock of the repository function
date: 2026-11-05
tags: [testing, database, runner]
source: .ai/runs/2026-11-05-issue-70-fixed-unexpected-job-failure.md
---

# Inject a real database error with a SQLite trigger, not a mock of the repository function

## Context

Issue #70 needed regression tests in which `registerHostedRepository`, a scan's apply and
`markRepositoryScanFailed` fail the way they do in production, so the runner's generic catch
sees Drizzle's real error shape. Mocking `@directivebench/database` exports from the runner tests
would have replaced that shape with one the test invented. Drizzle's error is `Failed query: …
params: …`, and the SQLite error is its `cause`.

## Lesson

`create trigger injected_failure before insert|update on <table> begin select raise(abort,
'<text>'); end` makes the next real write fail inside SQLite, through Drizzle and any
`withTransaction`, with an error whose `cause.message` is `<text>`. It needs no module mock,
so it works for local and hosted jobs and for writes made deep inside the engine (for example
`agent_runs` during a benchmark).

## How to apply

- To fail a write in a runner, database or CLI test, add a trigger on the table after migrating
  (`handle.sqlite.exec(...)`), and put a marker in its text (such as an absolute path) so the test
  can assert that the text never reaches a stored or displayed message.
- Use `before update` when the write you want to fail is an update. The same trigger then also
  fails any later update of that table, such as the write that records the failure, which is
  often the case you want to cover.
- Assert on the cause's message (the SQLite text), not on Drizzle's `Failed query` wrapper.

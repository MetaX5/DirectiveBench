# AI run logs

Every **autonomous AI run** that changes this repository leaves a log here — a session in which
an agent plans and executes multi-step work (implementing a spec, a bootstrap, a refactor, a bug
fix across files) rather than answering a single question.

- File name: `YYYY-MM-DD-<slug>.md` — the date the run started and a short kebab-case slug.
  If two runs share a date and topic, add a suffix (`-2`).
- Start from [`../templates/run-log.template.md`](../templates/run-log.template.md).
- Create the file at the start of the run (`status: in-progress`), keep it updated, and finalise
  it before the run ends (`completed`, `partial`, `failed` or `aborted`).
- Commit the log together with the run's changes (or in the same pull request).
- Write facts: what was done, which commands verified it and their real results, what was not
  verified. Never include secrets, tokens or personal data.
- Lessons worth keeping beyond the run go to [`../lessons.md`](../lessons.md); the log links to them.

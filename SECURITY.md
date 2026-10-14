# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through
GitHub's [private vulnerability reporting](https://github.com/MetaX5/DirectiveBench/security/advisories/new)
for this repository, with steps to reproduce and the affected version or commit.

DirectiveBench is an early-stage project maintained on a best-effort basis; there is no formal
response-time commitment yet. Only the latest commit on `main` receives fixes.

## Security model (current release)

- The web UI binds to `127.0.0.1` by default and has **no authentication**. Binding to another
  address requires `--allow-network-access`. Requests with an unexpected `Host` header are
  rejected to mitigate DNS-rebinding attacks.
- Benchmark commands run in the `local-process` environment, which is **not a sandbox**: they run
  with your user account's permissions. Only suite versions approved for execution may run
  commands; today only the bundled example is approved. Docker-based isolation is planned.
- Commands are executed without a shell, with a minimal environment (no inherited secrets) and a
  per-run `HOME`; output is truncated and secret-redacted before it is stored.
- Fixture snapshots and artifact files reject symbolic links and paths that escape their root.
- No credentials are stored in this release. Planned API-key storage uses the OS credential
  store; agent CLI session credentials are never copied.
- Scripts found in imported repositories are never executed automatically.

Details: [`.ai/specs/2026-10-14-security-and-privacy.md`](.ai/specs/2026-10-14-security-and-privacy.md).

# ADR-0010: MIT license

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Project overview](../specs/foundation/project-overview.md),
  [`LICENSE`](../../LICENSE)

## Context

DirectiveBench is an open-source developer tool distributed via npm and intended to be embedded in
team workflows, CI and possibly internal forks. The repository owner committed a `LICENSE` file with
the MIT License text and a copyright line at repository creation. Package manifests and contribution
rules need to state the license consistently.

## Decision

- The project is licensed under the **MIT License**.
- The existing [`LICENSE`](../../LICENSE) file is **kept unchanged**, including the copyright line
  as committed by the repository owner. Tooling and contributors must not rewrite it or add
  copyright holders.
- Every `package.json` in the workspace declares `"license": "MIT"`. The published `directivebench`
  package includes the `LICENSE` file in its tarball.
- Contributions are accepted under the same MIT License (**inbound = outbound**); no CLA is required.
  This is stated in contribution guidelines.
- Third-party dependencies must have licenses compatible with MIT distribution; bundled third-party
  code (e.g. copy-in shadcn/ui components, which are MIT) keeps its notices where required.

## Alternatives considered

- **Apache-2.0.** Explicit patent grant and NOTICE handling; more process for contributors and
  downstream users. The repository was already published with MIT.
- **GPL/AGPL.** Copyleft would deter adoption inside companies and in internal forks; AGPL would be
  relevant mainly for a hosted service, which is not a goal ([ADR-0001](0001-local-first-architecture.md)).
- **Source-available / BSL.** Not open source; conflicts with project intent.
- **CLA-based contributions.** Adds friction; not needed for an MIT project without dual licensing.

## Benefits

- Maximum permissiveness; simple for companies to adopt and modify.
- Compatible with nearly all npm dependencies.
- Inbound = outbound keeps contribution friction minimal.

## Drawbacks

- No explicit patent grant.
- Anyone, including competitors, can ship proprietary derivatives.
- Relicensing later would need consent from contributors (no CLA).

## Consequences

- CI or review should check that new dependencies use MIT-compatible licenses.
- The README states the license and links to `LICENSE`.

## Status

Accepted.

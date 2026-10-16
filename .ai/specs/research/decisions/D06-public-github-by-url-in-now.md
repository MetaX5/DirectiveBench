# D06 — Now includes registering a public GitHub repository by URL

- Date, owner: 2026-10-16, Mateusz Minkiewicz (maintainer)
- Context and the options weighed: after the dry-run backlog the maintainer asked why whole
  repositories should be stored when skills could be fetched as needed. The agent explained
  that no repository is stored in the database (only artifact files, locations and metadata),
  proposed resolving SPEC-105 OQ-105-04 by fetching only candidate paths (partial clone), and
  asked whether the first backlog should register repositories by URL — in the simplest form a
  public GitHub repository without credentials (SPEC-013 M2 acceptance criterion 1).
- Decision and why: yes to registering a public repository by URL in Now ("tak"); private
  repositories with credentials are not needed yet ("na razie nie - to może zostać dodane
  później").
- Consequences, and what would make us revisit it: Now gains one story — a public GitHub
  repository added by URL is fetched without credentials and scanned. Fetching only candidate
  paths (partial clone) was the agent's proposal, framed as part of that story and accepted with
  it; SPEC-105 FR-105-05 and OQ-105-04 must be updated before it is implemented. Private
  repositories, tokens in the OS keychain and GitLab stay Later.
- Status: active
- Origin: the maintainer's answer to the agent's question; the partial-clone approach originated
  as the agent's recommendation.

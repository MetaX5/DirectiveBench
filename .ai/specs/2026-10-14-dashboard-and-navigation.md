---
id: SPEC-116
title: Dashboard and Navigation
status: draft
created: 2026-10-14
updated: 2026-10-14
category: feature
related: [SPEC-101, SPEC-104, SPEC-106, SPEC-107, SPEC-109, SPEC-113, SPEC-114, SPEC-115, SPEC-203, SPEC-206, SPEC-008]
---

# SPEC-116 — Dashboard and Navigation

## 1. Summary

This spec defines the information architecture of the DirectiveBench web UI: the top-level sections, sidebar navigation, the dashboard and its widgets, empty states, theming (dark/light), compact density, honest "not implemented" pages that link to specs, the rule that no decorative non-functional controls are rendered, and accessibility basics.

## 2. Motivation and problem statement

DirectiveBench's scope is broad (repositories, artifacts, categories, benchmarks, executions, results, agents, model providers), while the bootstrap implements only part of it. The UI must make the implemented parts efficient for developers and make the unimplemented parts visible **without pretending** they work. Fake buttons, placeholder charts and invented numbers erode trust in a tool whose purpose is trustworthy measurement.

## 3. Goals

- Stable navigation covering the full product scope.
- A dashboard built only from real data.
- Honest placeholders for planned sections, each linking to its spec.
- Developer-friendly density, dark/light theme, keyboard accessibility.

## 4. Non-goals

- Marketing/landing pages, onboarding tours.
- Customizable dashboards (future).
- Mobile-first layout (responsive basics only; desktop is primary).

## 5. User stories

- As a new user after `npx directivebench`, I see an empty dashboard that tells me how to load the demo (`directivebench demo`) or import examples.
- As a user, I see counts of my artifacts by type and the last benchmark runs at a glance.
- As a user, I click "Repositories" and learn it is planned, with a link to the spec, instead of a broken form.
- As a keyboard user, I navigate the sidebar and tables without a mouse.
- As a user working at night, the UI follows my OS dark mode.

## 6. Functional requirements

### Sections and navigation

| ID | Requirement |
|---|---|
| FR-116-01 | The sidebar SHALL list, in order: Dashboard, Repositories, Artifacts, Categories, Benchmarks, Benchmark Builder, Executions, Results, Agent Connections, Model Providers, Settings. |
| FR-116-02 | Each sidebar item SHALL show an icon (lucide-react) and a text label; the active item is indicated by more than colour (e.g. weight + indicator bar + `aria-current="page"`). |
| FR-116-03 | Items whose section is not implemented SHALL show a small "Planned" tag in the sidebar. |
| FR-116-04 | The sidebar SHALL be collapsible to icons with tooltips; state remembered per browser. |
| FR-116-05 | Header SHALL show the app name, a theme toggle, and an environment indicator when bound to a non-loopback host ("Network access enabled — no authentication"). |

| Section | Route | Bootstrap behaviour | Spec |
|---|---|---|---|
| Dashboard | `/` | Real counts, recent runs | this spec |
| Repositories | `/repositories` | Planned page | [SPEC-104](2026-10-14-repository-management.md) |
| Artifacts | `/artifacts` | List + detail | [SPEC-101](2026-10-14-artifact-registry.md) |
| Categories | `/categories` | Read-only list | [SPEC-106](2026-10-14-category-management.md) |
| Benchmarks | `/benchmarks` | List + detail + "Run benchmark" | [SPEC-107](2026-10-14-benchmark-engine.md) |
| Benchmark Builder | `/builder` | Planned page | [SPEC-109](2026-10-14-benchmark-builder.md) |
| Executions | `/executions` | Jobs list with cancel | [SPEC-114](2026-10-14-runner-management.md) |
| Results | `/results`, `/runs/[id]` | Completed runs; run detail | [SPEC-113](2026-10-14-results-and-reporting.md) |
| Agent Connections | `/agents` | Real CLI detection; execution "not implemented" | [SPEC-203](2026-10-14-integration-claude-code.md), [SPEC-204](2026-10-14-integration-openai-codex.md), [SPEC-205](2026-10-14-integration-cursor.md) |
| Model Providers | `/model-providers` | Planned page | [SPEC-206](2026-10-14-integration-anthropic-api.md), [SPEC-211](2026-10-14-integration-custom-model-providers.md) |
| Settings | `/settings` | Read-only data dir paths and effective configuration; editing planned | [SPEC-115](2026-10-14-settings-and-configuration.md) |

Route names are indicative; the implementation in `apps/web/app` is authoritative once present.

### Dashboard widgets

| ID | Requirement |
|---|---|
| FR-116-10 | The dashboard SHALL show, from SQLite only: repository count, artifact count, skill count, rule count, instruction count, last sync time (or "never"), recent executions (last 5–10 jobs with status), successful evaluations count, failed evaluations count, recent regressions. |
| FR-116-11 | "Successful evaluations" SHALL count completed benchmark runs with display status `passed`; "failed evaluations" SHALL count display statuses `failed`, `regression`, `error`; `unstable` and `not-comparable` are shown separately or excluded with a note — never merged into success ([SPEC-111](2026-10-14-benchmark-scoring.md)). |
| FR-116-12 | "Recent regressions" SHALL list benchmark runs with display status `regression` and version regressions (when implemented, [SPEC-111](2026-10-14-benchmark-scoring.md) FR-111-50…52). |
| FR-116-13 | Widgets whose data source is not implemented (e.g. last sync, repositories) SHALL show the real value (0 / "never") with a "Sync not implemented yet" hint, not invented data. |
| FR-116-14 | Counts and lists that include Mock Agent results SHALL mark them (e.g. "mock" tag); mock and real results are not merged into one success metric without the label. |
| FR-116-15 | Each widget SHALL link to its section (e.g. artifact count → `/artifacts?type=skill`). |

### Empty states and placeholders

| ID | Requirement |
|---|---|
| FR-116-20 | Every list SHALL have an empty state explaining what the section contains and the next real action (e.g. "Run `directivebench demo` to import an example artifact and benchmark"). |
| FR-116-21 | "Not implemented" pages SHALL contain: title, one-paragraph description of the planned feature, the label "Planned — not implemented", links to the relevant spec files, and no interactive controls besides links. |
| FR-116-22 | The UI SHALL NOT render decorative non-functional buttons, disabled-forever forms, fake charts or sample data. A disabled control is allowed only with a visible reason (e.g. "Execution not implemented for Claude Code"). |
| FR-116-23 | Links to specs SHALL point to the repository files (relative repo path shown, e.g. `.ai/specs/2026-10-14-benchmark-builder.md`, with a GitHub link when the repository URL is known). |

### Theme, density, accessibility

| ID | Requirement |
|---|---|
| FR-116-30 | Dark and light themes SHALL be supported; default follows `prefers-color-scheme`; manual override stored per browser; no flash of incorrect theme on load. |
| FR-116-31 | Default density SHALL be compact (tables with ~32–36 px rows, 13–14 px body text) suited to developer tools. |
| FR-116-32 | All interactive elements SHALL be keyboard reachable with visible focus; skip-to-content link; landmarks (`nav`, `main`); semantic tables with headers. |
| FR-116-33 | Text contrast SHALL meet WCAG 2.2 AA in both themes; status is never conveyed by colour alone. |
| FR-116-34 | Respect `prefers-reduced-motion`. |

## 7. Non-functional requirements

- Dashboard renders server-side from SQLite in < 300 ms for 10k artifacts / 1k runs.
- No external network requests (fonts, analytics, CDNs) — local-first ([ADR 0001](../decisions/0001-local-first-architecture.md)).
- Components from shadcn/ui (copied in) + Tailwind CSS 4 ([SPEC-004](2026-10-14-technology-stack.md)).

## 8. Domain entities and contracts

```ts
interface DashboardSummary {
  repositories: number;
  artifacts: { total: number; skill: number; rule: number; instruction: number };
  lastSyncAt: string | null;                         // max(repositories.last_sync_at)
  recentJobs: { id: string; status: JobStatus; createdAt: string; finishedAt: string | null;
                suiteName: string; artifactName: string }[];
  evaluations: { passed: number; failed: number; unstable: number; notComparable: number; mockOnly: number };
  recentRegressions: { benchmarkRunId: string; artifactName: string; suiteName: string; delta: number; at: string;
                       kind: "red-green" | "version" }[];
}

interface NavItem { href: string; label: string; icon: string; implemented: boolean; specPath?: string }
```

Artifact types follow `artifacts.type` (`skill` | `instruction` | `rule`) in `packages/database/src/schema.ts`.

## 9. Data flow

```mermaid
flowchart LR
  DB[(SQLite)] --> Q[getDashboardSummary<br/>@directivebench/database]
  Q --> P[Dashboard server component]
  P --> W1[Counts]
  P --> W2[Recent executions]
  P --> W3[Evaluations + regressions]
  NAV[static nav config<br/>implemented flags] --> SB[Sidebar]
```

## 10. API and interface design

- Server components query repository functions directly ([SPEC-008](2026-10-14-api-architecture.md)); no client-side fetching for the dashboard except optional polling of recent jobs (≤ every 3 s while any job is running).
- `getDashboardSummary(db): Promise<DashboardSummary>` in `@directivebench/database`.
- Navigation config is a single typed array (`NavItem[]`) used by sidebar and placeholder pages.

## 11. UI/UX considerations

- Dashboard layout: top row of count tiles; second row recent executions (table) and evaluations/regressions (list).
- Tiles show number + label + link; zero is a valid, honest value.
- Placeholder pages share one component to keep wording consistent.
- Mock label and "Not sandboxed" badges reuse the shared badge component ([SPEC-113](2026-10-14-results-and-reporting.md)).

## 12. Security considerations

- All rendered user/agent content escaped; artifact Markdown sanitized.
- Network-exposed mode banner (FR-116-05) makes the risk visible ([SPEC-007](2026-10-14-security-and-privacy.md)).
- No third-party assets loaded from the network.

## 13. Error handling

- Database unavailable/locked beyond busy timeout → error boundary with retry link and the data dir path, not a blank page.
- Partial widget failure → that widget shows an inline error; others render.
- Unknown route → 404 page with navigation.

## 14. Edge cases

- Fresh install with zero data → all tiles 0, empty-state guidance visible.
- Only mock results present → evaluations tile shows mock tag.
- Many running jobs → recent executions capped with "view all" link.
- Very long artifact/suite names → truncated with full name in title/tooltip.

## 15. Testing strategy

- Unit: `getDashboardSummary` against seeded SQLite (counts by type, status bucketing).
- Component: placeholder pages contain spec link and no buttons; sidebar `aria-current`.
- E2E (Playwright): navigate all sidebar items; keyboard-only navigation; theme toggle persists; axe accessibility scan with no serious violations.
- Lint-like test: no `<button>` without an `onClick`/form action in placeholder components.

## 16. Acceptance criteria

- [ ] Sidebar shows the 11 sections in order with "Planned" tags for Repositories, Benchmark Builder, Model Providers.
- [ ] Dashboard numbers equal SQL counts on seeded data; no hard-coded or sample values.
- [ ] Each planned page shows "Planned — not implemented" and a link to its spec, and contains no non-link controls.
- [ ] Dark/light theme follows OS by default and can be toggled; no theme flash.
- [ ] Keyboard-only user can reach every interactive element; focus is visible.
- [ ] Mock results on the dashboard carry the mock label.

## 17. Dependencies

[SPEC-113](2026-10-14-results-and-reporting.md), [SPEC-114](2026-10-14-runner-management.md), [SPEC-111](2026-10-14-benchmark-scoring.md), [SPEC-101](2026-10-14-artifact-registry.md), [SPEC-104](2026-10-14-repository-management.md), [SPEC-115](2026-10-14-settings-and-configuration.md), [SPEC-004](2026-10-14-technology-stack.md), [SPEC-008](2026-10-14-api-architecture.md).

## 18. Open questions

- Should Results and Executions merge into one section once history grows?
- Should density be user-switchable (compact/comfortable) in the bootstrap?
- How should "last sync" be presented when multiple repositories have different sync times (latest vs. oldest)?

## 19. Future extensions

- Command palette (⌘K) for navigation and actions.
- Customizable dashboard widgets; trend charts per comparability key.
- Notifications for completed jobs and new regressions.
- Multi-user context switcher for self-hosted mode.

## 20. Implementation status

- **Implemented in `apps/web` (verified by `pnpm test:e2e` (`apps/web/e2e/smoke.spec.ts`, 6/6 passing against the built CLI) for the dashboard, artifact list/detail, run detail, benchmark Run → completed, a planned page and the theme toggle; by `pnpm verify:pack` for `/results`; other pages are present but not covered by a test):** sidebar with all sections (`nav.tsx`, planned entries marked); Dashboard with real counts and recent runs; Artifacts, Categories (read-only), Benchmarks (detail with Run button → enqueue server action), Executions (cancel, 2 s auto-refresh while active), Results and run detail pages; Agent Connections with real CLI detection and the Mock Agent; read-only Settings (data dir and effective config); "Planned — not implemented" pages for Repositories, Benchmark Builder and Model Providers linking to specs; dark/light theme (`next-themes`); no decorative buttons.
- **Partially implemented:** dashboard widgets — successful/failed evaluations and recent regressions depend on stored verdicts; version regressions are not implemented; last sync always "never" because sync is not implemented. Compact density and accessibility baseline not yet checked by an automated scan.
- **Not implemented:** collapsible sidebar persistence, network-exposure banner in the UI (the warning is printed by the CLI only), command palette, customizable widgets, axe accessibility scan.

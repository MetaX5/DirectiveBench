# DirectiveBench — product brief

- Date: 2026-10-16
- Mode: own; Owner: Mateusz Minkiewicz (maintainer); Pass: full
- Evidence basis: one first-hand account from the maintainer, who is also the builder; six decisions the maintainer confirmed on 2026-10-15 and 2026-10-16; specs that describe what is planned, not what users need; two reference products checked on 2026-10-15. No colleague, outside-user, usage or support material yet. Most consequential untested belief: DirectiveBench's verdicts will predict real-project outcomes (A03).
- Coverage: 26 claims — 22 sourced (interview 6, data 1, document 7, product 6, benchmark 2), 0 synthetic, 4 assumed; 2 entries on the collection plan
- Synthetic hypotheses outside Coverage: 0
- Definition of Ready signed by: not yet signed; `SDLC.md` has no Definition of Ready section. Ready for: implementation planning of Now (the repository-based Registry); research before the comparison work and any team-facing scope.
- Sources: `research/interviews/2026-10-15-skill-author-maintainer.md`, `research/decisions/`, [SPEC-001](2026-10-14-project-overview.md), [SPEC-013](2026-10-14-implementation-roadmap.md), [SPEC-101](2026-10-14-artifact-registry.md), [SPEC-102](2026-10-14-artifact-discovery.md), [SPEC-104](2026-10-14-repository-management.md), [SPEC-112](2026-10-14-red-green-evaluation.md), [SPEC-113](2026-10-14-results-and-reporting.md)

## Decision summary

The next backlog builds the Artifact Registry (roadmap M1) first, so the maintainer can see and preview their skills in one place (D01, active); it includes adding a public GitHub repository by URL (D06).

The observed problem is different — judging whether a skill update helped is hard and slow (Problems); the agent recommended addressing it first, the maintainer kept the Registry first (D01, A02). Benchmarking later covers single skills and chains (D02).

The skills the maintainer updates live in the client projects' repositories, and reading skills from repositories is the product's premise (D04), so the Registry as specified covers them. User-level folders such as `~/.claude/skills` become an opt-in option, off by default, for checking how global skills interact with a project (D05); the brief places it with the comparison work.

Later uncertainty: whether verdicts match real projects (D03, A03) and whether Promptfoo already covers the comparison need (A04).

Next: plan the Registry backlog. In parallel the maintainer tries Promptfoo on one own skill and interviews colleagues (Collection plan).

## Vision

Skill authors see all their skills, instructions and rules in one place and know, before relying on a change, whether it makes their agent's work better or worse. `[PRODUCT]` [SPEC-001 §2–3](2026-10-14-project-overview.md)

## Target group and stakeholders

- Customer (pays): none; free and MIT-licensed. `[PRODUCT]` [SPEC-001 §1](2026-10-14-project-overview.md)
- User (uses): first user is the maintainer, who updates their own skills and uses them in client projects. `[INTERVIEW]` [interview](research/interviews/2026-10-15-skill-author-maintainer.md)
- Colleagues (PMs, developers, testers "and maybe someone else"): see A01.
- Stakeholders and decider for scope: Mateusz Minkiewicz (maintainer).

## Problems, with evidence

- After updating a skill and trying it in a client project, it was hard to tell whether the update was better or worse, and working it out took a lot of time; frequency and time were not stated. One account. `[INTERVIEW]` [interview](research/interviews/2026-10-15-skill-author-maintainer.md)
- Skills not working as expected became visible only after the agent failed. `[INTERVIEW]` [interview](research/interviews/2026-10-15-skill-author-maintainer.md)
- The maintainer wants a visible base of skills with a preview in one place; a stated want, no incident described. `[INTERVIEW]` [D01](research/decisions/D01-registry-first.md)
- The skills the maintainer updates for client projects live in those projects' repositories. `[INTERVIEW]` [interview addendum](research/interviews/2026-10-15-skill-author-maintainer.md)
- On 2026-10-15, `~/.claude/skills` held 38 `SKILL.md` files outside its `.trash` folder (19 top-level folders, 18 claude.ai-synced skills, one symlink into this repo); this repo's `.agents/skills` held 42 installed `om-*` skills. Which of these the maintainer wrote or updates is unknown. `[DATA]` directory listing on the maintainer's machine, 2026-10-15

## Product and how it stands out

- What it is: a local-first workbench that discovers skills, instructions and rules and runs an agent with and without one (RED/GREEN); see Scope. `[PRODUCT]` [SPEC-001](2026-10-14-project-overview.md)
- What makes it different: not established (A04).

| reference | what it does well | where it falls short for our users | checked on | link |
|---|---|---|---|---|
| Promptfoo — "Test agent skills" guide | Compares two versions of a `SKILL.md` with the Claude Agent SDK, Codex SDK or OpenCode, swapping only the skill; optional repeats; deterministic and trace assertions. `[BENCHMARK]` | Its example swaps the skill between two small fixture directories; it does not show a without-the-skill baseline or a catalogue of skills. Whether that matters is untested (A04). | 2026-10-15 | https://www.promptfoo.dev/docs/guides/test-agent-skills/ |
| SkillsBench (arXiv 2602.12670) | Research benchmark, 86 tasks published, 84 evaluated: curated skills against none; average gain reported as 16.2 points (the paper's figure shows 12.66), 4.5 in software engineering; 16 of 84 tasks got worse. `[BENCHMARK]` | A study on fixed tasks, not a tool for one's own skills; shows skill effects vary and can be negative. | 2026-10-15 | https://arxiv.org/html/2602.12670v1 |

## Goals and success criteria

- Business goal: none set; open source, no revenue goal.
- User outcome: DirectiveBench is worth continuing if its verdicts are confirmed later in real projects. `[DOCUMENT]` [D03](research/decisions/D03-success-means-verdicts-hold-in-real-projects.md)
- Outcome for Now: the maintainer sees and previews their skills in one place (D01).
- Metric, baseline, threshold, date: none set (D03).
- What must not get worse: local-first, no telemetry, nothing executed from imported repositories. `[PRODUCT]` [SPEC-001 §6](2026-10-14-project-overview.md)

## Scope

- **Now:** the Artifact Registry as roadmap M1 defines it — register local repositories and directories, discover, browse, filter, preview content, version on change, categories (D01); plus adding a public GitHub repository by URL, fetched without credentials and limited to candidate paths (D06; SPEC-105 FR-105-05 and OQ-105-04 change first). User-level folders stay out of Now, as SPEC-102 §3 already says (D04, D05). `[PRODUCT]` [SPEC-013 M1](2026-10-14-implementation-roadmap.md), [SPEC-102 §3](2026-10-14-artifact-discovery.md)
- **Later:** real-agent RED/GREEN runs per skill version with regression highlighting in history (M3, M4); a hand-written suite per skill until the builder (M5); direct version-against-version comparison is a future "A/B mode". Whether this solves the observed problem is A03. `[PRODUCT]` [SPEC-112 §4, §19](2026-10-14-red-green-evaluation.md), [SPEC-113](2026-10-14-results-and-reporting.md). Also chains of skills (D02, needs its own spec); opt-in scanning of user-level skill folders, off by default, to see how global skills interact with a project (D05); private repositories with credentials and GitLab (rest of M2, D06), M6–M8.
- **Not doing:** see Non-goals.

## Domain glossary

Terms are defined in [SPEC-001 §7](2026-10-14-project-overview.md); "chain of skills" in D02.

## Key flows

- Current state: the maintainer updates a skill, uses it in a client project and learns it misbehaves when the agent fails. `[INTERVIEW]` [interview](research/interviews/2026-10-15-skill-author-maintainer.md)
- Future state: Now's flow is specified in SPEC-101 and SPEC-104.

## Business rules

| Id | Rule | Applies to | Source | Status | Review by | Required path to change | Owner | Supersedes |
|---|---|---|---|---|---|---|---|---|

None set this session; SPEC-001 §6 principles apply.

## Non-goals

| Id | We are not building | Why | Owner | Status | Review by | Required path to change | Source | Supersedes |
|---|---|---|---|---|---|---|---|---|

None agreed this session; the specs' out-of-scope lists apply.

## Decisions

Changing any row needs a superseding row approved by the maintainer.

| Id | Date | Decision | Why | Owner | Status | Review by | Required path to change | Source | Supersedes |
|---|---|---|---|---|---|---|---|---|---|
| D01 | 2026-10-15 | Next backlog builds the Artifact Registry (M1) first; real-agent comparison follows | Wants a visible skill base with preview in one place. Alternative: comparison first, recommended by the agent; the maintainer chose otherwise | Mateusz Minkiewicz | active | when the Registry ships | maintainer | `[DOCUMENT]` [D01](research/decisions/D01-registry-first.md) | none |
| D02 | 2026-10-15 | Benchmarking covers single skills and chains of skills | Answer to whether "our own flow" means one skill or a chain | Mateusz Minkiewicz | active | when comparison work is specified | maintainer | `[DOCUMENT]` [D02](research/decisions/D02-single-skills-and-chains.md) | none |
| D03 | 2026-10-15 | Success means verdicts are confirmed later in real projects | The maintainer's criterion for continuing | Mateusz Minkiewicz | active | unknown | maintainer | `[DOCUMENT]` [D03](research/decisions/D03-success-means-verdicts-hold-in-real-projects.md) | none |
| D04 | 2026-10-16 | Skills are read from project repositories; that is the product's premise | The skills the maintainer updates live in client project repositories | Mateusz Minkiewicz | active | unknown | maintainer | `[DOCUMENT]` [D04](research/decisions/D04-repositories-are-the-source.md) | none |
| D05 | 2026-10-16 | User-level skill folders are an opt-in option, off by default, to check how global skills interact with a project | The maintainer's answer; matches SPEC-102 §3. Placement with the comparison work (Later) is the agent's reading and remains a proposal | Mateusz Minkiewicz | active | when the comparison work is specified | maintainer | `[DOCUMENT]` [D05](research/decisions/D05-user-level-skills-opt-in.md) | none |
| D06 | 2026-10-16 | Now includes registering a public GitHub repository by URL, without credentials; private repositories come later | The maintainer wants to add repositories by URL; private ones are not needed yet. Fetching only candidate paths was the agent's proposal, accepted with the story | Mateusz Minkiewicz | active | when private repositories are needed | maintainer | `[DOCUMENT]` [D06](research/decisions/D06-public-github-by-url-in-now.md) | none |

## Riskiest assumptions

| Id | Assumption | Importance | Evidence today | If false | Smallest test | Owner | By when | Result |
|---|---|---|---|---|---|---|---|---|
| A01 | PMs, developers and testers at the maintainer's company have the same problem and would use the tool `[ASSUMPTION]` maintainer's belief | medium | Only the maintainer's statement | Team-facing scope loses its basis | Interviews (Collection plan) | Mateusz Minkiewicz | unknown | untested |
| A02 | One place to see and preview skills is worth building before the comparison `[ASSUMPTION]` maintainer's stated want | medium | Stated want; no incident | The observed problem stays unaddressed longer | After the Registry ships, note whether the maintainer uses it when working on skills | Mateusz Minkiewicz | unknown | accepted untested (D01) |
| A03 | Verdicts on a skill change will match what later happens in real projects `[ASSUMPTION]` no material | high | None; SkillsBench shows effects vary and can be negative | Confident verdicts that do not help decide | Once runs exist, record each skill update's verdict and the next real-project outcome | Mateusz Minkiewicz | unknown | untested |
| A04 | DirectiveBench gives value Promptfoo does not `[ASSUMPTION]` maintainer's belief | high | Promptfoo row above | The comparison work duplicates a free tool | Promptfoo trial (Collection plan) | Mateusz Minkiewicz | before planning comparison work | untested |

## Kill criteria

Proposal, inverse of D03 (the maintainer stated only the success side): if verdicts do not match real-project outcomes, stop or rethink the comparison work. Not applicable until runs exist; no case count or date set.

## Hypotheses to test

None; no simulated walkthroughs were run.

## Open questions

| Id | Question | Blocking | Who can answer | Status |
|---|---|---|---|---|
| Q01 | Should Now include user-level folders such as `~/.claude/skills`? | no | maintainer | closed 2026-10-16: opt-in, off by default (D05); placement with the comparison work is a proposal |
| Q04 | Where do the skills the maintainer updates for client projects live? | no | maintainer | closed 2026-10-16: in those projects' repositories (D04) |
| Q02 | How often are skills updated, and how long does judging one update take? | no — informs D03's threshold | maintainer | open |
| Q03 | Which agent was used in the client project, and what did the failure look like? | no — informs the first agent adapter | maintainer | open |

## Definition of Ready addendum (own)

Company roles rest only on A01 and are outside Now. Problems and the first user rest on the maintainer's own account. Now rests on D01 and D04 with A02 accepted untested, and is ready for implementation planning. The comparison work is not ready (A04, Q03). `om-setup-discovery-pipeline` adds a Definition of Ready to `SDLC.md`.

## Collection plan

### Do PMs, developers and testers at the company have this problem?

- What decision or work needs it: team-facing scope and chains of the company's flow (A01, D02)
- Who can answer it: two or three colleagues in different roles who use agent skills at work
- How: short interviews about the last time a skill or agent flow behaved unexpectedly
- Owner and by when: Mateusz Minkiewicz; date unknown
- Template: `.ai/specs/research/templates/interview-note.md`

### What does Promptfoo already answer for the maintainer's skills?

- What decision or work needs it: what the comparison work must do differently (A04)
- Who can answer it: the maintainer
- How: follow Promptfoo's "Test agent skills" guide with two versions of one own skill; note what it could not answer
- Owner and by when: Mateusz Minkiewicz; before planning the comparison work
- Template: `.ai/specs/research/templates/benchmark-check.md`

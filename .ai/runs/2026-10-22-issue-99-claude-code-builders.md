---
title: Claude Code adapter pure builders and pre-spawn inspection (SPEC-118 Phase 3 step 1)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 99 (E06-S03-T01), feature route → om-auto-implement-spec → om-auto-create-pr
status: in-progress
branch: feat/issue-99-claude-code-builders
specs: [SPEC-118, SPEC-203]
---

# Run: Claude Code pure builders and pre-spawn inspection (issue #99)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md

## Objective

Implement SPEC-118 §21 Phase 3 step 1 for issue #99 (task of story #96): deterministic pieces of
the Claude Code adapter that decide what runs and refuse everything that could widen the profile
or reach host files, before any `claude` process starts. No process is spawned, no network, no
credentials.

Acceptance criteria used (issue #99 "Done when"): pure functions in `packages/agent-adapters`
covering FR-118-06 (`fixture-contains-claude-config`, every listed path at any depth, fail
closed), FR-118-07 (no bare file-tool allow rule, `Edit(/**)`,
`blockReadsOutsideWorkingDirectories`, no `--add-dir`, `disableSkillShellExecution`), FR-118-08
(`Skill` only for `skill-md`, `baseline-skill-name-differs`), FR-118-26 (`artifact-executes-code`,
`artifact-overrides-model`, candidate and baseline), FR-118-27 (`workspace-imports-outside`,
`workspace-scan-limit`, `WORKSPACE_SCAN_MAX_FILES`/`WORKSPACE_SCAN_MAX_BYTES`, linear-time test),
the env rules of FR-118-02/03, the flags hash of FR-118-04 equal for two workspaces; 100% unit
coverage including the unit-testable parts of AC-16, AC-23, AC-25, AC-26 and AC-27.

Non-goals: stream parsing, `skillActivation`, error normalisation and the engine's
execution-model check (Phase 3 step 2); process control and the fake `claude` (step 3);
readiness and detection `ready`/`missing` (step 4, issue #102, in flight — `detection.ts` is not
touched); the `benchmark` CLI (Phase 4); the `AgentRunRequest`/`AgentRunResult` contract
extensions of SPEC-203 §4.2 (needed by step 2/3, not by pure builders).

## Plan

Goal: a `packages/agent-adapters/src/claude-code/` module with pure builders (argv, flags hash,
env, version, install convention, skill name) and pre-spawn inspection (fixture/workspace
Claude-configuration check, import and link scan, artifact bundle inspection), each fail closed
and unit-tested to 100%.

Risks: the import scan is security-critical and must be linear in workspace size while treating
every `@` as a token (a run of `@` without whitespace makes naive suffix tokens quadratic); paths
must be canonicalised (`realpath`) and unknown existence fails closed; the install must not write
through a symbolic link a `setup` command planted (setup runs before installation); behaviours of
Claude Code that are only assumptions stay marked for the AC-22 live check.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Builders

- [x] 1.1 argv per permission profile and artifact type, `Skill` rules, settings, normalised flags hash, version parser — ebb43d8
- [x] 1.2 env per auth mode (subscription strips credential variables, api-key isolates `HOME`/`CLAUDE_CONFIG_DIR`) — ebb43d8
- [x] 1.3 Install convention (§4.1) with symlink-safe writes, skill name resolution and `baseline-skill-name-differs` — ebb43d8

### Phase 2: Inspection

- [x] 2.1 Artifact bundle inspection (FR-118-26) for candidate and baseline — f449832
- [x] 2.2 Workspace walk with named limits and the Claude-configuration check (FR-118-06) — f449832
- [x] 2.3 Import and link scan (FR-118-27) with a linear-time test — f449832

### Phase 3: Verification and documentation

- [x] 3.1 Quality gate, SPEC-118 §20 / SPEC-203 §13 status, lessons, run log — see the docs commit

## Decisions

- **Module layout** `packages/agent-adapters/src/claude-code/` (SPEC-203 §5) with one export line
  in `src/index.ts`; `detection.ts` untouched (issue #102 works there in parallel).
- **`ClaudeCodeError` with a code** for every builder refusal; inspections return findings
  (`{ code, path/file, detail, token?, target? }`) so the CLI can list each one (FR-118-06/26/27).
- **Skill name restricted to the documented form** (lowercase letters, digits, hyphens, ≤ 64):
  `Skill(<name>)` is an argv value, so a space, comma, `*` or parenthesis would widen the allow
  list. New code `skill-name-unsupported`, added to SPEC-203 §9.
- **`agents-md` always imports through `CLAUDE.md`** (SPEC-203 §4.1 updated): one
  version-independent layout instead of a version-dependent install; the builder needs no CLI
  version.
- **Subscription mode passes a user-set `CLAUDE_CONFIG_DIR` through** (SPEC-203 §3.2 updated):
  that is where the user's own login lives; DirectiveBench never overrides it.
- **Import scan as a superset of Claude Code's grammar** (FR-118-27 updated): every `@`, cut also
  at a lone backslash and without trailing punctuation, both spellings of escaped spaces; lexical
  (canonical and given workspace path) and physical (`realpath`) resolution; in a workspace with
  a symbolic link, relative tokens climbing above their directory are refused. Linear: one O(1)
  decision per `@` (right-to-left pass per word); resolution bounded by the new named limits
  `WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES` (100 000) and `IMPORT_TOKEN_MAX_LENGTH` (4 096).
- **Fail closed beyond the letter of FR-118-26**: bundles are also refused for the FR-118-06 file
  names (`CLAUDE.local.md`, `.worktreeinclude`, `.claude.json`), for `!`-fences (```` ```! ````),
  and frontmatter keys are compared case- and separator-insensitively (`allowed_tools`); path
  segments are compared case-insensitively (macOS, Windows). Special files (FIFOs) in a
  workspace are refused.
- **Install refuses links a `setup` command planted** (setup runs before installation in the
  orchestrator): every existing directory component is `lstat`ed, files are created with `wx`,
  instruction files are appended only when regular with one link and identical when opened.

## Work performed

1. Plan and draft PR #108 (0ce4a67).
2. Builders: errors, version, argv + flags hash, skill name, env, install, with tests (ebb43d8).
3. Inspection: bundle inspection, import tokenizer, workspace walk / configuration check /
   import and link scan, race tests through a wrapped `node:fs/promises` (f449832).
4. SPEC-118 FR-118-27 and §20, SPEC-203 §3.2/§4.1/§9/§13, lesson, this log.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify:pack` at f449832 | pass; 100% statements/branches/functions/lines in every package; agent-adapters 130 tests (was 44), core 266, database 131, benchmark-engine 115, runner 229, web 157, cli 75; "Packaging verification passed" |
| Manual exercise (`tsx` script in a temporary workspace, not committed) | skill-md argv as specified; install wrote `.claude/skills/estimate-project/SKILL.md`; flags hash equal for two workspaces; subscription env keys `HOME,LANG,PATH,TEMP,TMP,TMPDIR`; clean workspace → no findings; planted `.claude/settings.local.json`, `.claude/agents`, `@/etc/hostname` and `@~/.bashrc` (via `CLAUDE.md` → `docs/context.md`) → four findings with targets; a baseline with `hooks`, `allowed-tools: Skill`, `model: opus` and `` !`id` `` → four findings |
| `claude --help` drift check (2.1.302, read-only) | every flag the argv uses exists: `--print`, `--output-format`, `--verbose`, `--model`, `--tools`, `--permission-mode`, `--allowedTools`, `--permission-prompts`, `--no-session-persistence`, `--strict-mcp-config`, `--settings`, `--setting-sources`, `--max-budget-usd` |

Not verified: how Claude Code parses the argv (e.g. `Skill(<name> *)` as one `--allowedTools`
value — the help says "comma or space-separated" and shows `"Bash(git *)"` as one rule), its
exact `@` token grammar, `disableSkillShellExecution` and `blockReadsOutsideWorkingDirectories`
in effect — all reserved for the AC-22 live check. No `claude -p` run was started. Windows was not
run (O_NOFOLLOW/O_NONBLOCK OR to 0 there; the identity checks cover it).

## Problems and deviations

- The first tokenizer draft treated any backslash as "shortening", so a long word with a lone
  backslash was refused instead of checked at the cut; fixed with a test.
- No deviation from an approved spec (both specs are drafts); the spec text was updated for the
  decisions above in the same change.

## Review

Round 1 (independent `om-code-review` agent, head `1643e68`): changes requested, posted as COMMENT
on PR #108.

- **B1 (blocker)**: Claude Code matches imports per Markdown text piece, so `@/etc/hostname*x*`,
  `` @/etc/hostname`x` ``, `[@/etc/hostname](x)`, `@/etc/hostname#frag` imported a host file the
  scan did not check. Fixed: every resolved candidate is also checked cut before each Markdown
  split character (counted against the candidate limit); tests for each form.
- **B2 (blocker)**: an opening `--- `/`---\t` line hid the frontmatter from core
  `parseFrontmatter`, so `hooks`/`allowed-tools`/`model` passed. Fixed: `parseSkillFrontmatter`
  accepts trailing blanks and fails closed on a block that opens but never closes (inspection and
  skill-name resolution).
- **M1**: outside directories (`@/lib`) no longer refuse; **M3**: NFKC + case round trip folds
  `ſ`; **N1**: nested rule paths refused; **M2/M4** recorded as residuals in SPEC-118 §12
  (Windows absolute forms; nested `CLAUDE.md` written mid-run, for the AC-22 live check).
  N2 (≈4 s worst case at the limits) and N3 (`runLocalPaths` only required by FR-118-04) noted.
- Red first: the new tests (11) fail on the round-1 source and pass after the fix.

Round 2 (same reviewer, head `7b25396`): changes requested — **R2-B1 (blocker)**: tokens over
4 096 characters skipped the Markdown-cut prefixes (`@/etc/hostname*x*` + 5 000 characters passed).
Fixed: a long token without shortening sequences still yields its cut prefixes within the first
4 096 characters; six regression tests. **R2-M1 (minor)**: Claude Code's frontmatter pattern may
close at a `---` inside a line; any inner `---` now fails closed. R2-N1 (NFKC flags full-width
look-alikes) accepted as a harmless over-report.

## Lessons recorded

- [2026-10-22 — An import scan must be O(1) per token start and check every way a path can resolve](../lessons/2026-10-22-import-scans-need-every-resolution.md)

## Follow-ups

- Phase 3 step 2–3: wire the builders into a `ClaudeCodeAdapter` (call `inspectWorkspace` with the
  installed paths right before spawn; map codes to `infrastructure-error` and FR-118-15 stops).
- Phase 4: plan-time calls — `inspectArtifactVersions`, `baselineSkillNameIssue`, a materialised
  workspace (fixture + overlay + both artifact versions) through `inspectWorkspace` with
  `claudeConfigCode: 'fixture-contains-claude-config'` for fixture/overlay; exit 2.
- AC-22 live check: record the token grammar, the `--allowedTools` parsing and the field names.

# Proposals

Proposals capture ideas for **major** changes before they become specs or code: a new subsystem, a new integration category, a data model change, anything affecting security or the public CLI.

## Workflow

1. Copy [`../templates/proposal.template.md`](../templates/proposal.template.md) to `PROP-NNN-short-title.md` (next free number, never reused).
2. Fill in the problem, the proposal, alternatives, impact and open questions. Status: `proposal`.
3. A maintainer decides:
   - **Accepted** — create the resulting spec(s) in `features/` or `integrations/` (status `draft`), add them to the [spec index](../README.md), set the proposal status to `accepted` and link the specs. Record significant architectural choices as ADRs in [`.ai/decisions/`](../../decisions/).
   - **Rejected** — set status `rejected` and record why. The file is kept.
4. Implementation starts only after acceptance.

See the [spec index](../README.md#proposals-workflow) for the full lifecycle.

## Current proposals

None. This directory is intentionally empty apart from this README; the initial scope is captured directly in the foundation, feature and integration specs.

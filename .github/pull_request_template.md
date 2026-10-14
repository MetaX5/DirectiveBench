## Summary

<!-- What changes and why. Link the issue if there is one. -->

## Specs, ADRs and run log

<!-- Links to .ai/specs/…, .ai/decisions/… and .ai/runs/… touched by this change. -->

## Verification

<!-- Commands you ran and their real results. Say what was NOT verified. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm build && pnpm verify:pack` (CLI, web, packaging or dependency changes)
- [ ] `pnpm test:e2e` (UI changes)

## Checklist

- [ ] Specification created/updated first for significant changes; implementation status updated only for verified behaviour
- [ ] Lessons recorded in `.ai/lessons.md` for non-obvious fixes or corrections
- [ ] No secrets, credentials or local databases committed
- [ ] Incomplete functionality is visibly marked as planned / not implemented

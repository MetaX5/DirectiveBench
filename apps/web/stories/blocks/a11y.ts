// Documented a11y exceptions for stories (SPEC-122 FR-122-1, AC-4). Each one names the
// finding, the reason and where it is tracked; remove it when the finding is fixed.

/**
 * scrollable-region-focusable: Pre (components/ui/primitives.tsx) and the Table container
 * (components/ui/table.tsx) scroll when their content is long or wide, but neither is a tab
 * stop, so keyboard users of browsers without focusable scrollers cannot scroll them. Found in
 * stage 2 of SPEC-122; the fix is proposal P13 in SPEC-122 §18.
 */
export const scrollableRegionException = {
  a11y: { config: { rules: [{ id: 'scrollable-region-focusable', enabled: false }] } },
};

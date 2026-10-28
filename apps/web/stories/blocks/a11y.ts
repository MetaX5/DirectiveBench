// Documented a11y exceptions for stories (SPEC-122 FR-122-1, AC-4). Each one names the
// finding, the reason and where it is tracked; remove it when the finding is fixed.

/**
 * heading-order: every app page puts CardTitle (an h3, components/ui/card.tsx) straight under
 * the PageHeader h1, so stories that compose a page reproduce the skipped h2. Found in stage 1
 * of SPEC-122; the fix (CardTitle as h2, or a level prop) is proposal P6 in SPEC-122 §18.
 */
export const headingOrderException = {
  a11y: { config: { rules: [{ id: 'heading-order', enabled: false }] } },
};

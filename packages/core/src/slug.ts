/**
 * The characters `slugify` keeps: NFKD, accents stripped, lower-case `a-z0-9` runs joined by
 * single hyphens, no hyphen at either end. Empty when the value has no such character. Internal to
 * core (not exported from the package): `slugify` adds its `item` fallback, `categorySlug` does not.
 */
export function slugCharacters(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // Runs are collapsed above, so at most one hyphen is left at each end. A single-character
      // pattern keeps this linear (`-+$` backtracks quadratically on a long run of hyphens).
      .replace(/^-|-$/g, '')
  );
}

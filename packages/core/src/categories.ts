import { slugCharacters } from './slug';

export interface PredefinedCategory {
  slug: string;
  name: string;
  description: string;
}

/** Initial categories created by `directivebench init`. Users may rename or archive them. */
export const PREDEFINED_CATEGORIES: readonly PredefinedCategory[] = [
  {
    slug: 'security',
    name: 'Security',
    description: 'Secure coding, vulnerabilities and hardening.',
  },
  {
    slug: 'code-quality',
    name: 'Code Quality',
    description: 'Readability, correctness and maintainability.',
  },
  { slug: 'testing', name: 'Testing', description: 'Writing and running automated tests.' },
  { slug: 'documentation', name: 'Documentation', description: 'Docs, comments and changelogs.' },
  { slug: 'performance', name: 'Performance', description: 'Runtime and build performance.' },
  { slug: 'architecture', name: 'Architecture', description: 'System design and structure.' },
  { slug: 'frontend', name: 'Frontend', description: 'Browser and UI development.' },
  { slug: 'backend', name: 'Backend', description: 'Server-side development.' },
  { slug: 'devops', name: 'DevOps', description: 'CI/CD, infrastructure and operations.' },
  { slug: 'wordpress', name: 'WordPress', description: 'WordPress plugins, themes and core.' },
  { slug: 'php', name: 'PHP', description: 'PHP language and ecosystem.' },
  { slug: 'react', name: 'React', description: 'React components and hooks.' },
  { slug: 'nextjs', name: 'Next.js', description: 'Next.js applications.' },
  { slug: 'typescript', name: 'TypeScript', description: 'TypeScript language and typing.' },
  { slug: 'python', name: 'Python', description: 'Python language and ecosystem.' },
  { slug: 'database', name: 'Database', description: 'Schemas, queries and migrations.' },
  { slug: 'workflow', name: 'Workflow', description: 'Agent workflows, planning and process.' },
];

/** The longest category name, after `normalizeCategoryName`, in UTF-16 code units (SPEC-124 A19). */
export const CATEGORY_NAME_MAX_LENGTH = 64;
/** The longest category description, in UTF-16 code units. */
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 500;
/** The longest category slug: a derived slug is cut to this length (SPEC-124 A6). */
export const CATEGORY_SLUG_MAX_LENGTH = 64;

/**
 * A category name as stored: Unicode NFC, every run of whitespace replaced by one space, trimmed
 * (SPEC-124 FR-124-01, A18).
 */
export function normalizeCategoryName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * The key that makes category names unique among active categories: the normalised name in
 * lower case (full Unicode `toLowerCase`, no accent folding), so "Testing", "testing " and
 * "TESTING" share one key (SPEC-124 FR-124-01).
 */
export function categoryNameKey(name: string): string {
  return normalizeCategoryName(name).toLowerCase();
}

/**
 * The slug derived from a category name: what `slugify` keeps, cut to `CATEGORY_SLUG_MAX_LENGTH`
 * without a trailing hyphen. `null` when the name has no Latin letter or digit after NFKD and
 * accent stripping ("日本語", "!!!"); the repository then generates a `category-N` slug
 * (SPEC-124 FR-124-02, A5). Never the `slugify` fallback `item`, unless the name slugifies to it.
 */
export function categorySlug(name: string): string | null {
  const slug = slugCharacters(name);
  if (slug === '') return null;
  return slug.slice(0, CATEGORY_SLUG_MAX_LENGTH).replace(/-+$/, '');
}

import { and, desc, eq, getTableColumns, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  PREDEFINED_CATEGORIES,
  categoryNameKey,
  categorySlug,
  createId,
  normalizeCategoryName,
  nowIso,
  pathRelation,
} from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import {
  artifactCategories,
  artifactOccurrences,
  artifacts,
  categories,
  repositories,
} from '../schema';
import { LOCAL_PROVIDERS, type RepositoryOverlap } from './jobs';
import { countRunsByVerdict, listBenchmarkRuns } from './runs';

/**
 * Inserts predefined categories that do not exist yet. Renamed or archived ones are kept as-is,
 * and one whose slug or name key clashes with an existing category is skipped, never an error
 * (SPEC-106 FR-106-02, SPEC-124 FR-124-10).
 */
export async function seedPredefinedCategories(db: Database): Promise<number> {
  const now = nowIso();
  let inserted = 0;
  for (const category of PREDEFINED_CATEGORIES) {
    const result = await db
      .insert(categories)
      .values({
        id: createId('cat'),
        slug: category.slug,
        name: category.name,
        nameKey: categoryNameKey(category.name),
        description: category.description,
        predefined: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: categories.id });
    inserted += result.length;
  }
  return inserted;
}

export async function listCategories(db: Database) {
  return db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      predefined: categories.predefined,
      archivedAt: categories.archivedAt,
      artifactCount: sql<number>`count(${artifactCategories.artifactId})`,
    })
    .from(categories)
    .leftJoin(artifactCategories, eq(artifactCategories.categoryId, categories.id))
    .groupBy(categories.id)
    .orderBy(categories.name);
}

/**
 * The active categories by name, ids and names only: the artifact page's category picker
 * (SPEC-124 §11.3) needs no assignment counts, so it does not aggregate `artifact_categories`.
 */
export async function listActiveCategoryNames(db: Database) {
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(isNull(categories.archivedAt))
    .orderBy(categories.name);
}

/** A category as the lifecycle and assignment functions report it (SPEC-124 §8.2). */
export interface CategoryRef {
  id: string;
  slug: string;
  name: string;
  archived: boolean;
}

const categoryRefColumns = {
  id: categories.id,
  slug: categories.slug,
  name: categories.name,
  archivedAt: categories.archivedAt,
};

function toCategoryRef(row: {
  id: string;
  slug: string;
  name: string;
  archivedAt: string | null;
}): CategoryRef {
  return { id: row.id, slug: row.slug, name: row.name, archived: row.archivedAt !== null };
}

/** SQLite's extended result code for a violated UNIQUE constraint or index. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** Whether a rejected statement broke a unique index (Drizzle keeps the SQLite error as `cause`). */
function isUniqueViolation(error: unknown): boolean {
  // `Object()` reads a property of any value, so a non-object rejection is simply "not unique".
  return Object(Object(error).cause).errcode === SQLITE_CONSTRAINT_UNIQUE;
}

/**
 * Runs a transactional write whose clash checks the unique indexes back up (SPEC-124 §8.2). When
 * the write breaks a unique index anyway, the transaction has rolled back; `explain` reads the
 * clashing row afresh and returns the outcome to report. A violation it cannot explain, and any
 * other error, is rethrown.
 */
async function withUniqueBackstop<T>(
  write: () => Promise<T>,
  explain: () => Promise<T | null>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const outcome = await explain();
    if (outcome === null) throw error;
    return outcome;
  }
}

/** The active category holding a name key, other than `exceptId` (null: no exception). */
async function activeCategoryWithKey(db: Database, nameKey: string, exceptId: string | null) {
  return db
    .select(categoryRefColumns)
    .from(categories)
    .where(
      and(
        eq(categories.nameKey, nameKey),
        isNull(categories.archivedAt),
        exceptId === null ? undefined : ne(categories.id, exceptId),
      ),
    )
    .get();
}

/** The category, active or archived, holding a slug. */
async function categoryWithSlug(db: Database, slug: string) {
  return db.select(categoryRefColumns).from(categories).where(eq(categories.slug, slug)).get();
}

/** Prefix of the slugs generated for names without a Latin letter or digit (SPEC-124 A5). */
const GENERATED_SLUG_PREFIX = 'category-';
/** The first string above every `category-…` slug in BINARY order ('.' follows '-'). */
const GENERATED_SLUG_RANGE_END = 'category.';

/**
 * The smallest `category-N` (N ≥ 1) no category holds, archived ones included (SPEC-124 A5).
 * Reads the candidates once, as a BINARY range rather than `LIKE`; with K such slugs the loop ends
 * by N = K + 1, so the slug stays short whatever names users chose. Runs inside the caller's
 * transaction: `BEGIN IMMEDIATE` serialises writers, and a slug never leaves its row.
 */
async function freeGeneratedSlug(db: Database): Promise<string> {
  const rows = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(
      and(
        gte(categories.slug, GENERATED_SLUG_PREFIX),
        lt(categories.slug, GENERATED_SLUG_RANGE_END),
      ),
    );
  const taken = new Set(rows.map((row) => row.slug));
  let n = 1;
  while (taken.has(`${GENERATED_SLUG_PREFIX}${n}`)) n += 1;
  return `${GENERATED_SLUG_PREFIX}${n}`;
}

/** Name and description of a category, as the web app's schemas parsed them. */
export interface CategoryInput {
  name: string;
  /** `null`: no description. */
  description: string | null;
}

export type CreateCategoryOutcome =
  | { status: 'created'; category: CategoryRef }
  | { status: 'name-taken'; existing: CategoryRef }
  | { status: 'slug-taken'; existing: CategoryRef };

/**
 * Creates an active, user-defined category (SPEC-124 FR-124-04 to FR-124-06). The name is stored
 * normalised; a name whose key an active category holds is `name-taken`; the slug is
 * `categorySlug(name)`, and one another category (archived included) holds is `slug-taken`. A name
 * without a Latin letter or digit gets the smallest free `category-N`. Check and insert run in one
 * transaction, and the unique indexes back them up.
 */
export async function createCategory(
  handle: DatabaseHandle,
  input: CategoryInput,
): Promise<CreateCategoryOutcome> {
  const name = normalizeCategoryName(input.name);
  const nameKey = categoryNameKey(name);
  const derivedSlug = categorySlug(name);
  /** The slug the insert used, for explaining a unique violation. */
  let slug = derivedSlug ?? '';
  return withUniqueBackstop<CreateCategoryOutcome>(
    () =>
      withTransaction(handle, async (db) => {
        const named = await activeCategoryWithKey(db, nameKey, null);
        if (named) return { status: 'name-taken', existing: toCategoryRef(named) };
        if (derivedSlug !== null) {
          const holder = await categoryWithSlug(db, derivedSlug);
          if (holder) return { status: 'slug-taken', existing: toCategoryRef(holder) };
        }
        slug = derivedSlug ?? (await freeGeneratedSlug(db));
        const id = createId('cat');
        const now = nowIso();
        await db.insert(categories).values({
          id,
          slug,
          name,
          nameKey,
          description: input.description,
          predefined: false,
          createdAt: now,
          updatedAt: now,
        });
        return { status: 'created', category: { id, slug, name, archived: false } };
      }),
    async () => {
      const named = await activeCategoryWithKey(handle.db, nameKey, null);
      if (named) return { status: 'name-taken', existing: toCategoryRef(named) };
      const holder = await categoryWithSlug(handle.db, slug);
      return holder ? { status: 'slug-taken', existing: toCategoryRef(holder) } : null;
    },
  );
}

export type UpdateCategoryOutcome =
  /** `previousName`: the name before the update, so a caller can tell a rename from a new description. */
  | { status: 'updated'; category: CategoryRef; previousName: string }
  | { status: 'unchanged'; category: CategoryRef }
  | { status: 'name-taken'; existing: CategoryRef }
  | { status: 'not-found' };

/**
 * Renames a category and sets its description (SPEC-124 FR-124-07). Slug, `predefined` flag and
 * assignments never change. A case variant of its own name is allowed; the key of another active
 * category is `name-taken` for an active category, and allowed for an archived one (it clashes
 * only on unarchive). Unchanged values report `unchanged` and write nothing.
 */
export async function updateCategory(
  handle: DatabaseHandle,
  input: CategoryInput & { id: string },
): Promise<UpdateCategoryOutcome> {
  const name = normalizeCategoryName(input.name);
  const nameKey = categoryNameKey(name);
  return withUniqueBackstop<UpdateCategoryOutcome>(
    () =>
      withTransaction(handle, async (db) => {
        const current = await db.select().from(categories).where(eq(categories.id, input.id)).get();
        if (!current) return { status: 'not-found' };
        if (current.name === name && current.description === input.description) {
          return { status: 'unchanged', category: toCategoryRef(current) };
        }
        if (current.archivedAt === null) {
          const named = await activeCategoryWithKey(db, nameKey, current.id);
          if (named) return { status: 'name-taken', existing: toCategoryRef(named) };
        }
        await db
          .update(categories)
          .set({ name, nameKey, description: input.description, updatedAt: nowIso() })
          .where(eq(categories.id, current.id));
        return {
          status: 'updated',
          category: toCategoryRef({ ...current, name }),
          previousName: current.name,
        };
      }),
    async () => {
      const named = await activeCategoryWithKey(handle.db, nameKey, input.id);
      return named ? { status: 'name-taken', existing: toCategoryRef(named) } : null;
    },
  );
}

/** The state `setCategoryArchived` moves a category to (no boolean flag, SPEC-014). */
export type CategoryState = 'archived' | 'active';

export type SetCategoryArchivedOutcome =
  | {
      status: 'archived' | 'unarchived' | 'already-archived' | 'already-active';
      category: CategoryRef;
    }
  | { status: 'name-taken'; existing: CategoryRef }
  | { status: 'not-found' };

/**
 * Archives or unarchives a category (SPEC-124 FR-124-08, FR-124-09); idempotent. Assignments stay
 * either way. Unarchiving is `name-taken` while an active category holds the same name key.
 */
export async function setCategoryArchived(
  handle: DatabaseHandle,
  input: { id: string; state: CategoryState },
): Promise<SetCategoryArchivedOutcome> {
  /** The key of the category being unarchived, for explaining a unique violation. */
  let nameKey = '';
  return withUniqueBackstop<SetCategoryArchivedOutcome>(
    () =>
      withTransaction(handle, async (db) => {
        const current = await db.select().from(categories).where(eq(categories.id, input.id)).get();
        if (!current) return { status: 'not-found' };
        const ref = toCategoryRef(current);
        if (input.state === 'archived') {
          if (ref.archived) return { status: 'already-archived', category: ref };
          const now = nowIso();
          await db
            .update(categories)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(categories.id, current.id));
          return { status: 'archived', category: { ...ref, archived: true } };
        }
        if (!ref.archived) return { status: 'already-active', category: ref };
        nameKey = current.nameKey;
        const named = await activeCategoryWithKey(db, nameKey, current.id);
        if (named) return { status: 'name-taken', existing: toCategoryRef(named) };
        await db
          .update(categories)
          .set({ archivedAt: null, updatedAt: nowIso() })
          .where(eq(categories.id, current.id));
        return { status: 'unarchived', category: { ...ref, archived: false } };
      }),
    async () => {
      const named = await activeCategoryWithKey(handle.db, nameKey, input.id);
      return named ? { status: 'name-taken', existing: toCategoryRef(named) } : null;
    },
  );
}

/** A category with its details and the number of artifacts assigned to it. */
export type CategoryDetail = CategoryRef & {
  description: string | null;
  predefined: boolean;
  artifactCount: number;
};

/** The category with this slug, active or archived, or `null` (SPEC-124 §8.2). */
export async function getCategoryBySlug(
  db: Database,
  slug: string,
): Promise<CategoryDetail | null> {
  const row = await db
    .select({
      ...categoryRefColumns,
      description: categories.description,
      predefined: categories.predefined,
      artifactCount: sql<number>`count(${artifactCategories.artifactId})`,
    })
    .from(categories)
    .leftJoin(artifactCategories, eq(artifactCategories.categoryId, categories.id))
    .where(eq(categories.slug, slug))
    .groupBy(categories.id)
    .get();
  if (!row) return null;
  return {
    ...toCategoryRef(row),
    description: row.description,
    predefined: row.predefined,
    artifactCount: Number(row.artifactCount),
  };
}

export type RepositoryRecord = typeof repositories.$inferSelect;

/** Repositories with the number of artifacts currently found in each (FR-104-16). */
export async function listRepositories(db: Database) {
  return db
    .select({
      ...getTableColumns(repositories),
      artifactCount: sql<number>`count(${artifactOccurrences.id})`,
    })
    .from(repositories)
    .leftJoin(
      artifactOccurrences,
      and(
        eq(artifactOccurrences.repositoryId, repositories.id),
        eq(artifactOccurrences.status, 'active'),
      ),
    )
    .groupBy(repositories.id)
    .orderBy(repositories.name, repositories.location);
}

export async function getRepository(db: Database, id: string): Promise<RepositoryRecord | null> {
  return (await db.select().from(repositories).where(eq(repositories.id, id)).get()) ?? null;
}

/** What removing a repository deletes and leaves missing (SPEC-125 FR-125-13). */
export interface RepositoryRemovalImpact {
  id: string;
  name: string;
  provider: RepositoryRecord['provider'];
  location: string;
  /** All its occurrence rows, active and removed: the rows the removal deletes. */
  occurrences: number;
  activeOccurrences: number;
  /** Artifacts active in this repository and in no other, so missing after the removal. */
  artifactsLeftMissing: number;
}

/** The internal repository of the bundled examples; never removable (SPEC-125 A15). */
const NOT_REMOVABLE_PROVIDER = 'bundled-examples';

/**
 * The FR-125-13 counts for one repository, read with the given (transaction's) db. Artifacts left
 * missing are found in one pass over the active occurrences grouped by artifact: an artifact
 * active here and nowhere else. A correlated "active elsewhere?" lookup per artifact would scan
 * every occurrence again for each one (no index leads from an artifact to its occurrences), which
 * is quadratic and runs inside the removal's write transaction (Codex review of PR #217).
 */
async function removalCounts(db: Database, repositoryId: string) {
  const inRepository = eq(artifactOccurrences.repositoryId, repositoryId);
  const leftMissing = await db
    .select({ artifactId: artifactOccurrences.artifactId })
    .from(artifactOccurrences)
    .where(eq(artifactOccurrences.status, 'active'))
    .groupBy(artifactOccurrences.artifactId)
    .having(
      sql`max(${artifactOccurrences.repositoryId} = ${repositoryId}) = 1 and max(${artifactOccurrences.repositoryId} <> ${repositoryId}) = 0`,
    );
  return {
    occurrences: await db.$count(artifactOccurrences, inRepository),
    activeOccurrences: await db.$count(
      artifactOccurrences,
      and(inRepository, eq(artifactOccurrences.status, 'active')),
    ),
    artifactsLeftMissing: leftMissing.length,
  };
}

/**
 * What removing a repository would delete (SPEC-125 FR-125-13): its occurrence counts and the
 * artifacts it would leave missing from every repository. Null for an unknown id and for the
 * `bundled-examples` repository, which cannot be removed (A15).
 */
export async function getRepositoryRemovalImpact(
  db: Database,
  repositoryId: string,
): Promise<RepositoryRemovalImpact | null> {
  const repository = await getRepository(db, repositoryId);
  if (!repository || repository.provider === NOT_REMOVABLE_PROVIDER) return null;
  return {
    id: repository.id,
    name: repository.name,
    provider: repository.provider,
    location: repository.location,
    ...(await removalCounts(db, repositoryId)),
  };
}

export type RemoveRepositoryOutcome =
  | { status: 'removed'; occurrences: number; artifactsLeftMissing: number }
  | { status: 'not-found' }
  | { status: 'not-removable' };

/**
 * Removes a registered repository (SPEC-125 FR-125-14, SPEC-104 FR-104-15) in one transaction:
 * the counts are read, then one conditional `DELETE` that refuses `bundled-examples` removes the
 * row. Its occurrences cascade and its versions' `source_repository_id` becomes null (foreign
 * keys); artifacts, versions, categories, tags, notes, suites and runs are not touched. Files and
 * caches are never touched either. Any error rolls everything back.
 */
export async function removeRepository(
  handle: DatabaseHandle,
  repositoryId: string,
): Promise<RemoveRepositoryOutcome> {
  return withTransaction(handle, async (db) => {
    const counts = await removalCounts(db, repositoryId);
    const deleted = await db
      .delete(repositories)
      .where(
        and(eq(repositories.id, repositoryId), ne(repositories.provider, NOT_REMOVABLE_PROVIDER)),
      )
      .returning({ id: repositories.id });
    if (deleted.length === 0) {
      const existing = await getRepository(db, repositoryId);
      return existing ? { status: 'not-removable' } : { status: 'not-found' };
    }
    return {
      status: 'removed',
      occurrences: counts.occurrences,
      artifactsLeftMissing: counts.artifactsLeftMissing,
    };
  });
}

/** A local source the user registers by path (SPEC-104 FR-104-01, FR-104-03). */
export interface LocalRepositoryRegistration {
  provider: 'local-git' | 'local-directory';
  name: string;
  /** Canonical absolute path: the work tree's top level for `local-git`. */
  location: string;
  /** Current branch of a `local-git` repository; null when HEAD is detached or not git. */
  defaultBranch: string | null;
}

/** What the user has to accept before a broad or overlapping location is registered. */
export interface RegistrationConfirmationScope {
  /** Canonical home directory of the user the runner acts for. */
  homeDirectory: string;
  /** The canonical location the user already confirmed, if any (job payload). */
  confirmedLocation: string | null;
}

export type LocalRepositoryRegistrationOutcome =
  | { status: 'registered'; repository: RepositoryRecord; created: boolean }
  | {
      status: 'confirmation-required';
      /** `home`: the location is the home directory; `contains-home`: it is above it. */
      home: 'home' | 'contains-home' | null;
      /** Registered local repositories the location contains or lies inside. */
      overlaps: RepositoryOverlap[];
    };

/** Whether `location` is the home directory or one of its ancestors. */
function homeRelation(location: string, homeDirectory: string): 'home' | 'contains-home' | null {
  const relation = pathRelation(location, homeDirectory);
  if (relation === 'same') return 'home';
  return relation === 'contains' ? 'contains-home' : null;
}

/**
 * Registers a local repository, or returns the one already registered at the same provider and
 * location (FR-104-04, returned unchanged). A new location that is the home directory (or above
 * it), or that contains or lies inside another registered local repository, is registered only
 * when `confirmedLocation` equals it (FR-104-18); otherwise the outcome lists what the user must
 * confirm. The same location under the other local provider is not an overlap (OQ-104-05). The
 * check and the insert run in one transaction, so concurrent registrations cannot both skip it.
 */
export async function registerLocalRepository(
  handle: DatabaseHandle,
  input: LocalRepositoryRegistration,
  scope: RegistrationConfirmationScope,
): Promise<LocalRepositoryRegistrationOutcome> {
  return withTransaction(handle, async (db) => {
    const existing = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.provider, input.provider), eq(repositories.location, input.location)),
      )
      .get();
    if (existing) return { status: 'registered', repository: existing, created: false };

    const home = homeRelation(input.location, scope.homeDirectory);
    const local = await db
      .select({ id: repositories.id, name: repositories.name, location: repositories.location })
      .from(repositories)
      .where(inArray(repositories.provider, [...LOCAL_PROVIDERS]))
      .orderBy(repositories.location, repositories.id);
    const overlaps: RepositoryOverlap[] = [];
    for (const repository of local) {
      const relation = pathRelation(input.location, repository.location);
      if (relation === 'inside' || relation === 'contains') {
        overlaps.push({
          repositoryId: repository.id,
          name: repository.name,
          location: repository.location,
          relation,
        });
      }
    }
    if ((home !== null || overlaps.length > 0) && scope.confirmedLocation !== input.location) {
      return { status: 'confirmation-required', home, overlaps };
    }

    const now = nowIso();
    const [inserted] = await db
      .insert(repositories)
      .values({
        id: createId('repo'),
        provider: input.provider,
        name: input.name,
        location: input.location,
        defaultBranch: input.defaultBranch,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!inserted) throw new Error(`Repository ${input.location} could not be inserted`);
    return { status: 'registered', repository: inserted, created: true };
  });
}

/** A hosted repository registered by URL (SPEC-104 FR-104-02). */
export interface HostedRepositoryRegistration {
  provider: 'github';
  name: string;
  /** Normalised, credential-free URL (FR-104-04, FR-104-05). */
  location: string;
  /** The remote's default branch; null when it reports none (an empty repository). */
  defaultBranch: string | null;
}

/**
 * Registers a hosted repository, or returns the one already registered at the same provider and
 * location (FR-104-04) with its default branch refreshed from the remote's answer, so registering
 * the URL again repairs a repository that was empty or whose default branch was renamed (name and
 * everything else stay unchanged). One `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent
 * registrations of the same URL never create two rows. Hosted locations do not overlap with
 * anything (FR-104-18 applies to local paths only).
 */
export async function registerHostedRepository(
  db: Database,
  input: HostedRepositoryRegistration,
): Promise<{ repository: RepositoryRecord; created: boolean }> {
  const now = nowIso();
  const id = createId('repo');
  const [row] = await db
    .insert(repositories)
    .values({
      id,
      provider: input.provider,
      name: input.name,
      location: input.location,
      defaultBranch: input.defaultBranch,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [repositories.provider, repositories.location],
      // A remote that momentarily reports no default branch keeps the known one.
      set: {
        defaultBranch: sql`coalesce(excluded.default_branch, ${repositories.defaultBranch})`,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error(`Repository ${input.location} could not be inserted`);
  return { repository: row, created: row.id === id };
}

export async function getDashboardStats(db: Database) {
  const typeCounts = await db
    .select({ type: artifacts.type, count: sql<number>`count(*)` })
    .from(artifacts)
    .groupBy(artifacts.type);
  const repositoryCount = await db.$count(repositories);
  const lastSync = await db
    .select({ at: repositories.lastSyncAt })
    .from(repositories)
    .where(sql`${repositories.lastSyncAt} is not null`)
    .orderBy(desc(repositories.lastSyncAt))
    .limit(1)
    .get();
  const byType = { skill: 0, instruction: 0, rule: 0 };
  for (const row of typeCounts) byType[row.type] = Number(row.count);
  return {
    repositoryCount,
    artifactCount: byType.skill + byType.instruction + byType.rule,
    skillCount: byType.skill,
    instructionCount: byType.instruction,
    ruleCount: byType.rule,
    lastSyncAt: lastSync?.at ?? null,
    runsByVerdict: await countRunsByVerdict(db),
    recentRuns: await listBenchmarkRuns(db, { limit: 8 }),
  };
}

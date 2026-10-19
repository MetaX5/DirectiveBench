import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { PREDEFINED_CATEGORIES, createId, nowIso, pathRelation } from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import {
  artifactCategories,
  artifactOccurrences,
  artifacts,
  categories,
  repositories,
} from '../schema';
import { SCANNABLE_PROVIDERS, type RepositoryOverlap } from './jobs';
import { countRunsByVerdict, listBenchmarkRuns } from './runs';

/** Inserts predefined categories that do not exist yet. Renamed or archived ones are kept as-is. */
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
      .where(inArray(repositories.provider, [...SCANNABLE_PROVIDERS]))
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

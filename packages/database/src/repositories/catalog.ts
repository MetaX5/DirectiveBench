import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { PREDEFINED_CATEGORIES, createId, nowIso } from '@directivebench/core';
import type { Database } from '../client';
import {
  artifactCategories,
  artifactOccurrences,
  artifacts,
  categories,
  repositories,
} from '../schema';
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

/** A local source the user registers by path (SPEC-104 FR-104-01, FR-104-03). */
export interface LocalRepositoryRegistration {
  provider: 'local-git' | 'local-directory';
  name: string;
  /** Canonical absolute path: the work tree's top level for `local-git`. */
  location: string;
  /** Current branch of a `local-git` repository; null when HEAD is detached or not git. */
  defaultBranch: string | null;
}

/**
 * Registers a local repository, or returns the one already registered at the same provider and
 * location (FR-104-04). The insert is a single conditional statement, so two concurrent
 * registrations of the same path cannot create two rows. An existing repository is returned
 * unchanged.
 */
export async function registerLocalRepository(
  db: Database,
  input: LocalRepositoryRegistration,
): Promise<{ repository: RepositoryRecord; created: boolean }> {
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
    .onConflictDoNothing({ target: [repositories.provider, repositories.location] })
    .returning();
  if (inserted) return { repository: inserted, created: true };
  const existing = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.provider, input.provider), eq(repositories.location, input.location)),
    )
    .get();
  if (!existing) throw new Error(`Repository ${input.location} was neither inserted nor found`);
  return { repository: existing, created: false };
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

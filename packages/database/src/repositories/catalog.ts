import { desc, eq, sql } from 'drizzle-orm';
import { PREDEFINED_CATEGORIES, createId, nowIso } from '@directivebench/core';
import type { Database } from '../client';
import { artifactCategories, artifacts, categories, repositories } from '../schema';
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

export async function listRepositories(db: Database) {
  return db.select().from(repositories).orderBy(repositories.name);
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

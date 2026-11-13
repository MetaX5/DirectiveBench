import { describe, expect, it } from 'vitest';
import { createId } from '@directivebench/core';
import {
  listOrphanedRepositoryCaches,
  registerHostedRepository,
  removeRepository,
  schema,
} from '../src/index';
import { openTestDatabase, useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

/** A job row of any type and status, inserted directly (the states a runner leaves behind). */
async function insertJob(type: string, status: string, payload: unknown): Promise<void> {
  await getHandle()
    .db.insert(schema.jobs)
    .values({
      id: createId('job'),
      type: type as 'repository-scan',
      status: status as 'pending',
      payload: payload as { repositoryId: string },
      createdAt: new Date().toISOString(),
    });
}

describe('listOrphanedRepositoryCaches (SPEC-105 FR-105-19, issue 59)', () => {
  it('keeps the cache of a registered repository and returns one without a row or scan', async () => {
    const { repository } = await registerHostedRepository(getHandle().db, {
      provider: 'github',
      name: 'rules',
      location: 'https://github.com/acme/rules',
      defaultBranch: 'main',
    });
    const gone = createId('repo');
    expect(await listOrphanedRepositoryCaches(getHandle(), [repository.id, gone])).toEqual([gone]);

    // Removing the row makes its cache an orphan too.
    expect(await removeRepository(getHandle(), repository.id)).toMatchObject({ status: 'removed' });
    expect(await listOrphanedRepositoryCaches(getHandle(), [repository.id, gone])).toEqual([
      repository.id,
      gone,
    ]);
  });

  it('is not an orphan while a pending or running scan names the id', async () => {
    const pending = createId('repo');
    const running = createId('repo');
    await insertJob('repository-scan', 'pending', { repositoryId: pending });
    await insertJob('repository-scan', 'running', { repositoryId: running });
    expect(await listOrphanedRepositoryCaches(getHandle(), [pending, running])).toEqual([]);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'])(
    'is an orphan once the scan naming it is %s',
    async (status) => {
      const id = createId('repo');
      await insertJob('repository-scan', status, { repositoryId: id });
      expect(await listOrphanedRepositoryCaches(getHandle(), [id])).toEqual([id]);
    },
  );

  it('ignores jobs of another type and scan payloads that do not parse', async () => {
    const id = createId('repo');
    await insertJob('repository-registration', 'running', { repositoryId: id });
    await insertJob('benchmark-run', 'pending', { repositoryId: id });
    await insertJob('repository-scan', 'running', { repositoryId: id, extra: true });
    await insertJob('repository-scan', 'pending', { id });
    expect(await listOrphanedRepositoryCaches(getHandle(), [id])).toEqual([id]);
  });

  it('returns nothing for no ids without touching the database', async () => {
    const closed = await openTestDatabase();
    closed.dispose();
    expect(await listOrphanedRepositoryCaches(closed.handle, [])).toEqual([]);
    await expect(listOrphanedRepositoryCaches(closed.handle, ['repo_x'])).rejects.toThrow();
  });
});

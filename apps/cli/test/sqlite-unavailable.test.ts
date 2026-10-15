import { describe, expect, it, vi } from 'vitest';
import { checkSqlite } from '../src/runtime';

// Simulates a Node.js build without a working node:sqlite module.
vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor() {
      throw new Error('SQLite support is disabled');
    }
  },
}));

describe('checkSqlite without node:sqlite', () => {
  it('reports the failure instead of throwing', async () => {
    expect(await checkSqlite()).toEqual({
      ok: false,
      message: 'node:sqlite unavailable: SQLite support is disabled',
    });
  });
});

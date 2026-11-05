import type { SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { schema, type DatabaseHandle } from '../../src/index';

/**
 * What an interceptor does with one statement: `run` it, or `hide` its result (a read then sees
 * no row, as if a check had missed a clash).
 */
export type InterceptAction = 'run' | 'hide';

/**
 * A handle on the same connection whose statements pass through `intercept` first, so a test can
 * place work deterministically between two statements of a repository function (by running SQL
 * on `handle.sqlite` inside `intercept`) or make a clash check miss. Only for single-threaded
 * tests: unlike `openDatabase`, it does not hold statements from outside a running transaction.
 */
export function interceptHandle(
  handle: DatabaseHandle,
  intercept: (query: string, params: readonly unknown[]) => InterceptAction,
): DatabaseHandle {
  const { sqlite } = handle;
  const db = drizzle(
    async (query, params, method) => {
      const hidden = intercept(query, params) === 'hide';
      const statement = sqlite.prepare(query);
      const values = params as SQLInputValue[];
      if (method === 'run') {
        statement.run(...values);
        return { rows: [] };
      }
      statement.setReturnArrays(true);
      if (method === 'get') {
        const row = hidden ? undefined : statement.get(...values);
        return { rows: row as unknown as unknown[] };
      }
      return { rows: hidden ? [] : (statement.all(...values) as unknown as unknown[][]) };
    },
    { schema },
  );
  return { ...handle, db };
}

import type * as fsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { inspectLocalPath } from '../src/repository-registration';

const fsMock = vi.hoisted(() => ({ realpath: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromises>()),
  realpath: fsMock.realpath,
}));

const options = { homeDir: '/home/me', env: {}, signal: new AbortController().signal };

describe('inspectLocalPath with unexpected file-system errors', () => {
  it('rethrows errors it cannot classify instead of registering an unchecked path', async () => {
    const io = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    fsMock.realpath.mockRejectedValueOnce(io);
    await expect(inspectLocalPath('/srv/repo', options)).rejects.toBe(io);

    const bare = new Error('no code');
    fsMock.realpath.mockRejectedValueOnce(bare);
    await expect(inspectLocalPath('/srv/repo', options)).rejects.toBe(bare);
  });
});

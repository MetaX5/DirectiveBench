import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  killProcessGroup,
  PROCESS_GROUP_EXIT_TIMEOUT_MS,
  signalProcessGroup,
} from '../src/process-group';

const posix = it.skipIf(process.platform === 'win32');

afterEach(() => {
  vi.restoreAllMocks();
});

/** A child process that never started (spawn failure): it has no pid. */
const notStarted = { pid: undefined } as unknown as ChildProcess;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('process groups', () => {
  it('has nothing to signal or kill for a child that never started', async () => {
    expect(signalProcessGroup(notStarted, true, 'SIGTERM')).toBe(true);
    expect(await killProcessGroup(notStarted, true)).toBe(true);
  });

  it('reports a group that cannot be signalled (EPERM)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('EPERM');
    });
    expect(signalProcessGroup({ pid: 4242 } as ChildProcess, true, 'SIGTERM')).toBe(false);
  });

  it('treats a group that is already gone as signalled (ESRCH)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('ESRCH');
    });
    expect(signalProcessGroup({ pid: 4242 } as ChildProcess, true, 'SIGTERM')).toBe(true);
  });

  it(
    'reports a group that is still there after the wait, also when it cannot be signalled',
    async () => {
      // Signal 0 fails with EPERM: a member exists that this user may not signal.
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw errno('EPERM');
      });
      const started = performance.now();
      expect(await killProcessGroup({ pid: 4242 } as ChildProcess, true)).toBe(false);
      expect(performance.now() - started).toBeGreaterThanOrEqual(
        PROCESS_GROUP_EXIT_TIMEOUT_MS - 50,
      );
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(kill).toHaveBeenCalledWith(-4242, 0);
    },
    PROCESS_GROUP_EXIT_TIMEOUT_MS + 10_000,
  );

  posix('kills the remaining members of a real group and waits until they are gone', async () => {
    const child = spawn('sh', ['-c', 'sleep 600 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    expect(await killProcessGroup(child, true)).toBe(true);
    expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/);
    expect(() => process.kill(-(child.pid as number), 0)).toThrow(/ESRCH/);
  });
});

import { EventEmitter } from 'node:events';
import type * as childProcess from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as processGroup from '../../src/process-group';
import {
  CLAUDE_STDOUT_MAX_BYTES,
  runClaudeProcess,
  type ClaudeProcessInput,
} from '../../src/claude-code/process';

// Event orders a real `claude` produces only on some timings, forced here with a stub child:
// whether stdout delivers another chunk after the one over the limit depends on the writer
// running again before SIGTERM ends it, so the real flood test reached the guards below only on
// some runs (macOS coverage of process.ts lines 97 and 229 dropped on PR #183, issue #184).

/** A child process stub whose events the test emits in an explicit order. */
class StubChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  readonly unref = vi.fn();
}

const stub = vi.hoisted(() => ({ child: undefined as unknown }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(() => stub.child) };
});

vi.mock('../../src/process-group', async (importOriginal) => {
  const actual = await importOriginal<typeof processGroup>();
  return {
    ...actual,
    usesProcessGroups: () => true,
    signalProcessGroup: vi.fn(() => true),
    killProcessGroup: vi.fn(() => Promise.resolve(true)),
  };
});

const { signalProcessGroup } = vi.mocked(await import('../../src/process-group'));

function input(): ClaudeProcessInput {
  return {
    executable: '/usr/local/bin/claude',
    argv: ['-p'],
    env: { PATH: '/usr/bin' },
    cwd: '/workspace',
    prompt: 'Write the estimate.\n',
    timeoutMs: 30_000,
    signal: new AbortController().signal,
  };
}

/** Ends the stub the way a killed `claude` ends: `exit`, then `close` once its pipes closed. */
function end(child: StubChild): void {
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
}

let child: StubChild;
beforeEach(() => {
  signalProcessGroup.mockClear();
  child = new StubChild();
  stub.child = child;
});

describe('runClaudeProcess with a stub child (deterministic event order)', () => {
  it('drops stdout that arrives after the limit and stops claude only once', async () => {
    const pending = runClaudeProcess(input());
    child.stdout.emit('data', Buffer.from('kept\n'));
    child.stdout.emit('data', Buffer.alloc(CLAUDE_STDOUT_MAX_BYTES));
    expect(signalProcessGroup).toHaveBeenCalledTimes(1);
    // Output still in the pipe after SIGTERM: not kept, and no second SIGTERM.
    child.stdout.emit('data', Buffer.from('late\n'));
    expect(signalProcessGroup).toHaveBeenCalledTimes(1);
    expect(signalProcessGroup).toHaveBeenCalledWith(child, true, 'SIGTERM');
    end(child);

    const result = await pending;
    expect(result).toMatchObject({
      outputLimitExceeded: true,
      signal: 'SIGTERM',
      lines: ['kept'],
      strayProcesses: false,
    });
  });

  it('sends no signal once claude exited, though output over the limit follows', async () => {
    const pending = runClaudeProcess(input());
    // A process that left the group still writes to the inherited pipe after `claude` exited:
    // its id may already be reused, so it must not be signalled.
    child.emit('exit', 0, null);
    child.stdout.emit('data', Buffer.alloc(CLAUDE_STDOUT_MAX_BYTES + 1));
    child.emit('close', 0, null);

    const result = await pending;
    expect(signalProcessGroup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outputLimitExceeded: true, exitCode: 0, lines: [] });
  });
});

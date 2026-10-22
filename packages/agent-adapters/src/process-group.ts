import type { ChildProcess } from 'node:child_process';

/**
 * Process-group control for untrusted child processes (`setup` and assertion commands, the agent
 * CLI). On POSIX a child is spawned `detached`, which makes it the leader of a new process group
 * whose id is its pid; signalling the negative pid reaches every process it started that did not
 * leave the group. Windows has no process groups: only the direct child is signalled there
 * (process-tree kill on Windows is best effort, SPEC-118 NFR-118-04).
 */

/** How often {@link killProcessGroup} checks whether the group is gone. */
export const PROCESS_GROUP_POLL_MS = 10;

/**
 * How long {@link killProcessGroup} waits after SIGKILL for the group to disappear. Killed
 * processes vanish once their parent (the orphan reaper for a background child) collects them,
 * which takes milliseconds; a group still present after this is reported, not waited for.
 */
export const PROCESS_GROUP_EXIT_TIMEOUT_MS = 2000;

/**
 * How long, after a command's leader exited and its group was killed, its output pipes may stay
 * open before they are closed by force. Only a process that left the group (`setsid`, a daemon)
 * can still hold them then; callers report it as a stray process (fail closed), since it can keep
 * changing the workspace.
 */
export const PROCESS_OUTPUT_DRAIN_MS = 1000;

/** Whether children are started in their own process group on this platform. */
export function usesProcessGroups(): boolean {
  return process.platform !== 'win32';
}

/**
 * Sends `signal` to the child's process group (POSIX) or the child itself (Windows). A group or
 * process that no longer exists is not an error. Returns false only when the signal could not be
 * delivered to an existing target (`EPERM`).
 */
export function signalProcessGroup(
  child: ChildProcess,
  groups: boolean,
  signal: NodeJS.Signals,
): boolean {
  const pid = child.pid;
  if (pid === undefined) return true;
  if (!groups) {
    child.kill(signal);
    return true;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Whether a process group with this id still has members (zombies included). */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: a member exists but cannot be signalled (e.g. a set-uid program it started).
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Kills every remaining member of the child's process group with SIGKILL and waits until the group
 * is gone, at most {@link PROCESS_GROUP_EXIT_TIMEOUT_MS}. Call it once the leader has exited, so a
 * background process the command left behind cannot change the workspace afterwards (SPEC-118
 * §12). Returns true when no member remains; false when one survived the wait (for example an
 * orphan nobody reaps, or a set-uid member), which callers treat as a failure.
 *
 * The group id is the leader's pid. The kernel does not reuse a pid while a group of that id
 * exists, so the signal can only reach this group's members; once the group is empty the
 * signal fails with `ESRCH`.
 *
 * Windows: no groups, so nothing beyond the (already exited) child can be reached; returns true.
 */
export async function killProcessGroup(child: ChildProcess, groups: boolean): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined || !groups) return true;
  signalProcessGroup(child, groups, 'SIGKILL');
  const deadline = performance.now() + PROCESS_GROUP_EXIT_TIMEOUT_MS;
  while (groupExists(pid)) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
  return true;
}

import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  findSecretRanges,
  type ArtifactBundle,
  type TextEnd,
  type TextRange,
} from '@directivebench/core';
import {
  CLAUDE_API_KEY_VARIABLE,
  CLAUDE_AUTH_MODES,
  CLAUDE_EXECUTABLE,
} from '../claude-code-readiness';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDetection,
  AgentRunRequest,
  AgentRunResult,
  InstalledArtifact,
} from '../contract';
import { CLAUDE_CODE_AGENT, detectCliAgent } from '../detection';
import { findExecutable, readVersionLine } from '../probe';
import type { WorkspacePin } from '../workspace-pin';
import { buildClaudeArgv, claudeFlagsHash, type ClaudePermissionProfile } from './argv';
import { artifactRefusalCode, inspectArtifactVersions } from './bundle-inspection';
import { buildClaudeEnv, claudeAuthProfile, type ClaudeEnvInput } from './env';
import { ClaudeCodeError } from './errors';
import {
  claudeExecutablePinIssue,
  pinClaudeExecutable,
  type ClaudeExecutableLookup,
} from './executable-pin';
import { claudeArtifactProfile, installClaudeArtifact } from './install';
import { claudeRunOutcome } from './normalize';
import { notStartedEnd, runClaudeCode } from './run';
import { baselineSkillNameIssue } from './skill-name';
import { ClaudeStreamParser, redactStreamText, withJsonForms } from './stream-parser';

export const CLAUDE_CODE_ADAPTER_ID = 'claude-code';

/** Run-local directories below `AgentRunRequest.scratchDir` (absolute paths are never hashed). */
export const CLAUDE_RUN_HOME_DIR = 'home';
export const CLAUDE_RUN_TEMP_DIR = 'tmp';

const PERMISSION_PROFILES = [
  'edit-only',
  'edit-and-shell',
] as const satisfies readonly ClaudePermissionProfile[];

/**
 * How one benchmark run drives Claude Code, chosen by the CLI (SPEC-118 FR-118-30), never by the
 * suite: the auth mode (`--auth`, default subscription), the permission profile (`edit-and-shell`
 * only for an execution-approved suite, FR-118-01) and the API Key Mode budget cap.
 */
export const claudeCodeAdapterOptionsSchema = z
  .object({
    authMode: z.enum(CLAUDE_AUTH_MODES).default('subscription'),
    permissionProfile: z.enum(PERMISSION_PROFILES).default('edit-only'),
    maxBudgetUsd: z.number().positive().finite().optional(),
  })
  .strict()
  .refine((options) => options.maxBudgetUsd === undefined || options.authMode === 'api-key', {
    message: 'maxBudgetUsd is enforced only in API Key Mode (authMode "api-key")',
    path: ['maxBudgetUsd'],
  });

export type ClaudeCodeAdapterOptions = z.input<typeof claudeCodeAdapterOptionsSchema>;

/**
 * The case's `agentOptions['claude-code']`: S1 has none, so anything but an absent or empty object
 * is refused before `claude` starts — a suite cannot choose the auth mode, the profile or a flag.
 */
export const claudeCodeCaseOptionsSchema = z.object({}).strict().optional();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The executable `claude-code` adapter (SPEC-118 §6.1, SPEC-203 §2–§9), composed of the S03
 * pieces: detection and readiness (`detect`), the §4.1 install convention with the workspace pin
 * and the bundle inspection (`installArtifact`), and per agent run the bundle inspection of both
 * versions, the binary and version check, argv and environment per auth mode and permission
 * profile, the pre-spawn workspace inspection and process control (`runClaudeCode`), the stream
 * parser and the normalisation of §9 (`claudeRunOutcome`).
 *
 * Every way out of {@link run} passes one exit that redacts the summary and the error with the
 * core patterns and the API key, and a thrown error never leaves it: the run ends
 * `infrastructure-error`, keeping a {@link ClaudeCodeError}'s code. A run refused before the spawn
 * carries no metadata (no agent ran under its conditions); every run carries the auth mode's
 * warnings (`ambient-user-config` in Local Subscription Mode, FR-118-03).
 *
 * Not registered in `createExecutableAdapters()`: only the runner `benchmark run` starts gets it
 * (FR-118-05, E06-S04).
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = CLAUDE_CODE_ADAPTER_ID;
  readonly displayName = 'Claude Code (your installed CLI)';
  readonly capabilities: AgentCapabilities = {
    execution: true,
    headless: true,
    modelSelection: true,
    artifactInstallation: true,
    structuredOutput: true,
    usageReporting: true,
    deterministic: false,
  };
  private readonly options: z.output<typeof claudeCodeAdapterOptionsSchema>;
  private executable: Promise<ClaudeExecutableLookup> | undefined;

  /**
   * @param options validated with {@link claudeCodeAdapterOptionsSchema}; throws when invalid.
   * @param env the CLI process environment: `PATH` locates `claude`, the allowlisted variables
   *   and (subscription) `HOME` are passed on, and API Key Mode reads `ANTHROPIC_API_KEY` from it.
   */
  constructor(
    options: ClaudeCodeAdapterOptions = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    const parsed = claudeCodeAdapterOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new Error(`Invalid claude-code adapter options: ${z.prettifyError(parsed.error)}`);
    }
    this.options = parsed.data;
  }

  /**
   * Detection with per-mode readiness. The first call also pins the located `claude` for every
   * later agent run (`runBenchmark` calls it before any `setup` command runs).
   */
  async detect(): Promise<AgentDetection> {
    const detection = await detectCliAgent(CLAUDE_CODE_AGENT, this.env);
    await this.locate(detection);
    return detection;
  }

  /**
   * The pinned executable: from the first detection, or — when `run()` comes first — located on
   * the CLI `PATH` at that moment. Located once per adapter, i.e. per benchmark run.
   */
  private locate(detection?: AgentDetection): Promise<ClaudeExecutableLookup> {
    this.executable ??= detection
      ? pinClaudeExecutable(
          { executablePath: detection.executablePath, versionLine: detection.version },
          this.env,
        )
      : (async () => {
          const executablePath = await findExecutable(CLAUDE_EXECUTABLE, this.env);
          const versionLine = executablePath
            ? await readVersionLine(executablePath, CLAUDE_CODE_AGENT.versionArgs, this.env)
            : null;
          return pinClaudeExecutable({ executablePath, versionLine }, this.env);
        })();
    return this.executable;
  }

  installArtifact(workspace: WorkspacePin, artifact: ArtifactBundle): Promise<InstalledArtifact> {
    return installClaudeArtifact(workspace, artifact);
  }

  /** The API key of API Key Mode, read from the environment as `run` reads it; else ''. */
  private apiKey(): string {
    return this.options.authMode === 'api-key' ? (this.env[CLAUDE_API_KEY_VARIABLE] ?? '') : '';
  }

  /**
   * The core rules plus this adapter's API key in API Key Mode, in its plain and JSON-escaped
   * forms, as trace redaction knows it (SPEC-123 FR-123-60). Only offsets leave the adapter.
   */
  findOutputSecrets(text: string, options: { textEnd: TextEnd }): readonly TextRange[] {
    const apiKey = this.apiKey();
    return findSecretRanges(text, withJsonForms(apiKey === '' ? [] : [apiKey]), options);
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const started = performance.now();
    const { authMode, permissionProfile, maxBudgetUsd } = this.options;
    const apiKey = this.apiKey();
    const secrets = apiKey === '' ? [] : [apiKey];
    const authWarnings = claudeAuthProfile(authMode).warnings;
    // The one exit: nothing leaves without the redaction of its texts.
    const finish = (result: Omit<AgentRunResult, 'durationMs'>): AgentRunResult => ({
      ...result,
      summary: redactStreamText(result.summary, secrets),
      error: result.error === null ? null : redactStreamText(result.error, secrets),
      durationMs: Math.round(performance.now() - started),
    });
    const refused = (
      status: AgentRunResult['status'],
      error: string,
      errorCode?: string | null,
    ): AgentRunResult =>
      finish({
        status,
        summary: error,
        trace: [],
        usage: null,
        error,
        ...(errorCode == null ? {} : { errorCode }),
        warnings: [...authWarnings],
      });

    try {
      // Nothing — not even locating claude — happens after a cancellation or timeout.
      if (request.signal.aborted) {
        const end = notStartedEnd(request.signal);
        return refused(end.status, end.message);
      }
      const caseOptions = claudeCodeCaseOptionsSchema.safeParse(request.options);
      if (!caseOptions.success) {
        return refused(
          'agent-error',
          `Invalid claude-code agent options: ${z.prettifyError(caseOptions.error)}`,
        );
      }
      // Second line behind the plan-time refusal (FR-118-26): both versions, in every agent run,
      // so a none baseline does not start claude for a run whose candidate is refused.
      const findings = inspectArtifactVersions(request.artifact, request.baselineArtifact);
      const refusal = artifactRefusalCode(findings);
      if (refusal !== null) {
        return refused(
          'infrastructure-error',
          `The artifact versions are refused before claude started: ${findings.map((finding) => `${finding.role} ${finding.file}: ${finding.detail}`).join('; ')}.`,
          refusal,
        );
      }
      const artifact = claudeArtifactProfile(request.artifact);
      if (artifact.format === 'skill-md' && request.baselineArtifact !== null) {
        const issue = baselineSkillNameIssue(request.artifact, request.baselineArtifact);
        if (issue !== null)
          return refused('infrastructure-error', issue, 'baseline-skill-name-differs');
      }

      const located = await this.locate();
      if (!located.ok) return refused('infrastructure-error', located.detail, located.code);
      const { pin } = located;

      const argv = buildClaudeArgv({
        authMode,
        permissionProfile,
        artifact,
        model: request.model,
        ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
      });
      const tempDir = join(request.scratchDir, CLAUDE_RUN_TEMP_DIR);
      const isolatedHome = join(request.scratchDir, CLAUDE_RUN_HOME_DIR);
      const envInput: ClaudeEnvInput =
        authMode === 'api-key'
          ? { authMode, baseEnv: this.env, tempDir, isolatedHome, apiKey }
          : { authMode, baseEnv: this.env, tempDir };
      const env = buildClaudeEnv(envInput);
      // Fresh and exclusive: a home or temporary directory that already exists (or a scratch
      // directory that is a link) may hold configuration someone else planted, which the API Key
      // Mode `CLAUDE_CONFIG_DIR` would load.
      if (!(await lstat(request.scratchDir)).isDirectory()) {
        throw new Error(`The scratch directory ${request.scratchDir} is not a real directory.`);
      }
      await mkdir(tempDir, { mode: 0o700 });
      if (authMode === 'api-key') await mkdir(isolatedHome, { mode: 0o700 });

      const skillName = artifact.format === 'skill-md' ? artifact.skillName : undefined;
      const flagsHash = claudeFlagsHash(argv, {
        ...(skillName === undefined ? {} : { skillName }),
        runLocalPaths: [
          request.scratchDir,
          request.workspace.path,
          request.workspace.canonical,
          tempDir,
          isolatedHome,
        ],
      });
      // Right before the spawn, against the child's own PATH: still the files located before setup.
      // Widened like the spawn's `env` option (Next.js requires `NODE_ENV` in `ProcessEnv`).
      const replaced = await claudeExecutablePinIssue(pin, env as NodeJS.ProcessEnv);
      if (replaced !== null) {
        return refused('infrastructure-error', `${replaced}.`, 'binary-replaced');
      }
      const outcome = await runClaudeCode({
        executable: pin.canonical,
        argv,
        env,
        workspace: request.workspace,
        installedPaths: request.installedPaths,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      if (outcome.process === null) {
        // Refused by the pre-spawn inspection, or cancelled or timed out before the spawn.
        const { status, message: reason, errorCode } = outcome.ended;
        return refused(status, reason, errorCode);
      }

      // The output is fed line by line; the parser keeps at most one line and bounded state.
      const parser = new ClaudeStreamParser({
        prompt: request.prompt,
        knownSecrets: secrets,
        ...(skillName === undefined ? {} : { skillName }),
      });
      for (const line of outcome.process.lines) parser.push(`${line}\n`);
      const parsed = claudeRunOutcome(
        parser.end(),
        { exitCode: outcome.process.exitCode, stderr: outcome.process.stderr },
        {
          adapterVersion: pin.versionLine,
          authMode,
          permissionProfile,
          requestedModel: request.model?.model ?? null,
          flagsHash,
          skill: skillName !== undefined,
        },
        secrets,
      );
      const ended = outcome.ended;
      if (ended === null) return finish(parsed);
      // The process layer ended the run (timeout, cancellation, output limit, survivors, spawn
      // failure): its status and code win; what the stream showed until then is kept.
      const overridden: Omit<AgentRunResult, 'durationMs'> = {
        ...parsed,
        status: ended.status,
        summary: ended.message,
        error: ended.message,
      };
      if (ended.errorCode === null) delete overridden.errorCode;
      else overridden.errorCode = ended.errorCode;
      return finish(overridden);
    } catch (error) {
      return refused(
        'infrastructure-error',
        message(error),
        error instanceof ClaudeCodeError ? error.code : undefined,
      );
    }
  }
}

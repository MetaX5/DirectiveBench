import { Input } from '@/components/ui/input';
import Link from 'next/link';
import {
  getRepositoryBranchChange,
  getRepositoryRegistration,
  getRepositoryRemovalImpact,
  getRepositoryScan,
  listRepositories,
} from '@directivebench/database';
import type { Metadata } from 'next';
import { AutoRefresh } from '@/components/auto-refresh';
import { EmptyState, NotInitialized, PageHeader } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import {
  cancelJobAction,
  changeRepositoryBranchAction,
  registerRepositoryAction,
  removeRepositoryAction,
  scanRepositoryAction,
} from '@/lib/actions';
import { getDatabase } from '@/lib/db';
import {
  branchCaption,
  branchChangeRequestError,
  branchFieldError,
  branchLabel,
  branchPanelHelp,
  branchPanelNote,
  canRemove,
  canScan,
  describeBranchChange,
  describeRegistration,
  describeScan,
  echoedBranch,
  isHosted,
  lastScanLabel,
  mayCarryCredentials,
  parseChangeBranchParam,
  parseRemovalParams,
  pathFieldError,
  providerLabel,
  removalReasons,
  removalResult,
  repositorySubject,
  scanRequestError,
  scannedBranchHint,
  urlFieldError,
  type RegistrationNotice,
} from '@/lib/repositories';

export const metadata: Metadata = { title: 'Repositories' };

const PLANNED = 'Planned: not implemented: private repositories, GitLab';

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<{
    registration?: string;
    path?: string;
    urlError?: string;
    branchName?: string;
    branchError?: string;
    changeBranch?: string | string[];
    branchChange?: string;
    branchChangeError?: string;
    scan?: string;
    scanError?: string;
    remove?: string | string[];
    removedOccurrences?: string | string[];
    missingArtifacts?: string | string[];
    removeError?: string | string[];
  }>;
}) {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Repositories" />
        <NotInitialized />
      </>
    );
  const params = await searchParams;
  const registration = params.registration
    ? await getRepositoryRegistration(handle.db, params.registration)
    : null;
  let notice: RegistrationNotice | null = registration ? describeRegistration(registration) : null;
  const invalidPath = !notice && params.path !== undefined ? pathFieldError(params.path) : null;
  // The action never echoes input that may carry credentials; a hand-made or old `?path=` or
  // `?branchName=` with `@`, `?` or `#` is not put back into the field either (FR-104-05).
  const echoedPath = mayCarryCredentials(params.path ?? '') ? '' : (params.path ?? '');
  const echoed = echoedBranch(params.branchName);
  if (invalidPath !== null) {
    notice = {
      kind: 'fieldError',
      field: 'path',
      path: echoedPath,
      branch: echoed,
      message: invalidPath,
    };
  }
  // A rejected Branch of the register form (issue 58): the path was accepted.
  const invalidBranch =
    !notice && params.changeBranch === undefined ? branchFieldError(params.branchError) : null;
  if (invalidBranch !== null) {
    notice = {
      kind: 'fieldError',
      field: 'branch',
      path: echoedPath,
      branch: echoed,
      message: invalidBranch,
    };
  }
  // A rejected URL that may hold credentials comes back without the input, only with the reason.
  const invalidUrl = !notice ? urlFieldError(params.urlError) : null;
  if (invalidUrl !== null) {
    notice = { kind: 'fieldError', field: 'path', path: '', branch: '', message: invalidUrl };
  }
  const scan = params.scan ? await getRepositoryScan(handle.db, params.scan) : null;
  const scanNotice = scan ? describeScan(scan) : null;
  const scanError = scanRequestError(params.scanError);
  const repositories = await listRepositories(handle.db);
  // SPEC-125 Phase 2: the Risky-action panel for `?remove=` and the outcome of a removal.
  const removal = parseRemovalParams(params);
  const removalImpact = removal.remove
    ? await getRepositoryRemovalImpact(handle.db, removal.remove)
    : null;
  const removalLine = removalResult(removal, {
    unknownTarget:
      removal.remove !== null &&
      !repositories.some((repository) => repository.id === removal.remove),
  });
  const checking = notice?.kind === 'active';
  const fieldError = notice?.kind === 'fieldError' ? notice : null;
  const pathError = fieldError?.field === 'path' ? fieldError : null;
  const branchError = fieldError?.field === 'branch' ? fieldError : null;
  // The values the form shows again: while the runner checks them and after an error.
  const formValues =
    notice && (notice.kind === 'active' || notice.kind === 'fieldError') ? notice : null;
  const confirmation = notice?.kind === 'confirm' ? notice : null;
  const scanning = scanNotice?.kind === 'active';

  // Issue 58: the Change branch panel (`?changeBranch=`), a branch change job (`?branchChange=`)
  // and why a change could not be enqueued (`?branchChangeError=`).
  const branchChange = params.branchChange
    ? await getRepositoryBranchChange(handle.db, params.branchChange)
    : null;
  const changeNotice = branchChange ? describeBranchChange(branchChange) : null;
  const panelTarget = parseChangeBranchParam(params.changeBranch);
  const panelRepository =
    changeNotice?.kind === 'active' || changeNotice?.kind === 'fieldError'
      ? (repositories.find((repository) => repository.id === branchChange?.repositoryId) ?? null)
      : (repositories.find((repository) => repository.id === panelTarget && isHosted(repository)) ??
        null);
  const panelError =
    changeNotice?.kind === 'fieldError'
      ? changeNotice.message
      : panelRepository && params.changeBranch !== undefined
        ? branchFieldError(params.branchError === 'invalid' ? 'invalid' : undefined)
        : null;
  const panelValue =
    changeNotice?.kind === 'active' || changeNotice?.kind === 'fieldError'
      ? changeNotice.value
      : panelError !== null
        ? echoed
        : (panelRepository?.selectedBranch ?? '');
  const panelPending = changeNotice?.kind === 'active';
  // `?changeBranch=` for a repository that is gone or not hosted says so instead of a panel.
  const panelRefusal =
    panelTarget === null || panelRepository || branchChange
      ? undefined
      : repositories.some((repository) => repository.id === panelTarget)
        ? 'unsupported'
        : 'not-found';
  const requestError = branchChangeRequestError(params.branchChangeError ?? panelRefusal);
  const branchLine =
    changeNotice?.kind === 'done' || changeNotice?.kind === 'error'
      ? changeNotice
      : requestError === null
        ? null
        : { kind: 'error' as const, message: requestError };

  return (
    <>
      <AutoRefresh active={checking || scanning || panelPending} />
      <PageHeader
        title="Repositories"
        description="Sources DirectiveBench reads skills, instructions and rules from."
        actions={<Badge variant="muted">{PLANNED}</Badge>}
      />
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Register a repository</CardTitle>
            <CardDescription>
              Enter a local path or the URL of a public GitHub repository. A Git work tree is
              registered at its top-level directory with its current branch; any other directory as
              a plain folder. Read-only: DirectiveBench runs only read-only git commands with hooks
              disabled and never writes to the repository. The filesystem root cannot be registered;
              your home directory and paths that overlap a registered repository ask for a
              confirmation first. A GitHub URL is registered without credentials (a URL that
              contains any is rejected). A GitHub repository is scanned on its default branch unless
              you name another branch. A local repository is scanned from its working tree.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-stack">
            <form
              action={registerRepositoryAction}
              className="flex flex-wrap items-start gap-inline"
            >
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-ui text-muted-foreground">
                Path or GitHub URL
                <Input
                  name="path"
                  required
                  defaultValue={formValues?.path ?? ''}
                  placeholder="~/code/my-skills or https://github.com/owner/repo"
                  aria-invalid={pathError ? true : undefined}
                  aria-describedby={pathError ? 'path-error' : undefined}
                  disabled={checking}
                  className="font-mono"
                />
              </label>
              <div className="flex w-full min-w-0 flex-col gap-1 sm:w-56">
                <label className="flex flex-col gap-1 text-ui text-muted-foreground">
                  Branch (optional)
                  <Input
                    name="branch"
                    defaultValue={formValues?.branch ?? ''}
                    aria-invalid={branchError ? true : undefined}
                    aria-describedby={branchError ? 'branch-error branch-help' : 'branch-help'}
                    autoFocus={branchError !== null}
                    disabled={checking}
                    className="font-mono"
                  />
                </label>
                {branchError ? (
                  <p
                    id="branch-error"
                    role="alert"
                    data-testid="branch-error"
                    className="text-ui text-destructive-foreground wrap-anywhere"
                  >
                    {branchError.message}
                  </p>
                ) : null}
                <p id="branch-help" className="text-caption text-muted-foreground">
                  GitHub only. Empty: the default branch.
                </p>
              </div>
              {/* The label row is 20px (text-ui line + gap-1): the button lines up with the inputs. */}
              <Button type="submit" disabled={checking} className="mt-5">
                Register
              </Button>
            </form>
            {pathError ? (
              <p
                id="path-error"
                role="alert"
                data-testid="path-error"
                className="text-ui text-destructive-foreground"
              >
                {pathError.message}
              </p>
            ) : null}
            {confirmation ? (
              <div
                role="alert"
                data-testid="registration-confirmation"
                className="space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui"
              >
                <p className="font-medium">{confirmation.message}</p>
                <ul className="list-disc space-y-1 pl-4">
                  {confirmation.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <form action={registerRepositoryAction} className="flex items-center gap-inline">
                  <input type="hidden" name="path" value={confirmation.path} />
                  <input type="hidden" name="confirmedLocation" value={confirmation.location} />
                  <Button type="submit" size="sm" variant="destructive">
                    Register anyway
                  </Button>
                  <Link href="/repositories" className="text-ui underline">
                    Cancel
                  </Link>
                </form>
              </div>
            ) : null}
            {notice && notice.kind !== 'fieldError' && notice.kind !== 'confirm' ? (
              <p
                role="status"
                data-testid="registration-status"
                data-state={notice.kind}
                className={
                  notice.kind === 'done'
                    ? 'text-ui text-success-foreground wrap-anywhere'
                    : 'text-ui wrap-anywhere'
                }
              >
                {notice.message}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {scanError ? (
          <p
            role="alert"
            data-testid="scan-request-error"
            className="text-ui text-destructive-foreground"
          >
            {scanError}
          </p>
        ) : null}

        {removalLine ? (
          <p
            id="remove-result"
            role={removalLine.kind === 'error' ? 'alert' : 'status'}
            data-testid="remove-result"
            data-state={removalLine.kind}
            className={
              removalLine.kind === 'error'
                ? 'text-ui text-destructive-foreground'
                : removalLine.kind === 'done'
                  ? 'text-ui text-success-foreground'
                  : 'text-ui'
            }
          >
            {removalLine.message}
          </p>
        ) : null}

        {scanNotice ? (
          <Card>
            <CardContent className="space-y-stack pt-4">
              <div className="flex flex-wrap items-center gap-inline">
                <p
                  role="status"
                  data-testid="scan-status"
                  data-state={scanNotice.kind}
                  className={
                    scanNotice.kind === 'error'
                      ? 'text-ui text-destructive-foreground'
                      : scanNotice.kind === 'done'
                        ? 'text-ui text-success-foreground'
                        : scanNotice.kind === 'warning'
                          ? 'text-ui text-warning-foreground'
                          : 'text-ui'
                  }
                >
                  {scanNotice.message}
                </p>
                {scan && scanning ? (
                  <form action={cancelJobAction}>
                    <input type="hidden" name="jobId" value={scan.jobId} />
                    <Button type="submit" size="sm" variant="outline">
                      Cancel scan
                    </Button>
                  </form>
                ) : null}
              </div>
              {scanNotice.info ? (
                <p data-testid="scan-info" className="text-ui text-muted-foreground">
                  {scanNotice.info}
                </p>
              ) : null}
              {scanNotice.errors.length > 0 ? (
                <div data-testid="scan-errors" className="space-y-1">
                  <p className="text-ui font-medium">
                    Discovery errors
                    {scanNotice.errorCount > scanNotice.errors.length
                      ? ` (first ${scanNotice.errors.length} of ${scanNotice.errorCount})`
                      : ''}
                  </p>
                  <ul className="space-y-0.5 text-ui">
                    {scanNotice.errors.map((error) => (
                      <li key={`${error.path}:${error.code}`}>
                        <span className="font-mono">{error.path}</span>{' '}
                        <Badge variant="destructive">{error.code}</Badge> {error.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {repositories.length === 0 ? (
          <EmptyState title="No repositories yet">
            Register the path of a local Git repository or folder, or a public GitHub URL, above.
          </EmptyState>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Registered repositories</CardTitle>
              <CardDescription data-testid="scan-explanation">
                Scan finds the skills, instructions and rules in a repository. For a local
                repository it reads the files on disk (the working tree, including uncommitted and
                untracked files, also for Git repositories) and skips user-level agent folders such
                as ~/.claude. For a GitHub repository it downloads only the candidate files of the
                latest commit of its branch into a private cache, without a checkout, and records
                that commit. Either way it skips .git and node_modules, never follows symbolic links
                and never runs anything from the repository. Rescanning keeps one artifact per path
                and adds a version only when its content changed. A file that a later scan does not
                find is marked missing; its history is kept. A skill, rule or instruction moved or
                renamed inside the repository between two scans keeps its artifact and history when
                its content is unchanged and nothing else added or removed in that scan has the same
                content. A renamed rule file gets a new version, because a rule is named after its
                file. A skill or rule identical to one already found in another local repository is
                added to that artifact instead of becoming a new one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {branchLine ? (
                <p
                  id="branch-panel"
                  tabIndex={-1}
                  role={branchLine.kind === 'error' ? 'alert' : 'status'}
                  data-testid="branch-result"
                  data-state={branchLine.kind}
                  className={
                    branchLine.kind === 'error'
                      ? 'mb-4 text-ui text-destructive-foreground outline-none wrap-anywhere'
                      : 'mb-4 text-ui text-success-foreground outline-none wrap-anywhere'
                  }
                >
                  {branchLine.message}
                </p>
              ) : null}
              {panelRepository && !branchLine ? (
                // Not focusable: after an error the `#branch-panel` fragment only scrolls to it,
                // and the Branch field's autofocus puts focus in the field (B9).
                <div
                  id="branch-panel"
                  data-testid="branch-panel"
                  className="mb-4 min-w-0 space-y-stack rounded-surface border border-control p-3 text-ui outline-none"
                >
                  <p className="font-medium wrap-anywhere">
                    Branch of {panelRepository.name} ({providerLabel(panelRepository.provider)},{' '}
                    <span className="font-mono">{panelRepository.location}</span>)
                  </p>
                  <form
                    action={changeRepositoryBranchAction}
                    className="flex flex-wrap items-start gap-inline"
                  >
                    <input type="hidden" name="repositoryId" value={panelRepository.id} />
                    <div className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-80">
                      <label className="flex flex-col gap-1 text-ui text-muted-foreground">
                        Branch
                        <Input
                          name="branch"
                          defaultValue={panelValue}
                          aria-invalid={panelError !== null ? true : undefined}
                          aria-describedby={
                            panelError !== null
                              ? 'change-branch-error change-branch-help'
                              : 'change-branch-help'
                          }
                          autoFocus={!panelPending}
                          disabled={panelPending}
                          className="font-mono"
                        />
                      </label>
                      {panelError !== null ? (
                        <p
                          id="change-branch-error"
                          role="alert"
                          data-testid="change-branch-error"
                          className="text-destructive-foreground wrap-anywhere"
                        >
                          {panelError}
                        </p>
                      ) : null}
                      <p id="change-branch-help" className="text-caption text-muted-foreground">
                        {branchPanelHelp(panelRepository)}
                      </p>
                    </div>
                    <div className="mt-5 flex items-center gap-inline">
                      <Button type="submit" disabled={panelPending}>
                        Save branch
                      </Button>
                      {/* A full page load (not `Link`): on load the browser focuses the
                          fragment's target, the row's Change button (issue 249); a client
                          navigation only scrolls to it. */}
                      <a
                        href={`/repositories#change-branch-${panelRepository.id}`}
                        className="text-ui underline"
                      >
                        Cancel
                      </a>
                    </div>
                  </form>
                  {changeNotice?.kind === 'active' ? (
                    <p role="status" data-testid="branch-status" className="wrap-anywhere">
                      {changeNotice.message}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground">{branchPanelNote(panelRepository)}</p>
                </div>
              ) : null}
              {removalImpact ? (
                <div
                  id="remove-panel"
                  tabIndex={-1}
                  role="alert"
                  data-testid="remove-panel"
                  className="mb-4 min-w-0 space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui outline-none"
                >
                  <p className="font-medium wrap-anywhere">
                    Remove {removalImpact.name} ({providerLabel(removalImpact.provider)},{' '}
                    <span className="font-mono">{removalImpact.location}</span>)?
                  </p>
                  <ul className="list-disc space-y-1 pl-4 wrap-anywhere">
                    {removalReasons(removalImpact).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  <form
                    action={removeRepositoryAction}
                    className="flex flex-wrap items-center gap-inline"
                  >
                    <input type="hidden" name="repositoryId" value={removalImpact.id} />
                    <Button type="submit" size="sm" variant="destructive">
                      Remove repository
                    </Button>
                    <Link
                      href={`/repositories#repository-${removalImpact.id}`}
                      className="text-ui underline"
                    >
                      Cancel
                    </Link>
                  </form>
                </div>
              ) : null}
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Provider</TH>
                    <TH>Location</TH>
                    <TH>Branch</TH>
                    <TH className="text-right">Artifacts</TH>
                    <TH>Last scan</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {repositories.map((repository) => (
                    <TR
                      key={repository.id}
                      id={`repository-${repository.id}`}
                      data-provider={repository.provider}
                    >
                      <TD className="font-medium">{repository.name}</TD>
                      <TD>{providerLabel(repository.provider)}</TD>
                      <TD
                        className="max-w-md truncate font-mono text-ui"
                        title={repository.location}
                      >
                        {repository.location}
                      </TD>
                      <TD className="text-ui">
                        <span className="font-mono">{branchLabel(repository) ?? '—'}</span>
                        {branchCaption(repository) ? (
                          <span className="block text-caption text-muted-foreground">
                            {branchCaption(repository)}
                          </span>
                        ) : null}
                        {isHosted(repository) ? (
                          // Issue 249: Change sits under the caption, so Scan and Remove fit on
                          // one line. No `#branch-panel`: a fragment target stops the browser's
                          // autofocus, and focusing the Branch field scrolls the panel into view
                          // (issue 58 B9). The panel's Cancel returns focus here by its id.
                          <form method="get" action="/repositories" className="mt-1">
                            <input type="hidden" name="changeBranch" value={repository.id} />
                            <Button
                              id={`change-branch-${repository.id}`}
                              type="submit"
                              size="xs"
                              variant="outline"
                              aria-label={`Change branch of ${repositorySubject(repository)}`}
                            >
                              Change
                            </Button>
                          </form>
                        ) : null}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {Number(repository.artifactCount)}
                      </TD>
                      <TD
                        className={
                          repository.syncStatus === 'error'
                            ? 'max-w-xs text-ui whitespace-normal text-destructive-foreground'
                            : scannedBranchHint(repository)
                              ? 'max-w-xs text-ui whitespace-normal text-warning-foreground'
                              : 'text-ui'
                        }
                      >
                        {lastScanLabel(repository)}
                        {scannedBranchHint(repository) ? `. ${scannedBranchHint(repository)}` : ''}
                      </TD>
                      <TD className="text-right">
                        <div className="flex flex-nowrap justify-end gap-inline">
                          {canScan(repository) ? (
                            <form action={scanRepositoryAction}>
                              <input type="hidden" name="repositoryId" value={repository.id} />
                              <Button
                                type="submit"
                                size="sm"
                                variant="outline"
                                aria-label={`Scan ${repositorySubject(repository)}`}
                              >
                                Scan
                              </Button>
                            </form>
                          ) : null}
                          {canRemove(repository) ? (
                            <form method="get" action="/repositories#remove-panel">
                              <input type="hidden" name="remove" value={repository.id} />
                              <Button
                                type="submit"
                                size="sm"
                                variant="outline"
                                aria-label={`Remove ${repositorySubject(repository)}`}
                              >
                                Remove
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

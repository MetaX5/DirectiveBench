import Link from 'next/link';
import {
  getRepositoryRegistration,
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
import { cancelJobAction, registerRepositoryAction, scanRepositoryAction } from '@/lib/actions';
import { getDatabase } from '@/lib/db';
import {
  branchLabel,
  canScan,
  describeRegistration,
  describeScan,
  lastScanLabel,
  pathFieldError,
  providerLabel,
  scanRequestError,
  type RegistrationNotice,
} from '@/lib/repositories';

export const metadata: Metadata = { title: 'Repositories' };

const PLANNED = 'Planned — not implemented: hosted URLs, marking deleted artifacts as missing';

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<{
    registration?: string;
    path?: string;
    scan?: string;
    scanError?: string;
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
  if (invalidPath !== null) {
    notice = { kind: 'fieldError', path: params.path ?? '', message: invalidPath };
  }
  const scan = params.scan ? await getRepositoryScan(handle.db, params.scan) : null;
  const scanNotice = scan ? describeScan(scan) : null;
  const scanError = scanRequestError(params.scanError);
  const repositories = await listRepositories(handle.db);
  const checking = notice?.kind === 'active';
  const fieldError = notice?.kind === 'fieldError' ? notice : null;
  const confirmation = notice?.kind === 'confirm' ? notice : null;
  const scanning = scanNotice?.kind === 'active';

  return (
    <>
      <AutoRefresh active={checking || scanning} />
      <PageHeader
        title="Repositories"
        description="Sources DirectiveBench reads skills, instructions and rules from."
        actions={<Badge variant="muted">{PLANNED}</Badge>}
      />
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Register a local repository</CardTitle>
            <CardDescription>
              A Git work tree is registered at its top-level directory with its current branch; any
              other directory as a plain folder. Read-only: DirectiveBench runs only read-only git
              commands with hooks disabled and never writes to the repository. The filesystem root
              cannot be registered; your home directory and paths that overlap a registered
              repository ask for a confirmation first.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <form action={registerRepositoryAction} className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                Path
                <input
                  name="path"
                  required
                  defaultValue={fieldError?.path ?? ''}
                  placeholder="/home/you/code/my-skills or ~/code/my-skills"
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? 'path-error' : undefined}
                  disabled={checking}
                  className="h-8 rounded-md border bg-background px-2 font-mono text-sm text-foreground aria-[invalid=true]:border-destructive"
                />
              </label>
              <Button type="submit" size="sm" disabled={checking}>
                Register
              </Button>
            </form>
            {fieldError ? (
              <p
                id="path-error"
                role="alert"
                data-testid="path-error"
                className="text-xs text-destructive"
              >
                {fieldError.message}
              </p>
            ) : null}
            {confirmation ? (
              <div
                role="alert"
                data-testid="registration-confirmation"
                className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs"
              >
                <p className="font-medium">{confirmation.message}</p>
                <ul className="list-disc space-y-1 pl-4">
                  {confirmation.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <form action={registerRepositoryAction} className="flex items-center gap-2">
                  <input type="hidden" name="path" value={confirmation.path} />
                  <input type="hidden" name="confirmedLocation" value={confirmation.location} />
                  <Button type="submit" size="sm" variant="destructive">
                    Register anyway
                  </Button>
                  <Link href="/repositories" className="text-xs underline">
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
                className={notice.kind === 'done' ? 'text-xs text-success' : 'text-xs'}
              >
                {notice.message}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {scanError ? (
          <p role="alert" data-testid="scan-request-error" className="text-xs text-destructive">
            {scanError}
          </p>
        ) : null}

        {scanNotice ? (
          <Card>
            <CardContent className="space-y-2 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <p
                  role="status"
                  data-testid="scan-status"
                  data-state={scanNotice.kind}
                  className={
                    scanNotice.kind === 'error'
                      ? 'text-xs text-destructive'
                      : scanNotice.kind === 'done'
                        ? 'text-xs text-success'
                        : 'text-xs'
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
                <p data-testid="scan-info" className="text-xs text-muted-foreground">
                  {scanNotice.info}
                </p>
              ) : null}
              {scanNotice.errors.length > 0 ? (
                <div data-testid="scan-errors" className="space-y-1">
                  <p className="text-xs font-medium">
                    Discovery errors
                    {scanNotice.errorCount > scanNotice.errors.length
                      ? ` (first ${scanNotice.errors.length} of ${scanNotice.errorCount})`
                      : ''}
                  </p>
                  <ul className="space-y-0.5 text-xs">
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
            Register the path of a local Git repository or folder above.
          </EmptyState>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Registered repositories</CardTitle>
              <CardDescription data-testid="scan-explanation">
                Scan finds the skills, instructions and rules in a local repository. It reads the
                files on disk — the working tree, including uncommitted and untracked files, also
                for Git repositories — skips .git, node_modules and user-level agent folders such as
                ~/.claude, never follows symbolic links and never runs anything from the repository.
                Rescanning keeps one artifact per path and adds a version only when its content
                changed.
              </CardDescription>
            </CardHeader>
            <CardContent>
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
                    <TR key={repository.id} data-provider={repository.provider}>
                      <TD className="font-medium">{repository.name}</TD>
                      <TD>{providerLabel(repository.provider)}</TD>
                      <TD
                        className="max-w-md truncate font-mono text-xs"
                        title={repository.location}
                      >
                        {repository.location}
                      </TD>
                      <TD className="font-mono text-xs">{branchLabel(repository) ?? '—'}</TD>
                      <TD className="text-right tabular-nums">
                        {Number(repository.artifactCount)}
                      </TD>
                      <TD
                        className={
                          repository.syncStatus === 'error'
                            ? 'max-w-xs truncate text-xs text-destructive'
                            : 'text-xs'
                        }
                        title={repository.syncError ?? undefined}
                      >
                        {lastScanLabel(repository)}
                      </TD>
                      <TD className="text-right">
                        {canScan(repository) ? (
                          <form action={scanRepositoryAction}>
                            <input type="hidden" name="repositoryId" value={repository.id} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="outline"
                              aria-label={`Scan ${repository.name}`}
                            >
                              Scan
                            </Button>
                          </form>
                        ) : null}
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

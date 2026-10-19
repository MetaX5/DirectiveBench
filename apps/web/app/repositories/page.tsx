import { getRepositoryRegistration, listRepositories } from '@directivebench/database';
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
import { registerRepositoryAction } from '@/lib/actions';
import { getDatabase } from '@/lib/db';
import {
  branchLabel,
  describeRegistration,
  providerLabel,
  type RegistrationNotice,
} from '@/lib/repositories';

export const metadata: Metadata = { title: 'Repositories' };

const PLANNED = 'Planned — not implemented: scanning, hosted URLs';

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ registration?: string; path?: string; error?: string }>;
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
  if (!notice && params.error) {
    notice = { kind: 'fieldError', path: params.path ?? '', message: params.error };
  }
  const repositories = await listRepositories(handle.db);
  const checking = notice?.kind === 'active';
  const fieldError = notice?.kind === 'fieldError' ? notice : null;

  return (
    <>
      <AutoRefresh active={checking} />
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
              commands with hooks disabled and never writes to the repository.
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
            {notice && notice.kind !== 'fieldError' ? (
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

        {repositories.length === 0 ? (
          <EmptyState title="No repositories yet">
            Register the path of a local Git repository or folder above.
          </EmptyState>
        ) : (
          <Card>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Provider</TH>
                    <TH>Location</TH>
                    <TH>Branch</TH>
                    <TH className="text-right">Artifacts</TH>
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

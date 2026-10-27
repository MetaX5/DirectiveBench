import type { DisplayStatus } from '@directivebench/benchmark-engine/scoring';
import { Construction, DatabaseZap, FlaskConical } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardContent } from '@/components/ui/primitives';

// Pure logic lives in lib/ so it is unit-tested; re-exported for existing page imports.
export { runDisplayStatus } from '@/lib/run-status';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-section flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-page-title tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex min-w-0 max-w-full items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const statusStyles: Record<
  DisplayStatus,
  { label: string; variant: Parameters<typeof Badge>[0]['variant'] }
> = {
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  regression: { label: 'Regression', variant: 'destructive' },
  unstable: { label: 'Unstable', variant: 'warning' },
  error: { label: 'Error', variant: 'destructive' },
  'not-tested': { label: 'Not tested', variant: 'muted' },
  'not-comparable': { label: 'Not comparable', variant: 'warning' },
};

export function StatusBadge({ status }: { status: DisplayStatus }) {
  const style = statusStyles[status];
  return (
    <Badge variant={style.variant} data-status={status}>
      {style.label}
    </Badge>
  );
}

const jobVariants = {
  pending: 'muted',
  running: 'info',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'outline',
  interrupted: 'warning',
} as const;

export function JobStatusBadge({ status }: { status: keyof typeof jobVariants }) {
  return <Badge variant={jobVariants[status]}>{status}</Badge>;
}

export function MockBadge() {
  return (
    <Badge
      variant="warning"
      title="Results come from the deterministic mock agent, not from an AI model"
    >
      <FlaskConical className="size-3" aria-hidden />
      Mock agent — not an AI evaluation
    </Badge>
  );
}

export function NotSandboxedBadge() {
  return (
    <Badge
      variant="outline"
      title="Commands run as your user without isolation (local-process environment)"
    >
      Not sandboxed
    </Badge>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-10 text-center">
        <p className="text-sm font-medium">{title}</p>
        {children ? <div className="mt-2 text-sm text-muted-foreground">{children}</div> : null}
      </CardContent>
    </Card>
  );
}

export function NotInitialized() {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-6">
        <DatabaseZap className="mt-0.5 size-5 text-warning-foreground" aria-hidden />
        <div className="text-sm">
          <p className="font-medium">The local database has not been initialised.</p>
          <p className="mt-1 text-muted-foreground">
            Start the app through the CLI (<code className="font-mono">npx directivebench</code>) or
            run <code className="font-mono">directivebench init</code>, then reload this page.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Honest placeholder for sections that are specified but not implemented yet. */
export function PlannedSection({
  title,
  summary,
  milestone,
  specs,
}: {
  title: string;
  summary: string;
  milestone: string;
  specs: string[];
}) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <CardContent className="flex items-start gap-3 py-6">
          <Construction className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
          <div className="space-y-2 text-sm">
            <p>
              <Badge variant="muted">Planned — not implemented</Badge>
            </p>
            <p>{summary}</p>
            <p className="text-muted-foreground">
              Scheduled for {milestone}. Specifications in the repository:
            </p>
            <ul className="list-inside list-disc font-mono text-xs text-muted-foreground">
              {specs.map((spec) => (
                <li key={spec}>{spec}</li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

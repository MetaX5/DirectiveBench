import Link from 'next/link';
import { PageHeader } from '@/components/common';
import { Card, CardContent } from '@/components/ui/primitives';
import { BLIND_REVIEW_CLOSED_NOTICE, blindReviewHref } from '@/lib/blind-review';

/**
 * A labelled page while the run's blind review is unrevealed (SPEC-123 FR-123-52a, D55): the
 * page title, the notice and the way to the review, and nothing read from the agent runs, so
 * neither the HTML nor the RSC payload names a variant, whatever ids the URL holds.
 */
export function BlindReviewClosedPage({ runId, title }: { runId: string; title: string }) {
  return (
    <>
      <p className="mb-2 text-body">
        <Link href={`/results/${encodeURIComponent(runId)}`} className="underline">
          Back to the run
        </Link>
      </p>
      <PageHeader
        title={title}
        description={
          <>
            run <span className="font-mono">{runId}</span>
          </>
        }
      />
      <Card data-testid="blind-review-closed">
        <CardContent className="space-y-stack text-body">
          <p>{BLIND_REVIEW_CLOSED_NOTICE}</p>
          <Link className="text-primary-text underline" href={blindReviewHref(runId)}>
            Continue the blind review
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

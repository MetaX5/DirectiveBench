'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { Textarea } from '@/components/ui/textarea';
import {
  recordBlindVerdictAction,
  revealBlindReviewAction,
  startBlindReviewAction,
} from '@/lib/actions';
import {
  BLIND_REVIEW_NOTE_MAX_CHARS,
  BLIND_VERDICT_LABELS,
  type BlindReviewFormState,
} from '@/lib/blind-review';

// The three forms of the blind review (SPEC-123 §6.5, D47, D51 to D53). Each posts to its server
// action; nothing here receives a variant, an agent-run id or a repetition.

const idle: BlindReviewFormState = { kind: 'idle' };

/** "Start blind review" on the run page (D47). Success goes to the review page. */
export function StartBlindReviewForm({ benchmarkRunId }: { benchmarkRunId: string }) {
  const [state, dispatch, pending] = useActionState(startBlindReviewAction, idle);
  return (
    <form action={dispatch} className="space-y-stack">
      <input type="hidden" name="benchmarkRunId" value={benchmarkRunId} />
      <Button type="submit" disabled={pending}>
        Start blind review
      </Button>
      <p role="status" className="text-ui wrap-anywhere empty:hidden">
        {pending ? 'Starting the blind review.' : state.kind === 'idle' ? '' : state.message}
      </p>
    </form>
  );
}

const VERDICTS = ['a', 'b', 'tie'] as const;

/**
 * The verdict of one pair (D51, D52): a note, then three submit buttons; one click records.
 * After a verdict the server renders `recorded`, and this panel shows it with the result line,
 * which takes the focus so keyboard and screen-reader users hear it. Keyed by pair, so moving
 * to another pair starts afresh.
 */
export function VerdictPanel({
  benchmarkRunId,
  pairId,
  position,
  recorded,
  closed,
  next,
}: {
  benchmarkRunId: string;
  pairId: string;
  position: number;
  /** The pair's verdict once recorded, as the server read it. */
  recorded: { label: string; note: string | null } | null;
  /** The review was revealed: no verdict can be recorded. */
  closed: boolean;
  /** The next pair without a verdict, or null when every pair has one. */
  next: { href: string } | null;
}) {
  const [state, dispatch, pending] = useActionState(recordBlindVerdictAction, idle);
  const status = useRef<HTMLParagraphElement>(null);
  const [editedAfter, setEditedAfter] = useState<BlindReviewFormState | null>(null);
  const fieldError = state.kind === 'fieldError' && !pending && editedAfter !== state;

  useEffect(() => {
    // The buttons are disabled while recording, which drops their focus: the result line
    // (or the field, after a field error) takes it.
    if (state.kind === 'fieldError') document.getElementById(`note-${pairId}`)?.focus();
    else if (state.kind !== 'idle') status.current?.focus();
  }, [state, pairId]);

  const resultLine = (
    <p
      ref={status}
      role="status"
      tabIndex={-1}
      className="text-ui wrap-anywhere outline-none empty:hidden"
      data-testid="verdict-status"
    >
      {pending
        ? 'Recording the verdict.'
        : state.kind === 'success' || state.kind === 'error'
          ? state.message
          : ''}
      {state.kind === 'success' && !pending ? (
        next ? (
          <>
            {' '}
            <Link className="text-primary-text underline" href={next.href}>
              Next pair without a verdict
            </Link>
          </>
        ) : (
          ' All pairs have a verdict. You can reveal the variants.'
        )
      ) : null}
    </p>
  );

  if (recorded) {
    return (
      <div className="space-y-stack" data-testid="verdict-recorded">
        <p className="text-body font-medium">Your verdict: {recorded.label}.</p>
        {recorded.note ? (
          <p className="text-body whitespace-pre-wrap wrap-anywhere">{recorded.note}</p>
        ) : null}
        {resultLine}
      </div>
    );
  }
  if (closed) {
    return (
      <p className="text-body">
        This review was revealed; verdicts are closed. No verdict was recorded for this pair.
      </p>
    );
  }
  return (
    <form action={dispatch} className="space-y-stack" noValidate>
      <input type="hidden" name="benchmarkRunId" value={benchmarkRunId} />
      <input type="hidden" name="pairId" value={pairId} />
      <p className="text-body">A verdict cannot be changed after you record it.</p>
      <label className="flex flex-col gap-1 text-ui text-muted-foreground">
        Note (optional)
        <Textarea
          id={`note-${pairId}`}
          name="note"
          maxLength={BLIND_REVIEW_NOTE_MAX_CHARS}
          onChange={() => setEditedAfter(state)}
          defaultValue={state.kind === 'fieldError' ? state.value : ''}
          disabled={pending}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `note-${pairId}-error` : undefined}
        />
      </label>
      {fieldError ? (
        <p
          id={`note-${pairId}-error`}
          role="alert"
          className="text-ui wrap-anywhere text-destructive-foreground"
        >
          {state.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-inline">
        {VERDICTS.map((verdict) => (
          <Button
            key={verdict}
            type="submit"
            name="verdict"
            value={verdict}
            variant="outline"
            disabled={pending}
            aria-label={`${BLIND_VERDICT_LABELS[verdict]}, pair ${position}`}
          >
            {BLIND_VERDICT_LABELS[verdict]}
          </Button>
        ))}
      </div>
      {resultLine}
    </form>
  );
}

/**
 * "Reveal variants" with the inline Risky-action confirmation (D53). After the reveal the server
 * renders the result; this panel then only says what happened (and takes the focus).
 */
export function RevealPanel({
  benchmarkRunId,
  reviewId,
  revealed,
  undecided,
  total,
}: {
  benchmarkRunId: string;
  reviewId: string;
  revealed: boolean;
  undecided: number;
  total: number;
}) {
  const [state, dispatch, pending] = useActionState(revealBlindReviewAction, idle);
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (confirming) confirm.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (state.kind !== 'idle') status.current?.focus();
  }, [state]);

  const line = (
    <p
      ref={status}
      role="status"
      tabIndex={-1}
      className="text-ui wrap-anywhere outline-none empty:hidden"
      data-testid="reveal-status"
    >
      {pending ? 'Revealing the variants.' : state.kind === 'idle' ? '' : state.message}
    </p>
  );
  if (revealed) return state.kind === 'idle' ? null : line;

  const sentence = 'Revealing ends the blind review. Pairs without a verdict stay without one.';
  return (
    <Card data-testid="reveal-card">
      <CardHeader>
        <CardTitle>Reveal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-stack">
        <p className="text-body">{sentence}</p>
        {confirming ? (
          <div
            role="alert"
            data-testid="reveal-confirmation"
            className="space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui"
          >
            <p className="font-medium">Reveal the variants of this blind review?</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>{sentence}</li>
              {undecided > 0 ? (
                <li>
                  {undecided} of {total} {total === 1 ? 'pair has' : 'pairs have'} no verdict.
                </li>
              ) : null}
            </ul>
            <form action={dispatch} className="flex flex-wrap items-center gap-inline">
              <input type="hidden" name="benchmarkRunId" value={benchmarkRunId} />
              <input type="hidden" name="reviewId" value={reviewId} />
              <Button
                ref={confirm}
                type="submit"
                size="sm"
                variant="destructive"
                disabled={pending}
              >
                Reveal variants
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  // The opener is back after this render.
                  requestAnimationFrame(() => opener.current?.focus());
                }}
              >
                Cancel
              </Button>
            </form>
          </div>
        ) : (
          <Button
            ref={opener}
            type="button"
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            Reveal variants
          </Button>
        )}
        {line}
      </CardContent>
    </Card>
  );
}

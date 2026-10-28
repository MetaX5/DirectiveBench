'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  addArtifactTagAction,
  assignArtifactSuiteAction,
  removeArtifactTagAction,
  saveArtifactNotesAction,
  unassignArtifactSuiteAction,
} from '@/lib/actions';
import type { MetadataFormState } from '@/lib/artifact-metadata';

// Editing forms of the artifact detail page (SPEC-101 §11, issue #64), built on the Form
// pattern: a visible label, the field error under the field, a role="status" line while saving
// and after it, and the entered value kept after an error.

const idle: MetadataFormState = { kind: 'idle' };

/** Calls the remove action for forms that carry `intent=remove`, the main action otherwise. */
function byIntent(
  main: (previous: MetadataFormState, formData: FormData) => Promise<MetadataFormState>,
  remove: (previous: MetadataFormState, formData: FormData) => Promise<MetadataFormState>,
) {
  return (previous: MetadataFormState, formData: FormData) =>
    formData.get('intent') === 'remove' ? remove(previous, formData) : main(previous, formData);
}

const addOrRemoveTag = byIntent(addArtifactTagAction, removeArtifactTagAction);
const assignOrUnassignSuite = byIntent(assignArtifactSuiteAction, unassignArtifactSuiteAction);

/** The general error, the field error and the status line under a form. */
function Messages({
  state,
  pending,
  pendingText,
  errorId,
}: {
  state: MetadataFormState;
  pending: boolean;
  pendingText: string;
  errorId: string;
}) {
  return (
    <>
      {state.kind === 'fieldError' && !pending ? (
        <p id={errorId} role="alert" className="text-ui text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'error' && !pending ? (
        <p role="alert" className="text-ui text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      <p role="status" className="text-ui text-muted-foreground empty:hidden">
        {pending ? pendingText : state.kind === 'success' ? state.message : ''}
      </p>
    </>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">{children}</CardContent>
    </Card>
  );
}

export function TagsCard({
  artifactId,
  tags,
  maxTags,
  maxTagLength,
}: {
  artifactId: string;
  tags: string[];
  maxTags: number;
  maxTagLength: number;
}) {
  const [state, dispatch, pending] = useActionState(addOrRemoveTag, idle);
  const field = useRef<HTMLInputElement>(null);
  const full = tags.length >= maxTags;
  const fieldError = state.kind === 'fieldError' && !pending;

  // After an add, a remove or an error the focus is in the field, ready for the next tag.
  useEffect(() => {
    if (state.kind !== 'idle') field.current?.focus();
  }, [state]);

  return (
    <Section title="Tags" description="Your own labels for this artifact. A rescan keeps them.">
      {tags.length ? (
        <ul aria-label="Tags" className="flex flex-wrap gap-inline">
          {tags.map((tag) => (
            <li key={tag} className="flex items-center gap-inline-tight">
              <Badge variant="secondary">{tag}</Badge>
              <form action={dispatch}>
                <input type="hidden" name="intent" value="remove" />
                <input type="hidden" name="artifactId" value={artifactId} />
                <input type="hidden" name="tag" value={tag} />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={`Remove tag ${tag}`}
                >
                  Remove
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-muted-foreground">No tags yet.</p>
      )}
      <form action={dispatch} className="flex flex-wrap items-end gap-inline" noValidate>
        <input type="hidden" name="artifactId" value={artifactId} />
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui text-muted-foreground">
          Tag
          <Input
            ref={field}
            name="tag"
            maxLength={maxTagLength}
            placeholder="security"
            defaultValue={state.kind === 'fieldError' ? state.value : ''}
            disabled={pending || full}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'tag-error' : full ? 'tag-limit' : undefined}
          />
        </label>
        <Button
          type="submit"
          disabled={pending || full}
          aria-describedby={full ? 'tag-limit' : undefined}
        >
          Add tag
        </Button>
      </form>
      {full ? (
        <p id="tag-limit" className="text-ui text-muted-foreground">
          This artifact has {maxTags} tags, the most it can have. Remove one to add another.
        </p>
      ) : null}
      <Messages
        state={state}
        pending={pending}
        pendingText="Saving the tags."
        errorId="tag-error"
      />
    </Section>
  );
}

export function NotesCard({
  artifactId,
  notes,
  maxLength,
}: {
  artifactId: string;
  notes: string | null;
  maxLength: number;
}) {
  const [state, dispatch, pending] = useActionState(saveArtifactNotesAction, idle);
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldError = state.kind === 'fieldError' && !pending;

  useEffect(() => {
    if (state.kind === 'fieldError') field.current?.focus();
  }, [state]);

  return (
    <Section
      title="Notes"
      description="Kept on this machine. A rescan does not change them. Leave empty to clear."
    >
      <form action={dispatch} className="space-y-stack" noValidate>
        <input type="hidden" name="artifactId" value={artifactId} />
        <label className="flex flex-col gap-1 text-ui text-muted-foreground">
          Notes
          <Textarea
            ref={field}
            name="notes"
            maxLength={maxLength}
            placeholder="What to remember about this artifact"
            defaultValue={state.kind === 'fieldError' ? state.value : (notes ?? '')}
            disabled={pending}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'notes-error' : undefined}
          />
        </label>
        <Button type="submit" disabled={pending}>
          Save notes
        </Button>
      </form>
      <Messages
        state={state}
        pending={pending}
        pendingText="Saving the notes."
        errorId="notes-error"
      />
    </Section>
  );
}

export function SuitesCard({
  artifactId,
  assigned,
  available,
}: {
  artifactId: string;
  assigned: Array<{ id: string; name: string }>;
  available: Array<{ id: string; name: string }>;
}) {
  const [state, dispatch, pending] = useActionState(assignOrUnassignSuite, idle);
  const field = useRef<HTMLSelectElement>(null);

  // After an unassign the clicked button is gone: the focus moves to the suite field.
  useEffect(() => {
    if (state.kind !== 'idle') field.current?.focus();
  }, [state]);

  return (
    <Section
      title="Assigned benchmarks"
      description="Suites this artifact is benchmarked with. Run a benchmark from its suite page."
    >
      {assigned.length ? (
        <ul aria-label="Assigned suites" className="space-y-stack text-body">
          {assigned.map((suite) => (
            <li key={suite.id} className="flex flex-wrap items-center gap-inline">
              <Link href={`/benchmarks/${suite.id}`} className="underline">
                {suite.name}
              </Link>
              <form action={dispatch}>
                <input type="hidden" name="intent" value="remove" />
                <input type="hidden" name="artifactId" value={artifactId} />
                <input type="hidden" name="suiteId" value={suite.id} />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={`Unassign suite ${suite.name}`}
                >
                  Unassign
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-muted-foreground">No benchmark suite is assigned.</p>
      )}
      {available.length ? (
        <form action={dispatch} className="flex flex-wrap items-end gap-inline">
          <input type="hidden" name="artifactId" value={artifactId} />
          <label className="flex max-w-full min-w-0 flex-col gap-1 text-ui text-muted-foreground">
            Benchmark suite
            <NativeSelect ref={field} name="suiteId" disabled={pending} className="max-w-full">
              {available.map((suite) => (
                <NativeSelectOption key={suite.id} value={suite.id}>
                  {suite.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <Button type="submit" disabled={pending}>
            Assign
          </Button>
        </form>
      ) : assigned.length ? (
        <p className="text-ui text-muted-foreground">Every benchmark suite is assigned.</p>
      ) : (
        <p className="text-ui text-muted-foreground">
          There are no benchmark suites yet.{' '}
          <Link href="/benchmarks" className="underline">
            Benchmarks
          </Link>{' '}
          says how to import one.
        </p>
      )}
      <Messages
        state={state}
        pending={pending}
        pendingText="Saving the assignment."
        errorId="suite-error"
      />
    </Section>
  );
}

'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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
  assignArtifactCategoryAction,
  assignArtifactSuiteAction,
  removeArtifactTagAction,
  saveArtifactNotesAction,
  unassignArtifactCategoryAction,
  unassignArtifactSuiteAction,
} from '@/lib/actions';
import type { MetadataFormState } from '@/lib/artifact-metadata';
// Types only: `lib/categories.ts` imports core values, which cannot reach the browser bundle.
import type { CategoriesCardModel } from '@/lib/categories';

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
const assignOrUnassignCategory = byIntent(
  assignArtifactCategoryAction,
  unassignArtifactCategoryAction,
);

/**
 * Focuses the card's field, or `fallback()` when the field is gone or disabled (the last suite
 * was assigned, the last free tag slot was taken), so focus never drops to the page body. Focus
 * the user moved outside the card while the save ran stays where it is.
 */
function focusField(
  card: HTMLElement | null,
  field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null,
  fallback: () => HTMLElement | null | undefined = () => null,
): void {
  const active = document.activeElement;
  if (active && active !== document.body && !card?.contains(active)) return;
  if (field && !field.disabled) field.focus();
  else fallback()?.focus();
}

/** The general error, the field error and the status line under a form. */
function Messages({
  state,
  pending,
  pendingText,
  errorId,
  fieldError,
}: {
  state: MetadataFormState;
  pending: boolean;
  pendingText: string;
  errorId: string;
  fieldError: boolean;
}) {
  return (
    <>
      {state.kind === 'fieldError' && fieldError ? (
        <p id={errorId} role="alert" className="text-ui wrap-anywhere text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'error' && !pending ? (
        <p role="alert" className="text-ui text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      <p role="status" className="text-ui wrap-anywhere text-muted-foreground empty:hidden">
        {pending ? pendingText : state.kind === 'success' ? state.message : ''}
      </p>
    </>
  );
}

function Section({
  card,
  title,
  description,
  children,
}: {
  card: RefObject<HTMLDivElement | null>;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card ref={card}>
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
  const added = useRef('');
  const [state, dispatch, pending] = useActionState(
    (previous: MetadataFormState, formData: FormData) => {
      // The tag as the server stores it, to find its row when the field is disabled.
      added.current = String(formData.get('tag') ?? '')
        .trim()
        .toLowerCase();
      return addOrRemoveTag(previous, formData);
    },
    idle,
  );
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const full = tags.length >= maxTags;
  // The error stays until the value changes (Input page, Do and don't).
  const [editedAfter, setEditedAfter] = useState<MetadataFormState | null>(null);
  const fieldError = state.kind === 'fieldError' && !pending && editedAfter !== state;

  // After an add, a remove or an error the focus is in the field, ready for the next tag. At
  // the limit the field is disabled: the focus goes to the Remove button of the newest tag.
  useEffect(() => {
    if (state.kind === 'idle') return;
    focusField(card.current, field.current, () =>
      [...(list.current?.querySelectorAll<HTMLElement>('li[data-tag]') ?? [])]
        .find((item) => item.dataset.tag === added.current)
        ?.querySelector('button'),
    );
  }, [state]);

  return (
    <Section
      card={card}
      title="Tags"
      description="Your own labels for this artifact. A rescan keeps them."
    >
      {tags.length ? (
        <ul ref={list} aria-label="Tags" className="flex flex-wrap gap-inline">
          {tags.map((tag) => (
            <li
              key={tag}
              data-tag={tag}
              className="flex max-w-full min-w-0 items-center gap-inline-tight"
            >
              <Badge variant="secondary" className="min-w-0 shrink break-all">
                {tag}
              </Badge>
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
            onChange={() => setEditedAfter(state)}
            ref={field}
            name="tag"
            maxLength={maxTagLength}
            placeholder="e.g. needs-review"
            defaultValue={state.kind === 'fieldError' ? state.value : ''}
            disabled={pending || full}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={
              fieldError ? 'tag-error tag-hint' : full ? 'tag-limit tag-hint' : 'tag-hint'
            }
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
      <p id="tag-hint" className="text-ui text-muted-foreground">
        One tag at a time, up to {maxTagLength} characters, no commas.
      </p>
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
        fieldError={fieldError}
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
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // The error stays until the value changes (Input page, Do and don't).
  const [editedAfter, setEditedAfter] = useState<MetadataFormState | null>(null);
  const fieldError = state.kind === 'fieldError' && !pending && editedAfter !== state;

  useEffect(() => {
    // The Save button is disabled while saving, which drops its focus: return it to the field.
    if (state.kind !== 'idle') focusField(card.current, field.current);
  }, [state]);

  return (
    <Section
      card={card}
      title="Notes"
      description="Kept on this machine. A rescan does not change them. Leave empty to clear."
    >
      <form action={dispatch} className="space-y-stack" noValidate>
        <input type="hidden" name="artifactId" value={artifactId} />
        <label className="flex flex-col gap-1 text-ui text-muted-foreground">
          Notes
          <Textarea
            onChange={() => setEditedAfter(state)}
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
        fieldError={fieldError}
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
  /** `unassignName` is the Unassign button's accessible name, unique on the page (issue 219). */
  assigned: Array<{ id: string; name: string; unassignName: string }>;
  /** The picker's options; a label adds the suite ID when two suites share a name. */
  available: Array<{ id: string; label: string }>;
}) {
  const submitted = useRef<FormDataEntryValue | null>(null);
  const [state, dispatch, pending] = useActionState(
    (previous: MetadataFormState, formData: FormData) => {
      submitted.current = formData.get('suiteId');
      return assignOrUnassignSuite(previous, formData);
    },
    idle,
  );
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLSelectElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // After an unassign the clicked button is gone: the focus moves to the suite field. After the
  // last free suite is assigned the field is gone: the focus moves to that suite's Unassign.
  useEffect(() => {
    if (state.kind === 'idle') return;
    focusField(card.current, field.current, () =>
      [...(list.current?.querySelectorAll<HTMLElement>('li[data-suite-id]') ?? [])]
        .find((item) => item.dataset.suiteId === submitted.current)
        ?.querySelector('button'),
    );
  }, [state]);

  return (
    <Section
      card={card}
      title="Assigned benchmarks"
      description="Suites this artifact is benchmarked with. Run a benchmark from its suite page."
    >
      {assigned.length ? (
        <ul ref={list} aria-label="Assigned suites" className="space-y-stack text-body">
          {assigned.map((suite) => (
            <li
              key={suite.id}
              data-suite-id={suite.id}
              className="flex flex-wrap items-center gap-inline"
            >
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
                  aria-label={suite.unassignName}
                >
                  Unassign
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-muted-foreground">No benchmark suite is assigned.</p>
      )}
      {available.length ? (
        <form action={dispatch} className="flex flex-wrap items-end gap-inline">
          <input type="hidden" name="artifactId" value={artifactId} />
          <label className="flex max-w-full min-w-0 flex-col gap-1 text-ui text-muted-foreground">
            Benchmark suite
            <NativeSelect ref={field} name="suiteId" disabled={pending} className="max-w-full">
              {available.map((suite) => (
                <NativeSelectOption key={suite.id} value={suite.id}>
                  {suite.label}
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
        fieldError={false}
      />
    </Section>
  );
}

/** The "Categories page" link of the sentences that replace the picker (SPEC-124 D21, D22). */
const categoriesPageLink = (ref: RefObject<HTMLAnchorElement | null>) => (
  <Link ref={ref} href="/categories" className="text-primary-text underline">
    Categories page
  </Link>
);

/**
 * The artifact page's Categories card (SPEC-124 §11, §11.3): the assigned categories as chips
 * with a Remove each, archived ones included, and a picker of the active categories not yet
 * assigned. The chip labels and which sentence replaces the picker come from the server
 * (`categoriesCardModel`), so this file imports no values from core.
 */
export function CategoriesCard({
  artifactId,
  model,
}: {
  artifactId: string;
  model: CategoriesCardModel;
}) {
  const { chips, available, noPicker } = model;
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLSelectElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  // What the last submit did, for the focus map (D25): the category and, for a remove, the
  // place its chip had in the list.
  const submitted = useRef<{ categoryId: FormDataEntryValue | null; removedAt: number | null }>({
    categoryId: null,
    removedAt: null,
  });
  // Which button was pressed, for the pending line ("Assigning…" or "Removing…", D24).
  const [pressed, setPressed] = useState<'assign' | 'remove'>('assign');
  const [state, dispatch, pending] = useActionState(
    (previous: MetadataFormState, formData: FormData) => {
      const categoryId = formData.get('categoryId');
      const items = [
        ...(list.current?.querySelectorAll<HTMLElement>('li[data-category-id]') ?? []),
      ];
      const index = items.findIndex((item) => item.dataset.categoryId === categoryId);
      submitted.current = {
        categoryId,
        removedAt: formData.get('intent') === 'remove' && index >= 0 ? index : null,
      };
      return assignOrUnassignCategory(previous, formData);
    },
    idle,
  );

  // D25: after an assign or a remove the focus is in the select. Without a picker it goes to the
  // assigned chip's Remove, or the Remove that took the removed chip's place, else the last
  // chip's Remove, else the "Categories page" link.
  useEffect(() => {
    if (state.kind === 'idle') return;
    focusField(card.current, field.current, () => {
      const buttons = [
        ...(list.current?.querySelectorAll<HTMLElement>('li[data-category-id]') ?? []),
      ].map((item) => ({ id: item.dataset.categoryId, button: item.querySelector('button') }));
      const { categoryId, removedAt } = submitted.current;
      const target =
        (removedAt === null
          ? buttons.find((item) => item.id === categoryId)
          : buttons[removedAt]) ?? buttons.at(-1);
      return target?.button ?? link.current;
    });
  }, [state]);

  return (
    <Section
      card={card}
      title="Categories"
      description="Groups for filtering the Artifacts list. A rescan keeps them."
    >
      {chips.length ? (
        <ul ref={list} aria-label="Categories" className="flex flex-wrap gap-inline">
          {/* Active categories first, then archived ones, muted (FR-124-14). */}
          {chips.map((chip) => (
            <li
              key={chip.id}
              data-category-id={chip.id}
              className="flex max-w-full min-w-0 items-center gap-inline-tight"
            >
              <Badge
                variant={chip.archived ? 'muted' : 'secondary'}
                className="min-w-0 shrink break-all"
              >
                {chip.label}
              </Badge>
              <form action={dispatch} onSubmit={() => setPressed('remove')}>
                <input type="hidden" name="intent" value="remove" />
                <input type="hidden" name="artifactId" value={artifactId} />
                <input type="hidden" name="categoryId" value={chip.id} />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={chip.removeName}
                >
                  Remove
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-muted-foreground">No categories yet.</p>
      )}
      {noPicker === null ? (
        <form
          action={dispatch}
          onSubmit={() => setPressed('assign')}
          className="flex flex-wrap items-end gap-inline"
        >
          <input type="hidden" name="artifactId" value={artifactId} />
          <label className="flex max-w-full min-w-0 flex-col gap-1 text-ui text-muted-foreground">
            Category
            <NativeSelect ref={field} name="categoryId" disabled={pending} className="max-w-full">
              {available.map((category) => (
                <NativeSelectOption key={category.id} value={category.id}>
                  {category.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <Button type="submit" disabled={pending}>
            Assign
          </Button>
        </form>
      ) : noPicker === 'all-assigned' ? (
        <p className="text-ui text-muted-foreground">
          Every active category is assigned. Create more on the {categoriesPageLink(link)}.
        </p>
      ) : (
        <p className="text-ui text-muted-foreground">
          There are no active categories. Create or unarchive one on the {categoriesPageLink(link)}.
        </p>
      )}
      <Messages
        state={state}
        pending={pending}
        pendingText={pressed === 'assign' ? 'Assigning…' : 'Removing…'}
        errorId="category-error"
        fieldError={false}
      />
    </Section>
  );
}

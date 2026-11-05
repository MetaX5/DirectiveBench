'use client';

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { Input } from '@/components/ui/input';
import {
  createCategoryAction,
  setCategoryArchivedAction,
  updateCategoryAction,
} from '@/lib/actions';
import type { CategoryField, CategoryFormState } from '@/lib/categories';

// Forms of the Categories page and a category's page (SPEC-124 §11, §11.2), built on the Form
// pattern: visible labels, the field error, the general error and a role="status" line under
// the form row (D13), both entered values kept after an error (D14), and focus kept in the card.
// Limits and counted copy come from the server page as props: this client module must not import
// `@directivebench/core` (Node built-ins).

/** The longest name and description, in UTF-16 code units (SPEC-124 FR-124-03). */
export interface CategoryLimits {
  name: number;
  description: number;
}

const idle: CategoryFormState = { kind: 'idle' };

/**
 * Focuses `target` when the focus is still inside the card or on the page body, so focus the
 * user moved elsewhere while the save ran stays where it is (as on the artifact page).
 */
function focusInCard(card: HTMLElement | null, target: HTMLElement | null): void {
  const active = document.activeElement;
  if (active && active !== document.body && !card?.contains(active)) return;
  target?.focus();
}

/** The field error, the general error and the status line under a form (D13). */
function Messages({
  state,
  pending,
  pendingText,
  errorId,
  fieldError,
}: {
  state: CategoryFormState;
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
        <p role="alert" className="text-ui wrap-anywhere text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      <p role="status" className="text-ui wrap-anywhere text-muted-foreground empty:hidden">
        {pending ? pendingText : state.kind === 'success' ? state.message : ''}
      </p>
    </>
  );
}

/**
 * The Name and "Description (optional)" fields and the submit button in one wrapping row (D1,
 * D9), with the messages under it. `saved` is what the fields show when there is no error.
 */
function NameDescriptionForm({
  action,
  submitLabel,
  pendingText,
  saved,
  limits,
  hidden,
}: {
  action: (previous: CategoryFormState, formData: FormData) => Promise<CategoryFormState>;
  submitLabel: string;
  pendingText: string;
  saved: { name: string; description: string };
  limits: CategoryLimits;
  hidden?: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, idle);
  const id = useId();
  const errorId = `${id}-error`;
  const form = useRef<HTMLFormElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const descriptionField = useRef<HTMLInputElement>(null);
  // The error stays until the value changes (Input page, Do and don't).
  const [editedAfter, setEditedAfter] = useState<CategoryFormState | null>(null);
  const errorField =
    state.kind === 'fieldError' && !pending && editedAfter !== state ? state.field : null;

  // After a save the focus goes back to the field with the error, or to Name (§11.2 focus map).
  useEffect(() => {
    if (state.kind === 'idle') return;
    const target =
      state.kind === 'fieldError' && state.field === 'description' ? descriptionField : nameField;
    focusInCard(form.current?.closest('[data-slot="card"]') ?? null, target.current);
  }, [state]);

  const values = state.kind === 'fieldError' ? state.values : saved;
  function field(name: CategoryField) {
    return {
      name,
      onChange: () => setEditedAfter(state),
      defaultValue: values[name],
      disabled: pending,
      'aria-invalid': errorField === name ? true : undefined,
      'aria-describedby': errorField === name ? errorId : undefined,
    };
  }

  return (
    <>
      <form ref={form} action={dispatch} className="flex flex-wrap items-end gap-inline" noValidate>
        {hidden}
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui text-muted-foreground">
          Name
          <Input ref={nameField} {...field('name')} maxLength={limits.name} />
        </label>
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-ui text-muted-foreground">
          Description (optional)
          <Input ref={descriptionField} {...field('description')} maxLength={limits.description} />
        </label>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </form>
      <Messages
        state={state}
        pending={pending}
        pendingText={pendingText}
        errorId={errorId}
        fieldError={errorField !== null}
      />
    </>
  );
}

/** The "New category" card on `/categories` (§11, D1). */
export function NewCategoryCard({ limits }: { limits: CategoryLimits }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New category</CardTitle>
        <CardDescription>The link (slug) comes from the name and never changes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        <NameDescriptionForm
          action={createCategoryAction}
          submitLabel="Create"
          pendingText="Creating…"
          saved={{ name: '', description: '' }}
          limits={limits}
        />
      </CardContent>
    </Card>
  );
}

/** The "Details" card of a category's page: rename and describe (§11, D9). */
export function CategoryDetailsCard({
  id,
  slug,
  name,
  description,
  limits,
}: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  limits: CategoryLimits;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>
          The slug stays <code className="font-mono wrap-anywhere">{slug}</code>, so links and
          benchmark definitions keep working.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        <NameDescriptionForm
          action={updateCategoryAction}
          submitLabel="Save"
          pendingText="Saving…"
          saved={{ name, description: description ?? '' }}
          limits={limits}
          hidden={<input type="hidden" name="id" value={id} />}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The "Status" card of a category's page (§11, D10, D11): Archive opens an inline Risky-action
 * panel with the artifact count (UD-5) and only its confirming button archives; Unarchive needs
 * no confirmation.
 */
export function CategoryStatusCard({
  id,
  name,
  archived,
  statusText,
  archiveReason,
}: {
  id: string;
  name: string;
  archived: boolean;
  /** The Status card's sentence: what archiving does, or where an archived category stays. */
  statusText: string;
  /** The Archive panel's reason, with the artifact count (UD-5). */
  archiveReason: string;
}) {
  const [state, dispatch, pending] = useActionState(setCategoryArchivedAction, idle);
  // The panel is open for the result it was opened after, so any new result closes it.
  const [openedAt, setOpenedAt] = useState<CategoryFormState | null>(null);
  const open = openedAt === state;
  const panelId = useId();
  const card = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLParagraphElement>(null);

  // A result closes the panel; the focus goes to the button that is there now: Unarchive after
  // an archive, Archive after an unarchive, the same button after a refusal (§11.2 focus map).
  useEffect(() => {
    if (state.kind !== 'idle') focusInCard(card.current, toggle.current);
  }, [state]);

  // Opening the panel moves the focus to its question (UD-5).
  useEffect(() => {
    if (open) question.current?.focus();
  }, [open]);

  function cancel() {
    setOpenedAt(null);
    toggle.current?.focus();
  }

  return (
    <Card ref={card}>
      <CardHeader>
        <CardTitle>Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-stack text-body">
        {archived ? (
          <>
            <p>{statusText}</p>
            <form action={dispatch}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="intent" value="unarchive" />
              <Button ref={toggle} type="submit" variant="outline" disabled={pending}>
                Unarchive
              </Button>
            </form>
          </>
        ) : (
          <>
            <p>{statusText}</p>
            <Button
              ref={toggle}
              type="button"
              variant="outline"
              disabled={pending}
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              onClick={() => setOpenedAt(open ? null : state)}
            >
              Archive
            </Button>
            {open ? (
              <div
                id={panelId}
                role="alert"
                className="min-w-0 space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui"
              >
                <p ref={question} tabIndex={-1} className="font-medium wrap-anywhere outline-none">
                  Archive {name}?
                </p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>{archiveReason}</li>
                </ul>
                <form action={dispatch} className="flex flex-wrap items-center gap-inline">
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="intent" value="archive" />
                  <Button
                    type="submit"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    className="max-w-full"
                  >
                    <span className="truncate">Archive {name}</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    disabled={pending}
                    className="underline"
                    onClick={cancel}
                  >
                    Cancel
                  </Button>
                </form>
              </div>
            ) : null}
          </>
        )}
        <Messages
          state={state}
          pending={pending}
          // While saving, the page still shows the state before the submit.
          pendingText={archived ? 'Unarchiving…' : 'Archiving…'}
          errorId={`${panelId}-error`}
          fieldError={false}
        />
      </CardContent>
    </Card>
  );
}

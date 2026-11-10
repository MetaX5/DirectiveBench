'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { setCategoryForListedArtifactsAction } from '@/lib/actions';
// Types only: `lib/categories.ts` imports core values, which cannot reach the browser bundle
// (lesson 2026-11-05). The counts, labels and fingerprint come from the server page as props.
import type { BulkCategoryFormState, BulkCategoryModel } from '@/lib/categories';

// The bulk row of the Artifacts list (SPEC-124 FR-124-13, §11.4 D27 to D37): one select of active
// categories and two buttons that open an inline Risky-action panel (UD-5); only the panel's
// confirming button posts. The row acts on the applied (URL) filters, which the server recomputes
// and checks against the posted fingerprint. The component always renders, so the result line of
// the last submit survives a list that became empty (D37).

type Mode = 'assign' | 'remove';

const idle: BulkCategoryFormState = { kind: 'idle' };

/** The panel as it was opened: the mode and the category captured then (D32). */
interface Panel {
  mode: Mode;
  categoryId: string;
  name: string;
  /** The result the panel was opened after: any new result closes it (D36). */
  at: BulkCategoryFormState;
}

/** The general error and the status line under the row (D13, D34). */
function Messages({
  state,
  pending,
  pendingText,
}: {
  state: BulkCategoryFormState;
  pending: boolean;
  pendingText: string;
}) {
  return (
    <>
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

export function BulkCategoryForm({ model }: { model: BulkCategoryModel }) {
  const { state: rowState, categories, label, phrase, tooManyText, fields, noFilter } = model;
  const [state, dispatch, pending] = useActionState(setCategoryForListedArtifactsAction, idle);
  const [panel, setPanel] = useState<Panel | null>(null);
  const open = panel !== null && panel.at === state ? panel : null;
  // Which mode was confirmed, for the pending line ("Assigning…" or "Removing…").
  const [confirmed, setConfirmed] = useState<Mode>('assign');
  // The chosen category: a controlled select, so a form reset after an action cannot change it;
  // after a submit it is the submitted category while that is still active (D30).
  const [selected, setSelected] = useState(categories[0]?.id ?? '');
  const [appliedResult, setAppliedResult] = useState<BulkCategoryFormState>(idle);
  if (state !== appliedResult) {
    setAppliedResult(state);
    if (state.kind !== 'idle') setSelected(state.categoryId);
  }
  const value = categories.some((c) => c.id === selected) ? selected : (categories[0]?.id ?? '');

  const panelId = useId();
  const area = useRef<HTMLDivElement>(null);
  const question = useRef<HTMLParagraphElement>(null);
  const assignButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  /** The button that opened the panel last: Cancel and every result return the focus to it. */
  const opener = useRef<Mode>('assign');
  const buttonOf = (mode: Mode) => (mode === 'assign' ? assignButton : removeButton).current;

  /** Moves the focus only while it is still in the bulk area or on the page body (D35). */
  function focusInArea(target: HTMLElement | null | undefined): void {
    const active = document.activeElement;
    if (active && active !== document.body && !area.current?.contains(active)) return;
    target?.focus();
  }

  // Opening the panel, or switching it to the other mode, focuses its question (D35).
  const openMode = open?.mode;
  useEffect(() => {
    if (openMode) question.current?.focus();
  }, [openMode]);

  // Any result focuses the button that opened the panel, or the filter form's Search field when
  // the bulk row is gone (the list became empty, D35, D37).
  useEffect(() => {
    if (state.kind === 'idle') return;
    focusInArea(
      buttonOf(opener.current) ??
        document.querySelector<HTMLInputElement>('form[role="search"] input[name="q"]'),
    );
  }, [state]);

  function toggle(mode: Mode): void {
    if (open?.mode === mode) {
      setPanel(null);
      buttonOf(mode)?.focus();
      return;
    }
    const category = categories.find((c) => c.id === value);
    if (!category) return;
    opener.current = mode;
    setPanel({ mode, categoryId: category.id, name: category.name, at: state });
  }

  function cancel(): void {
    setPanel(null);
    buttonOf(opener.current)?.focus();
  }

  const showsSomething = rowState !== 'empty' || state.kind !== 'idle' || pending;

  return (
    <div
      ref={area}
      data-testid="bulk-category"
      className={showsSomething ? 'mb-4 space-y-stack border-t pt-4' : undefined}
    >
      {rowState === 'ready' ? (
        <form action={dispatch} className="flex flex-wrap items-end gap-inline">
          <label className="flex max-w-full min-w-0 flex-col gap-1 text-ui text-muted-foreground">
            {label}
            <NativeSelect
              name="categoryId"
              value={value}
              disabled={pending}
              className="max-w-full"
              onChange={(event) => {
                setSelected(event.target.value);
                // Changing the category closes an open panel; the focus stays on the select.
                setPanel(null);
              }}
            >
              {categories.map((category) => (
                <NativeSelectOption key={category.id} value={category.id}>
                  {category.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <Button
            ref={assignButton}
            type="button"
            variant="outline"
            disabled={pending}
            aria-expanded={open?.mode === 'assign'}
            aria-controls={open?.mode === 'assign' ? panelId : undefined}
            onClick={() => toggle('assign')}
          >
            Assign to all listed
          </Button>
          <Button
            ref={removeButton}
            type="button"
            variant="outline"
            disabled={pending}
            aria-expanded={open?.mode === 'remove'}
            aria-controls={open?.mode === 'remove' ? panelId : undefined}
            onClick={() => toggle('remove')}
          >
            Remove from all listed
          </Button>
        </form>
      ) : rowState === 'invalid-url' ? (
        <p className="text-ui text-muted-foreground">
          Fix or clear the filters in the URL before changing categories for the whole list.
        </p>
      ) : rowState === 'too-many' ? (
        <p className="text-ui text-muted-foreground">{tooManyText}</p>
      ) : rowState === 'none-active' ? (
        <p className="text-ui text-muted-foreground">
          There are no active categories. Create or unarchive one on the{' '}
          <Link href="/categories" className="text-primary-text underline">
            Categories page
          </Link>
          .
        </p>
      ) : null}
      {open && rowState === 'ready' ? (
        <div
          id={panelId}
          role="alert"
          className="min-w-0 space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui"
        >
          <p ref={question} tabIndex={-1} className="font-medium wrap-anywhere outline-none">
            {open.mode === 'assign'
              ? `Assign ${open.name} to ${phrase}?`
              : `Remove ${open.name} from ${phrase}?`}
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              This changes every artifact that matches the current filters, not only the rows on
              screen.
            </li>
            {noFilter ? (
              <li>No filter is set, so this is every artifact in the registry.</li>
            ) : null}
          </ul>
          <form
            action={dispatch}
            onSubmit={() => setConfirmed(open.mode)}
            className="flex flex-wrap items-center gap-inline"
          >
            <input type="hidden" name="categoryId" value={open.categoryId} />
            <input type="hidden" name="mode" value={open.mode} />
            {fields.map((field) => (
              <input key={field.name} type="hidden" name={field.name} value={field.value} />
            ))}
            <input type="hidden" name="listFingerprint" value={model.listFingerprint} />
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={pending}
              className="max-w-full"
            >
              {open.mode === 'assign' ? `Assign to ${phrase}` : `Remove from ${phrase}`}
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
      <Messages
        state={state}
        pending={pending}
        pendingText={confirmed === 'assign' ? 'Assigning…' : 'Removing…'}
      />
    </div>
  );
}

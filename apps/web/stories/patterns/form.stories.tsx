import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { expect, fn, userEvent, waitFor } from 'storybook/test';
import { PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// Pattern: a form, modelled on "Register a repository" (/repositories). The app submits with a
// server action and re-renders; here the submit states come through props.

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'fieldError'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'success'; message: string };

function RegisterForm({
  state,
  value,
  onSubmit,
}: {
  state: SubmitState;
  value?: string;
  onSubmit?: (path: string) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const pending = state.kind === 'pending';
  const fieldError = state.kind === 'fieldError' ? state.message : null;

  // Focus moves to the first field with an error after a submit.
  useEffect(() => {
    if (state.kind === 'fieldError') field.current?.focus();
  }, [state.kind]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    onSubmit?.(new FormData(event.currentTarget).get('path') as string);
  };

  return (
    <div className="max-w-content">
      <PageHeader
        title="Repositories"
        description="Sources DirectiveBench reads skills, instructions and rules from."
      />
      <Card>
        <CardHeader>
          <CardTitle>Register a repository</CardTitle>
          <CardDescription>
            Enter a local path or the URL of a public GitHub repository. DirectiveBench never writes
            to it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-stack">
          {state.kind === 'error' ? (
            <p role="alert" className="text-ui text-destructive-foreground">
              {state.message}
            </p>
          ) : null}
          <form onSubmit={submit} className="flex flex-wrap items-end gap-inline" noValidate>
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-ui text-muted-foreground">
              Path or GitHub URL
              <Input
                ref={field}
                name="path"
                required
                defaultValue={value}
                placeholder="~/code/my-skills or https://github.com/owner/repo"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'path-error' : undefined}
                disabled={pending}
                className="font-mono"
              />
            </label>
            <Button type="submit" disabled={pending}>
              Register
            </Button>
          </form>
          {fieldError ? (
            <p id="path-error" role="alert" className="text-ui text-destructive-foreground">
              {fieldError}
            </p>
          ) : null}
          {pending ? (
            <p role="status" className="text-ui text-muted-foreground">
              Checking the path. This takes a few seconds for a GitHub URL.
            </p>
          ) : null}
          {state.kind === 'success' ? (
            <p role="status" className="text-ui text-success-foreground">
              {state.message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

const meta = {
  title: 'Patterns/Form',
  component: RegisterForm,
  parameters: { layout: 'padded' },
  args: { state: { kind: 'idle' }, onSubmit: fn() },
} satisfies Meta<typeof RegisterForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ready: a visible label, an example as placeholder, one main action. */
export const Idle: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('textbox', { name: 'Path or GitHub URL' })).toBeVisible();
  },
};

/** Submitting: the field and the button are disabled and a status message says why. */
export const Pending: Story = {
  args: { state: { kind: 'pending' }, value: 'https://github.com/acme/agent-rules' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Register' })).toBeDisabled();
    await expect(canvas.getByRole('status')).toHaveTextContent('Checking the path');
  },
};

/** A field error: next to the field, linked to it, announced, focused; the value is kept. */
export const FieldError: Story = {
  args: {
    state: {
      kind: 'fieldError',
      message:
        'The filesystem root cannot be registered. Choose the folder that holds your skills.',
    },
    value: '/',
  },
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Path or GitHub URL' });
    await waitFor(() => expect(field).toHaveFocus());
    await expect(field).toBeInvalid();
    await expect(field).toHaveValue('/');
    await expect(field).toHaveAccessibleDescription(/filesystem root/);
  },
};

/** An error that is not about one field: above the form, with what to do next. */
export const GeneralError: Story = {
  args: {
    state: {
      kind: 'error',
      message:
        'The repository could not be registered: the local database is busy. Wait for the running scan to finish and try again.',
    },
    value: '~/code/agent-rules',
  },
};

/** Success: a status message names what happened and what happens next. */
export const Success: Story = {
  args: {
    state: {
      kind: 'success',
      message: 'Registered acme/agent-rules. The first scan has started.',
    },
  },
};

/** A second press while the first submit runs does nothing. */
export const BlocksDoubleSubmit: Story = {
  render: function Render(args) {
    const [state, setState] = useState<SubmitState>({ kind: 'idle' });
    return (
      <RegisterForm
        {...args}
        state={state}
        onSubmit={(path) => {
          args.onSubmit?.(path);
          setState({ kind: 'pending' });
        }}
      />
    );
  },
  play: async ({ args, canvas }) => {
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Path or GitHub URL' }),
      '~/code/agent-rules',
    );
    const button = canvas.getByRole('button', { name: 'Register' });
    await userEvent.click(button);
    await userEvent.click(button, { pointerEventsCheck: 0 });
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('~/code/agent-rules');
  },
};

/** A list edited in place: per-item Remove, one add field, one result line, focus kept. */
function TagList({ initial }: { initial: string[] }) {
  const [tags, setTags] = useState(initial);
  const [message, setMessage] = useState('');
  const field = useRef<HTMLInputElement>(null);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const tag = String(new FormData(form).get('tag')).trim().toLowerCase();
    if (!tag) return;
    if (tags.includes(tag)) setMessage(`${tag} is already a tag.`);
    else {
      setTags([...tags, tag]);
      setMessage(`Added tag ${tag}.`);
    }
    form.reset();
    field.current?.focus();
  };

  const remove = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
    setMessage(`Removed tag ${tag}.`);
    field.current?.focus();
  };

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>Your own labels for this artifact. A rescan keeps them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        {tags.length ? (
          <ul aria-label="Tags" className="flex flex-wrap gap-inline">
            {tags.map((tag) => (
              <li key={tag} className="flex items-center gap-inline-tight">
                <Badge variant="secondary">{tag}</Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => remove(tag)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui text-muted-foreground">No tags yet.</p>
        )}
        <form onSubmit={add} className="flex flex-wrap items-end gap-inline" noValidate>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui text-muted-foreground">
            Tag
            <Input ref={field} name="tag" maxLength={64} placeholder="security" />
          </label>
          <Button type="submit">Add tag</Button>
        </form>
        <p role="status" className="text-ui text-muted-foreground">
          {message}
        </p>
      </CardContent>
    </Card>
  );
}

export const EditableList: Story = {
  render: () => <TagList initial={['security', 'review']} />,
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Tag' });
    await userEvent.type(field, '  Testing {Enter}');
    await expect(canvas.getByRole('status')).toHaveTextContent('Added tag testing.');
    await expect(field).toHaveValue('');
    await expect(field).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove tag security' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Removed tag security.');
    await expect(field).toHaveFocus();
  },
};

/**
 * An optional field next to the main one, modelled on "Branch (optional)" of "Register a
 * repository" (issue 58): no placeholder (an example name could read as the default), a help line
 * that says what empty means, and its errors directly under it, linked by `aria-describedby`.
 */
const BRANCH_RULE =
  'A branch name may use letters, digits, ".", "_", "-" and "/". It cannot start with "-" or ".", contain ".." or a space, or end with ".lock".';

function OptionalField({
  state,
  path,
  branch,
}: {
  state: 'idle' | 'pending' | 'invalid' | 'notFound';
  path?: string;
  branch?: string;
}) {
  const pending = state === 'pending';
  const error =
    state === 'invalid'
      ? BRANCH_RULE
      : state === 'notFound'
        ? `The branch ${branch} does not exist in acme/agent-skills. Check the name on GitHub, or leave Branch empty to use the default branch.`
        : null;
  return (
    <Card className="max-w-content">
      <CardHeader>
        <CardTitle>Register a repository</CardTitle>
        <CardDescription>
          A GitHub repository is scanned on its default branch unless you name another branch. A
          local repository is scanned from its working tree.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        <form
          className="flex flex-wrap items-start gap-inline"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-ui text-muted-foreground">
            Path or GitHub URL
            <Input
              name="path"
              defaultValue={path}
              placeholder="~/code/my-skills or https://github.com/owner/repo"
              disabled={pending}
              className="font-mono"
            />
          </label>
          <div className="flex w-full min-w-0 flex-col gap-1 sm:w-56">
            <label className="flex flex-col gap-1 text-ui text-muted-foreground">
              Branch (optional)
              <Input
                name="branch"
                defaultValue={branch}
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error ? 'story-branch-error story-branch-help' : 'story-branch-help'
                }
                autoFocus={error !== null}
                disabled={pending}
                className="font-mono"
              />
            </label>
            {error ? (
              <p
                id="story-branch-error"
                role="alert"
                className="text-ui text-destructive-foreground wrap-anywhere"
              >
                {error}
              </p>
            ) : null}
            <p id="story-branch-help" className="text-caption text-muted-foreground">
              GitHub only. Empty: the default branch.
            </p>
          </div>
          <Button type="submit" disabled={pending} className="mt-5">
            Register
          </Button>
        </form>
        {pending ? (
          <p role="status" className="text-ui wrap-anywhere">
            Asking GitHub about {path} and its branch {branch} (read-only, without credentials;
            nothing is downloaded yet)…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** An optional field: a visible "(optional)" label, no placeholder, a help line for empty. */
export const OptionalFieldIdle: Story = {
  render: () => <OptionalField state="idle" />,
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Branch (optional)' });
    await expect(field).not.toHaveAttribute('placeholder');
    await expect(field).toHaveAccessibleDescription('GitHub only. Empty: the default branch.');
  },
};

/** The optional field's error sits directly under it, not under the button row. */
export const OptionalFieldError: Story = {
  render: () => (
    <OptionalField
      state="invalid"
      path="https://github.com/acme/agent-skills"
      branch="-upload-pack=x"
    />
  ),
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Branch (optional)' });
    await waitFor(() => expect(field).toHaveFocus());
    await expect(field).toBeInvalid();
    await expect(field).toHaveValue('-upload-pack=x');
    await expect(field).toHaveAccessibleDescription(
      `${BRANCH_RULE} GitHub only. Empty: the default branch.`,
    );
  },
};

/** A runner answer about the optional field also goes under it, with both values kept. */
export const OptionalFieldNotFound: Story = {
  render: () => (
    <OptionalField state="notFound" path="https://github.com/acme/agent-skills" branch="relase" />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('The branch relase does not exist');
    await expect(canvas.getByRole('textbox', { name: 'Branch (optional)' })).toHaveValue('relase');
  },
};

/** While the runner asks, both fields keep their values and are disabled. */
export const OptionalFieldPending: Story = {
  render: () => (
    <OptionalField state="pending" path="https://github.com/acme/agent-skills" branch="relase" />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('textbox', { name: 'Branch (optional)' })).toBeDisabled();
    await expect(canvas.getByRole('status')).toHaveTextContent('and its branch relase');
  },
};

/**
 * An edit panel above a table, modelled on Change branch on `/repositories` (issue 58): opened from
 * a row, the field focused, one `default` Save button and a Cancel link, the error under the
 * field, and a note that says what saving does and does not do.
 */
function EditPanel({ state, value }: { state: 'open' | 'invalid' | 'notFound'; value: string }) {
  const error =
    state === 'invalid'
      ? BRANCH_RULE
      : state === 'notFound'
        ? `The branch ${value} does not exist in acme/team-rules. Nothing was changed: the repository still uses release/2.0.`
        : null;
  return (
    <div className="min-w-0 max-w-content space-y-stack rounded-surface border border-control p-3 text-ui">
      <p className="font-medium wrap-anywhere">
        Branch of acme/team-rules (GitHub,{' '}
        <span className="font-mono">https://github.com/acme/team-rules</span>)
      </p>
      <form
        className="flex flex-wrap items-start gap-inline"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-80">
          <label className="flex flex-col gap-1 text-ui text-muted-foreground">
            Branch
            <Input
              name="branch"
              defaultValue={value}
              aria-invalid={error ? true : undefined}
              aria-describedby={
                error
                  ? 'story-change-branch-error story-change-branch-help'
                  : 'story-change-branch-help'
              }
              autoFocus
              className="font-mono"
            />
          </label>
          {error ? (
            <p
              id="story-change-branch-error"
              role="alert"
              className="text-destructive-foreground wrap-anywhere"
            >
              {error}
            </p>
          ) : null}
          <p id="story-change-branch-help" className="text-caption text-muted-foreground">
            Leave empty to follow the default branch (main).
          </p>
        </div>
        <div className="mt-5 flex items-center gap-inline">
          <Button type="submit">Save branch</Button>
          <a href="#change-branch-b" className="text-ui underline">
            Cancel
          </a>
        </div>
      </form>
      <p className="text-muted-foreground">
        Saving does not scan. The next scan reads the new branch: artifacts found only on
        release/2.0 are then marked missing (their history is kept) and return when a later scan
        finds them again.
      </p>
    </div>
  );
}

/** Opening the panel puts focus in its field. */
export const EditPanelOpen: Story = {
  render: () => <EditPanel state="open" value="release/2.0" />,
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Branch' })).toHaveFocus());
  },
};

/** An invalid value: the error under the field, the value kept. */
export const EditPanelError: Story = {
  render: () => <EditPanel state="invalid" value="release 2.0" />,
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Branch' });
    await expect(field).toBeInvalid();
    await expect(field).toHaveAccessibleDescription(
      `${BRANCH_RULE} Leave empty to follow the default branch (main).`,
    );
  },
};

/** The runner's "does not exist": under the field too, saying that nothing changed. */
export const EditPanelNotFound: Story = {
  render: () => <EditPanel state="notFound" value="release/3.0" />,
};

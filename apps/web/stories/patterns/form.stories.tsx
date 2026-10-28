import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { expect, fn, userEvent, waitFor } from 'storybook/test';
import { PageHeader } from '@/components/common';
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

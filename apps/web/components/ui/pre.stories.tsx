import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Pre } from './primitives';

const definition = {
  id: 'validate-external-input',
  execution: { agent: 'mock', repetitions: 3, environment: { kind: 'local-process' } },
  cases: [{ id: 'reject-unknown-fields', prompt: 'Add input validation to the user endpoint.' }],
};

const meta = {
  title: 'Primitives/Pre',
  component: Pre,
  parameters: { layout: 'padded' },
  args: { children: JSON.stringify(definition, null, 2) },
} satisfies Meta<typeof Pre>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvasElement }) => {
    const pre = canvasElement.querySelector('pre')!;
    await expect(getComputedStyle(pre).whiteSpace).toBe('pre-wrap');
  },
};

/** Long output scrolls inside the block after 28rem; the page does not grow without limit. */
export const LongOutput: Story = {
  args: {
    children: Array.from(
      { length: 60 },
      (_, i) => `[agent-run ${i + 1}] assertion basic-tests: passed (exit 0, 412 ms)`,
    ).join('\n'),
  },
  play: async ({ canvasElement }) => {
    const pre = canvasElement.querySelector('pre')!;
    await expect(pre.scrollHeight).toBeGreaterThan(pre.clientHeight);
    // A tab stop, so the keyboard can scroll it (SPEC-122 P13).
    await expect(pre.tabIndex).toBe(0);
  },
};

/** Long lines wrap and break inside words, also at 320px. */
export const LongLinesNarrowScreen: Story = {
  args: {
    children:
      'Error: ENOENT: no such file or directory, open /home/dev/code/acme-engineering/agent-rules/.claude/skills/validate-external-input/fixtures/expected-output.json',
  },
  render: (args) => (
    <div className="w-80">
      <Pre {...args} />
    </div>
  ),
};

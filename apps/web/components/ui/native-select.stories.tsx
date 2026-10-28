import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent } from 'storybook/test';
import { StateMatrix, stateProps } from '../../stories/blocks/state-matrix';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './native-select';

const types = ['skill', 'instruction', 'rule', 'agent', 'command'];

const meta = {
  title: 'Primitives/NativeSelect',
  component: NativeSelect,
  parameters: { layout: 'padded' },
  args: { name: 'type', defaultValue: '' },
  render: (args) => (
    <label className="flex w-fit flex-col gap-1 text-ui text-muted-foreground">
      Type
      <NativeSelect {...args}>
        <NativeSelectOption value="">All</NativeSelectOption>
        {types.map((type) => (
          <NativeSelectOption key={type} value={type}>
            {type}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  ),
} satisfies Meta<typeof NativeSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    const select = canvas.getByRole('combobox', { name: 'Type' });
    await userEvent.selectOptions(select, 'rule');
    await expect(select).toHaveValue('rule');
    await expect(select.getBoundingClientRect().height).toBe(32);
  },
};

/** Every state. Focus is frozen; dark theme adds a hover fill. */
export const States: Story = {
  render: () => (
    <StateMatrix
      label="NativeSelect states"
      variants={['default'] as const}
      states={['rest', 'hover', 'focus', 'disabled', 'invalid']}
      render={(_, state) => (
        <NativeSelect aria-label={`Type, ${state}`} defaultValue="" {...stateProps(state)}>
          <NativeSelectOption value="">All</NativeSelectOption>
          <NativeSelectOption value="skill">skill</NativeSelectOption>
        </NativeSelect>
      )}
    />
  ),
};

/** Option groups exist in the preset; no page uses them yet (P3). */
export const WithGroups: Story = {
  render: () => (
    <label className="flex w-fit flex-col gap-1 text-ui text-muted-foreground">
      Category
      <NativeSelect defaultValue="">
        <NativeSelectOption value="">All</NativeSelectOption>
        <NativeSelectOptGroup label="Quality">
          <NativeSelectOption value="security">security</NativeSelectOption>
          <NativeSelectOption value="testing">testing</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="Workflow">
          <NativeSelectOption value="git">git</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </label>
  ),
};

/** The select is as wide as its longest option; a long option widens it. */
export const LongOptionsNarrowScreen: Story = {
  render: () => (
    <label className="flex w-80 flex-col gap-1 text-ui text-muted-foreground">
      Repository
      <NativeSelect defaultValue="" className="w-full">
        <NativeSelectOption value="">All</NativeSelectOption>
        <NativeSelectOption value="a">
          acme-engineering/agent-rules-and-skills-for-every-team
        </NativeSelectOption>
      </NativeSelect>
    </label>
  ),
};

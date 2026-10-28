import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Markdown } from './markdown';

const skill = `# Validate external input

Validate all external input with a schema **before** it reaches business logic. See the
[OWASP guide](https://owasp.org/www-project-top-ten/) and \`lib/validate.ts\`.

## Rules

1. Reject unknown fields.
2. Return a 400 with the field path.

| Input | Schema |
| --- | --- |
| HTTP body | \`UserCreate\` |
| CLI flags | \`CliOptions\` |

> Never trust a value only because it came from your own front end.

\`\`\`ts
const user = UserCreate.parse(request.body);
\`\`\`
`;

const meta = {
  title: 'Product/Registry/Markdown',
  component: Markdown,
  parameters: { layout: 'padded' },
  args: { source: skill },
  decorators: [
    (Story) => (
      <div className="max-w-prose">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A typical SKILL.md: headings, lists, a table, a quote, code. */
export const Skill: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { name: 'Validate external input' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'OWASP guide' })).toHaveAttribute(
      'rel',
      'noopener noreferrer nofollow',
    );
  },
};

/** Untrusted content stays text: raw HTML is shown, relative links and images stay inert. */
export const UntrustedContent: Story = {
  args: {
    source:
      'Click <a href="javascript:alert(1)">here</a> or [the setup script](./setup.sh).\n\n![diagram](https://example.com/track.png)\n\n<script>alert(1)</script>',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
    await expect(canvasElement.querySelectorAll('script, img')).toHaveLength(0);
    await expect(canvas.queryByRole('link', { name: 'the setup script' })).toBeNull();
  },
};

/** Empty file: nothing rendered. */
export const Empty: Story = { args: { source: '' } };

/** Long words and long code lines at 320px. */
export const LongTextNarrowScreen: Story = {
  args: {
    source:
      'Path: `/home/dev/code/acme-engineering/agent-rules/.claude/skills/validate-external-input/SKILL.md`\n\nSupercalifragilisticexpialidociousvalidationrulesthatneverbreak in a paragraph.',
  },
  decorators: [
    (Story) => (
      <div className="w-80 break-words">
        <Story />
      </div>
    ),
  ],
};

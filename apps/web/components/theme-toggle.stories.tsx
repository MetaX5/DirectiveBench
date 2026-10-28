import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ThemeProvider } from 'next-themes';
import { expect, userEvent, waitFor } from 'storybook/test';
import { ThemeToggle } from './theme';

const meta = {
  title: 'Product/App shell/ThemeToggle',
  component: ThemeToggle,
  parameters: { layout: 'padded' },
  // The app's ThemeProvider follows the system theme; here the provider starts from the theme
  // chosen in the toolbar and stores nothing between stories.
  decorators: [
    (Story, { globals }) => (
      <ThemeProvider
        attribute="class"
        defaultTheme={globals.theme === 'dark' ? 'dark' : 'light'}
        enableSystem={false}
        storageKey="storybook-theme-toggle"
        disableTransitionOnChange
      >
        <Story />
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One press switches the theme on <html>; a second press switches it back. */
export const Toggles: Story = {
  play: async ({ canvas }) => {
    const root = document.documentElement;
    const before = root.classList.contains('dark');
    const button = canvas.getByRole('button', { name: 'Toggle colour theme' });
    await userEvent.click(button);
    await waitFor(() => expect(root.classList.contains('dark')).toBe(!before));
    await userEvent.click(button);
    await waitFor(() => expect(root.classList.contains('dark')).toBe(before));
    window.localStorage.removeItem('storybook-theme-toggle');
  },
};

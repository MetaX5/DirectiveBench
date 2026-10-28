import { defineMain } from '@storybook/nextjs-vite/node';
import remarkGfm from 'remark-gfm';

// Design-system documentation (SPEC-122). Component stories sit next to their components; MDX
// pages, patterns and documentation blocks live in stories/ (proposal P4).
export default defineMain({
  framework: { name: '@storybook/nextjs-vite', options: {} },
  stories: [
    '../stories/**/*.mdx',
    '../stories/**/*.stories.@(ts|tsx)',
    '../components/**/*.stories.@(ts|tsx)',
  ],
  addons: [
    {
      name: '@storybook/addon-docs',
      // Without remark-gfm, Markdown tables in MDX render as raw text (prompt rule 7).
      options: { mdxPluginOptions: { mdxCompileOptions: { remarkPlugins: [remarkGfm] } } },
    },
    '@storybook/addon-a11y',
    '@storybook/addon-vitest',
  ],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  features: { sidebarOnboardingChecklist: false, menuOnboardingChecklist: false },
});

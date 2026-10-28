import '@fontsource-variable/figtree';
import './states.css';
import './preview.css';
import { DocsContainer, type DocsContainerProps } from '@storybook/addon-docs/blocks';
import type { Decorator, Preview } from '@storybook/nextjs-vite';
import { useSyncExternalStore } from 'react';
import { create } from 'storybook/theming';
import { applyTheme, currentTheme, followThemeGlobal, onThemeChange } from './theme';

followThemeGlobal();

const withTheme: Decorator = (Story, context) => {
  applyTheme(context.globals.theme);
  return <Story />;
};

// Documentation text uses the product font (SPEC-119 §7) and follows the theme switcher.
const fonts = {
  fontBase: "'Figtree Variable', ui-sans-serif, system-ui, sans-serif",
  fontCode: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};
const docsThemes = {
  light: create({ base: 'light', ...fonts }),
  dark: create({ base: 'dark', ...fonts }),
};

function ThemedDocsContainer(props: DocsContainerProps) {
  const theme = useSyncExternalStore(onThemeChange, currentTheme);
  return <DocsContainer {...props} theme={docsThemes[theme]} />;
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [withTheme],
  parameters: {
    // Every story must pass axe with no violations (SPEC-122 FR-122-1, AC-4).
    a11y: { test: 'error' },
    docs: { container: ThemedDocsContainer },
    controls: { expanded: true },
    options: {
      storySort: {
        order: ['Design system', 'Foundations', 'Primitives', 'Product', 'Patterns'],
      },
    },
  },
};

export default preview;

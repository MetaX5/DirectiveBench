import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';

// The Storybook UI shows only the product name (SPEC-122 FR-122-6). The base is Storybook
// (storybook.js.org), recorded in the technical note of the Design system pages.
const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

addons.setConfig({
  theme: create({
    base: dark ? 'dark' : 'light',
    brandTitle: 'DirectiveBench',
    brandUrl: './',
  }),
});

// The manager writes "<page> ⋅ Storybook" into the tab title; keep only the product name.
const suffix = ' ⋅ Storybook';
const brand = (): void => {
  if (document.title.endsWith(suffix)) {
    document.title = `${document.title.slice(0, -suffix.length)} ⋅ DirectiveBench`;
  } else if (document.title === 'Storybook') {
    document.title = 'DirectiveBench';
  }
};
new MutationObserver(brand).observe(document.head, {
  subtree: true,
  childList: true,
  characterData: true,
});
brand();

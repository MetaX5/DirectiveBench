import { addons } from 'storybook/preview-api';
import { GLOBALS_UPDATED, SET_GLOBALS } from 'storybook/internal/core-events';

// The theme switcher sets the .dark class on <html>, as next-themes does in the app (tokeny.md
// decision 15), so overlays rendered outside the story get the theme too (prompt rule 8).
export type Theme = 'light' | 'dark';

const listeners = new Set<() => void>();

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function applyTheme(value: unknown): void {
  const theme: Theme = value === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  if (currentTheme() === theme && root.style.colorScheme === theme) return;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  for (const listener of listeners) listener();
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// MDX pages without stories run no decorator, so the theme also follows the globals events.
export function followThemeGlobal(): void {
  void addons.ready().then((channel) => {
    const update = ({ globals }: { globals: Record<string, unknown> }) => applyTheme(globals.theme);
    channel.on(SET_GLOBALS, update);
    channel.on(GLOBALS_UPDATED, update);
  });
}

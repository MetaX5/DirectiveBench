import type { HighlightResult } from '@/lib/syntax-highlight';
import { baselineRender, candidateRender } from './fixtures';
import generated from './highlight-fixtures.json';

// Story data for syntax highlighting (SPEC-123 §6.7). Stories cannot run the server-only
// highlighter, so the tokens of these samples are precomputed by lib/syntax-highlight.ts into
// highlight-fixtures.json, without the per-line time limit so they do not depend on the speed
// of the machine. test/highlight-fixtures.test.ts fails when the JSON is stale;
// regenerate it with `UPDATE_HIGHLIGHT_FIXTURES=1 pnpm --filter @directivebench/web exec
// vitest run test/highlight-fixtures.test.ts`.

export const editTsx = `import { useBlockProps } from '@wordpress/block-editor';

/** Editor view of the notice block. */
export default function Edit({ attributes, setAttributes }: EditProps) {
  const label = \`Close \${attributes.title ?? 'notice'}\`;
  return (
    <div {...useBlockProps({ className: 'is-dismissible' })}>
      <button type="button" aria-label={label} onClick={() => setAttributes({ open: false })}>
        x
      </button>
    </div>
  );
}
`;

export const blockJson = `{
  "$schema": "https://schemas.wp.org/trunk/block.json",
  "apiVersion": 3,
  "name": "notice-block/notice",
  "supports": { "html": false },
  "render": "file:./render.php"
}
`;

export const readmeMarkdown = `# Notice block

A dismissible notice. See [the block API](https://developer.wordpress.org/block-editor/).

\`\`\`sh
npm run build
\`\`\`
`;

export const hostileHtml = `<script>alert(1)</script>
<img src="x" onerror="alert(2)">
`;

export const highlightSamples = {
  candidateRender: { path: 'src/render.php', text: candidateRender },
  baselineRender: { path: 'src/render.php', text: baselineRender },
  editTsx: { path: 'src/edit.tsx', text: editTsx },
  blockJson: { path: 'block.json', text: blockJson },
  readmeMarkdown: { path: 'README.md', text: readmeMarkdown },
  hostileHtml: { path: 'index.html', text: hostileHtml },
} as const;

export type HighlightSample = keyof typeof highlightSamples;

/** Tokens of each sample as the server would send them to FileView and SideBySideDiff. */
export const highlights = generated as Record<HighlightSample, HighlightResult>;

/** The sample as a kept output file, for FileView and SideBySideDiff stories. */
export const sampleFile = (sample: HighlightSample) => {
  const { path, text } = highlightSamples[sample];
  return { path, content: text, sizeBytes: new TextEncoder().encode(text).length };
};

/**
 * Story check: every highlighted line of `root` shows exactly the text of its own line number
 * in `text`, so tokens can never drift from the line they belong to (FR-123-76). Returns the
 * number of highlighted lines.
 */
export function highlightedLineTexts(root: Element): Array<[number, string]> {
  return [...root.querySelectorAll('[data-highlighted]')].map((span) => [
    Number(span.parentElement!.firstElementChild!.textContent),
    span.textContent === '\u00a0' ? '' : span.textContent!,
  ]);
}

/** The colour a `--syntax-token-*` design token resolves to in the theme on screen. */
export function tokenColour(element: Element, token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(--syntax-token-${token})`;
  element.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

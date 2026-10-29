import type { OutputFile } from '@/lib/output-files';

// Story data for the output-file components (SPEC-123). Illustrative agent output, not a real
// run: a server-rendered block, a configuration file and a Markdown note.

export const baselineRender = `<?php
$wrapper = get_block_wrapper_attributes();
$label = 'Close';
?>
<div <?php echo $wrapper; ?>>
  <?php echo wp_kses_post( $content ); ?>
  <button type="button"><?php echo $label; ?></button>
</div>
`;

export const candidateRender = `<?php
$wrapper = get_block_wrapper_attributes(
  array( 'class' => 'is-dismissible' )
);
$label = esc_attr__( 'Close notice', 'notice-block' );
?>
<div <?php echo $wrapper; ?>>
  <?php echo wp_kses_post( $content ); ?>
  <button type="button" aria-label="<?php echo $label; ?>">x</button>
</div>
`;

export const file = (overrides: Partial<OutputFile> = {}): OutputFile => ({
  path: 'src/render.php',
  change: 'modified',
  sizeBytes: new TextEncoder().encode(candidateRender).length,
  kept: 'full',
  reason: null,
  content: candidateRender,
  redactions: 0,
  ...overrides,
});

export const longPath =
  'packages/notice-block/src/components/dismissible-notice/server-rendering/templates/render-dismissible-notice-with-accessible-close-button.php';

export const longLine = `const allowedBlocks = [${Array.from({ length: 40 }, (_, index) => `'core/block-${index}'`).join(', ')}];`;

/** Numbered lines, so a story can make two long files that differ in a chosen number of lines. */
export const numberedLines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}\n`).join('');

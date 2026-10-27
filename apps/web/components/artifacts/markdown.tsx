import type { ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';

/**
 * Renders untrusted Markdown as React elements only (FR-101-18): every piece of content is a text
 * node, so raw HTML is shown as text and nothing in it can run. Links are real links only for
 * absolute http(s)/mailto URLs (`safeHref`); every other link and every image is inert text.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed">{renderBlocks(parseMarkdown(source))}</div>
  );
}

function renderInlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return (
          <span key={index} className="whitespace-pre-line">
            {node.text}
          </span>
        );
      case 'code':
        return (
          <code key={index} className="rounded-surface bg-muted px-1 py-0.5 font-mono text-xs">
            {node.text}
          </code>
        );
      case 'strong':
        return <strong key={index}>{renderInlines(node.children)}</strong>;
      case 'emphasis':
        return <em key={index}>{renderInlines(node.children)}</em>;
      case 'link':
        return node.href ? (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline"
          >
            {renderInlines(node.children)}
          </a>
        ) : (
          <span
            key={index}
            data-inert-link=""
            title={`Link not followed: ${node.destination}`}
            className="underline decoration-dotted"
          >
            {renderInlines(node.children)}
          </span>
        );
      case 'image':
        return (
          <span
            key={index}
            data-inert-image=""
            title={`Image not loaded: ${node.destination}`}
            className="rounded-surface border px-1 text-xs text-muted-foreground"
          >
            [image: {node.alt || node.destination}]
          </span>
        );
    }
  });
}

const headingClasses = {
  1: 'text-lg font-semibold',
  2: 'text-base font-semibold',
  3: 'text-sm font-semibold',
  4: 'text-sm font-medium',
  5: 'text-sm font-medium',
  6: 'text-sm font-medium text-muted-foreground',
} as const;

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case 'frontmatter':
        return (
          <pre
            key={index}
            data-frontmatter=""
            className="overflow-auto rounded-surface border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {block.text}
          </pre>
        );
      case 'heading': {
        const Tag = `h${block.level}` as const;
        return (
          <Tag key={index} className={headingClasses[block.level]}>
            {renderInlines(block.children)}
          </Tag>
        );
      }
      case 'paragraph':
        return <p key={index}>{renderInlines(block.children)}</p>;
      case 'code':
        return (
          <pre
            key={index}
            data-language={block.language ?? undefined}
            className="overflow-auto rounded-surface border bg-muted/40 p-2 font-mono text-xs whitespace-pre"
          >
            <code>{block.text}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={index} className="space-y-3 border-l-2 pl-3 text-muted-foreground">
            {renderBlocks(block.children)}
          </blockquote>
        );
      case 'list': {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="space-y-2">
            {renderBlocks(item)}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        );
      }
      case 'rule':
        return <hr key={index} />;
      case 'table':
        return (
          <div key={index} className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="border-b">
                  {block.header.map((cell, cellIndex) => (
                    <th key={cellIndex} className="px-2 py-1 text-left font-medium">
                      {renderInlines(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b">
                    {row.cells.map((cell, cellIndex) => (
                      <td key={cellIndex} className="px-2 py-1 align-top">
                        {renderInlines(cell)}
                      </td>
                    ))}
                    {row.missing > 0 && <td colSpan={row.missing} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

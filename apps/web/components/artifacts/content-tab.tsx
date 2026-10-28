import type { ArtifactDetail } from '@directivebench/database';
import { FileText, Folder } from 'lucide-react';
import Link from 'next/link';
import { Markdown } from '@/components/artifacts/markdown';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Pre,
} from '@/components/ui/primitives';
import {
  artifactHref,
  buildFileTree,
  formatBytes,
  rawViewNotice,
  type ContentSelection,
  type FileTreeNode,
} from '@/lib/artifacts';
import { MAX_RENDERED_MARKDOWN_CHARS, isMarkdownPath } from '@/lib/markdown';
import { cn } from '@/lib/utils';

type Version = ArtifactDetail['versions'][number];

function FileTree({
  nodes,
  artifactId,
  version,
  selected,
}: {
  nodes: FileTreeNode[];
  artifactId: string;
  version: number;
  selected: string;
}) {
  return (
    <ul className="space-y-0.5 pl-3 first:pl-0">
      {nodes.map((node) =>
        node.children ? (
          <li key={`d:${node.path}`}>
            <span className="flex items-center gap-1 text-muted-foreground">
              <Folder className="size-3" aria-hidden />
              {node.name}/
            </span>
            <FileTree
              nodes={node.children}
              artifactId={artifactId}
              version={version}
              selected={selected}
            />
          </li>
        ) : (
          <li key={`f:${node.path}`}>
            <Link
              href={artifactHref(artifactId, { tab: 'content', version, file: node.path })}
              aria-current={node.path === selected ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1 rounded-surface px-1 hover:bg-accent',
                node.path === selected && 'bg-accent font-medium',
              )}
            >
              <FileText className="size-3" aria-hidden />
              {node.name}
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}

/** Content tab (FR-101-15): version selector, file tree, rendered and raw view (FR-101-18). */
export function ContentTab({
  artifactId,
  versions,
  selection,
}: {
  artifactId: string;
  versions: Version[];
  selection: ContentSelection<Version>;
}) {
  const { version, file } = selection;
  if (!version || !file) {
    return <p className="text-body text-muted-foreground">This artifact has no stored content.</p>;
  }
  const markdown = isMarkdownPath(file.path);
  const tooLarge = file.content.length > MAX_RENDERED_MARKDOWN_CHARS;
  const crNotice = rawViewNotice(file.content);

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Version</CardTitle>
          </CardHeader>
          <CardContent>
            <nav aria-label="Versions" className="flex flex-wrap gap-1 text-ui">
              {versions.map((v) => (
                <Link
                  key={v.id}
                  href={artifactHref(artifactId, {
                    tab: 'content',
                    version: v.version,
                    // Keep the file when the other version has it too.
                    ...(v.files.some((f) => f.path === file.path) ? { file: file.path } : {}),
                  })}
                  aria-current={v.id === version.id ? 'page' : undefined}
                  className={cn(
                    'rounded-surface border px-2 py-0.5 hover:bg-accent',
                    v.id === version.id && 'bg-accent font-medium',
                  )}
                >
                  v{v.version}
                </Link>
              ))}
            </nav>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>
              {version.files.length} file(s) in version {version.version}
            </CardDescription>
          </CardHeader>
          <CardContent className="font-mono text-ui" data-testid="file-tree">
            <FileTree
              nodes={buildFileTree(version.files.map((f) => f.path))}
              artifactId={artifactId}
              version={version.version}
              selected={file.path}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 lg:col-span-3">
        <Card>
          <CardHeader>
            <CardTitle className="font-mono" data-testid="content-path">
              {file.path}
            </CardTitle>
            <CardDescription>
              Version {version.version} · {formatBytes(file.size)} · sha256{' '}
              <span className="font-mono">{file.sha256.slice(0, 16)}…</span>
              {file.path === version.primaryFile ? ' · primary file' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <h4 className="mb-2 text-ui font-medium text-muted-foreground">Rendered</h4>
            <div data-testid="artifact-rendered">
              {!markdown ? (
                <p className="text-body text-muted-foreground">
                  Only Markdown is rendered. This file is shown as text only, in the raw view below;
                  DirectiveBench never runs or loads supporting files.
                </p>
              ) : tooLarge ? (
                <p className="text-body text-muted-foreground">
                  This file is too large to render ({formatBytes(file.size)}); the raw view below
                  shows all of it.
                </p>
              ) : (
                <Markdown source={file.content} />
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Raw</CardTitle>
            <CardDescription>
              The stored content, exactly as found in the repository. Raw HTML and scripts are shown
              as text.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {crNotice ? (
              <p className="mb-2 text-ui text-muted-foreground" data-testid="raw-notice">
                {crNotice}
              </p>
            ) : null}
            <Pre data-testid="artifact-raw" className="max-h-[40rem]">
              {file.content}
            </Pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

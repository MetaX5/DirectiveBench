import { loadConfig } from '@directivebench/core';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/common';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Pre,
} from '@/components/ui/primitives';
import { getDataDir } from '@/lib/db';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  const layout = getDataDir();
  let config: unknown;
  let error: string | null = null;
  try {
    config = loadConfig(layout.config);
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <>
      <PageHeader
        title="Settings"
        description="Read-only view of the resolved data directory and effective configuration. Edit config.json or use CLI flags."
        actions={<Badge variant="muted">Planned — not implemented: settings editor</Badge>}
      />
      <div className="grid gap-grid lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Data directory</CardTitle>
            <CardDescription>Override with --data-dir or DIRECTIVEBENCH_DATA_DIR.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 font-mono text-ui">
            <p>{layout.root}</p>
            <p className="text-muted-foreground">database: {layout.database}</p>
            <p className="text-muted-foreground">fixtures: {layout.fixtures}</p>
            <p className="text-muted-foreground">config: {layout.config}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Effective configuration</CardTitle>
            <CardDescription>config.json merged with defaults.</CardDescription>
          </CardHeader>
          <CardContent>
            {error ? (
              <p className="text-body text-destructive-foreground">{error}</p>
            ) : (
              <Pre>{JSON.stringify(config, null, 2)}</Pre>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Planned</CardTitle>
            <CardDescription>
              Specification:{' '}
              <span className="font-mono">.ai/specs/2026-10-14-settings-and-configuration.md</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-body">
            {[
              'Settings editor',
              'Secret storage (OS keychain)',
              'Backup and restore',
              'Import / export',
            ].map((item) => (
              <Badge key={item} variant="muted">
                {item} — not implemented
              </Badge>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

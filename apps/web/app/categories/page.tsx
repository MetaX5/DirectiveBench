import { listCategories } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { NotInitialized, PageHeader } from '@/components/common';
import {
  Badge,
  Card,
  CardContent,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import { getDatabase } from '@/lib/db';

export const metadata: Metadata = { title: 'Categories' };

export default async function CategoriesPage() {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Categories" />
        <NotInitialized />
      </>
    );
  const categories = await listCategories(handle.db);
  return (
    <>
      <PageHeader
        title="Categories"
        description="Read-only in this release. Creating, renaming, merging and archiving categories is planned (Milestone 1)."
      />
      <Card>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Slug</TH>
                <TH>Description</TH>
                <TH>Origin</TH>
                <TH className="text-right">Artifacts</TH>
              </TR>
            </THead>
            <TBody>
              {categories.map((c) => (
                <TR key={c.id}>
                  <TD className="font-medium">
                    {Number(c.artifactCount) > 0 ? (
                      <Link className="hover:underline" href={`/artifacts?category=${c.slug}`}>
                        {c.name}
                      </Link>
                    ) : (
                      c.name
                    )}
                    {c.archivedAt ? (
                      <Badge variant="muted" className="ml-2">
                        archived
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="font-mono text-ui text-muted-foreground">{c.slug}</TD>
                  <TD className="text-muted-foreground">{c.description ?? '—'}</TD>
                  <TD className="text-ui">{c.predefined ? 'Predefined' : 'User-defined'}</TD>
                  <TD className="text-right tabular-nums">{Number(c.artifactCount)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

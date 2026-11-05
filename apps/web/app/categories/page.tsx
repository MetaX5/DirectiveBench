import { CATEGORY_DESCRIPTION_MAX_LENGTH, CATEGORY_NAME_MAX_LENGTH } from '@directivebench/core';
import { listCategories } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, NotInitialized, PageHeader } from '@/components/common';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import { artifactsPhrase } from '@/lib/categories';
import { getDatabase } from '@/lib/db';
import { formatCount } from '@/lib/utils';
import { NewCategoryCard } from './category-forms';

export const metadata: Metadata = { title: 'Categories' };

type CategoryRow = Awaited<ReturnType<typeof listCategories>>[number];

/** The Active or Archived categories card (SPEC-124 §11, D2 to D5): no row actions. */
function CategoryTable({
  title,
  description,
  categories,
}: {
  title: string;
  description: string;
  categories: CategoryRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label={title}>
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
            {categories.map((c) => {
              const count = Number(c.artifactCount);
              return (
                <TR key={c.id}>
                  <TD className="min-w-40 font-medium wrap-anywhere">
                    <Link href={`/categories/${c.slug}`} className="text-primary-text underline">
                      {c.name}
                    </Link>
                  </TD>
                  <TD className="font-mono text-ui text-muted-foreground">{c.slug}</TD>
                  <TD className="min-w-48 text-muted-foreground wrap-anywhere">{c.description}</TD>
                  <TD className="text-ui">{c.predefined ? 'Predefined' : 'User-defined'}</TD>
                  <TD className="text-right tabular-nums">
                    {count > 0 ? (
                      <Link
                        href={`/artifacts?category=${c.slug}`}
                        aria-label={`${artifactsPhrase(count)} with ${c.name}`}
                        className="text-primary-text underline"
                      >
                        {formatCount(count)}
                      </Link>
                    ) : (
                      formatCount(count)
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

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
  const active = categories.filter((c) => c.archivedAt === null);
  const archived = categories.filter((c) => c.archivedAt !== null);
  return (
    <>
      <PageHeader
        title="Categories"
        description="Group artifacts in your own categories. Merging categories and changing a slug are planned."
      />
      <div className="flex flex-col gap-grid">
        <NewCategoryCard
          limits={{ name: CATEGORY_NAME_MAX_LENGTH, description: CATEGORY_DESCRIPTION_MAX_LENGTH }}
        />
        {active.length > 0 ? (
          <CategoryTable
            title="Active categories"
            description="Open a category to rename or archive it."
            categories={active}
          />
        ) : (
          <EmptyState title="No active categories">
            {archived.length > 0
              ? 'Create one above, or unarchive one below.'
              : 'Create one above.'}
          </EmptyState>
        )}
        {archived.length > 0 ? (
          <CategoryTable
            title="Archived categories"
            description="Hidden from pickers and filters. Their assignments stay."
            categories={archived}
          />
        ) : null}
      </div>
    </>
  );
}

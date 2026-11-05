import { getCategoryBySlug } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotInitialized, PageHeader } from '@/components/common';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { categorySlugSchema } from '@/lib/artifacts';
import { CATEGORY_DESCRIPTION_MAX_LENGTH, CATEGORY_NAME_MAX_LENGTH } from '@directivebench/core';
import { archiveReason, archivedStatusText, artifactsPhrase } from '@/lib/categories';
import { getDatabase } from '@/lib/db';
import { CategoryDetailsCard, CategoryStatusCard } from '../category-forms';

export const metadata: Metadata = { title: 'Category' };

// A category's page (SPEC-124 §11, §11.2 D7 to D11): Details, Artifacts, then Status with the
// Archive confirmation. An invalid or unknown slug renders the app's not-found page.
export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Category" />
        <NotInitialized />
      </>
    );
  const slug = categorySlugSchema.safeParse((await params).slug);
  if (!slug.success) notFound();
  const category = await getCategoryBySlug(handle.db, slug.data);
  if (!category) notFound();
  const count = category.artifactCount;
  return (
    <>
      <PageHeader
        title={category.name}
        description={
          <>
            {category.archived ? (
              <>
                <Badge variant="muted">archived</Badge>{' '}
              </>
            ) : null}
            Slug <code className="font-mono wrap-anywhere">{category.slug}</code>.{' '}
            {category.predefined ? 'Predefined.' : 'User-defined.'}
          </>
        }
      />
      <div className="flex flex-col gap-grid">
        <CategoryDetailsCard
          id={category.id}
          slug={category.slug}
          name={category.name}
          description={category.description}
          limits={{ name: CATEGORY_NAME_MAX_LENGTH, description: CATEGORY_DESCRIPTION_MAX_LENGTH }}
        />
        <Card>
          <CardHeader>
            <CardTitle>Artifacts</CardTitle>
          </CardHeader>
          <CardContent className="text-body">
            {count > 0 ? (
              <p>
                <Link
                  href={`/artifacts?category=${category.slug}`}
                  className="text-primary-text underline"
                >
                  {artifactsPhrase(count)}
                </Link>{' '}
                {count === 1 ? 'has' : 'have'} this category.
              </p>
            ) : (
              <p className="text-muted-foreground">
                No artifact has this category yet. Assign it on an artifact&apos;s page or to a
                filtered list on Artifacts.
              </p>
            )}
          </CardContent>
        </Card>
        {/* A rename can resolve an unarchive clash: the new name starts a fresh Status card, so
            an earlier refusal does not stay on screen (browser QA of PR 196). */}
        <CategoryStatusCard
          key={category.name}
          id={category.id}
          name={category.name}
          archived={category.archived}
          statusText={
            category.archived
              ? archivedStatusText(count)
              : 'Archived categories leave pickers and filters. Their assignments stay.'
          }
          archiveReason={archiveReason(count)}
        />
      </div>
    </>
  );
}

import Link from 'next/link';
import { PageHeader } from '@/components/common';

export default function NotFound() {
  return (
    <>
      <PageHeader
        title="Not found"
        description="The requested record does not exist in the local database."
      />
      <Link href="/" className="text-body underline">
        Back to the dashboard
      </Link>
    </>
  );
}

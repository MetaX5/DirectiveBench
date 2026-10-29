import { Badge } from '@/components/ui/badge';
import { fileBadges, onlyInBadge, type OutputFile } from '@/lib/output-files';

/**
 * The badges of one output file in a list: its change, what was not kept and the redaction
 * count (SPEC-123 FR-123-21). `onlyIn` marks a path that one of two compared runs lacks.
 */
export function FileStatusBadges({
  file,
  onlyIn,
}: {
  file: Pick<OutputFile, 'change' | 'kept' | 'reason' | 'redactions'>;
  /** The side that has the path, for example "left" or "A"; omit when both have it. */
  onlyIn?: string;
}) {
  const badges = [...(onlyIn ? [onlyInBadge(onlyIn)] : []), ...fileBadges(file)];
  return (
    <span className="inline-flex flex-wrap gap-inline-tight">
      {badges.map((badge) => (
        <Badge key={badge.label} variant={badge.variant}>
          {badge.label}
        </Badge>
      ))}
    </span>
  );
}

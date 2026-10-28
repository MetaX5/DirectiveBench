import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Compatibility exports keep existing screens on the shared preset components.
export { Button, buttonVariants } from './button';
export { Badge, badgeVariants } from './badge';
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from './card';
export {
  Table,
  TableHeader as THead,
  TableBody as TBody,
  TableRow as TR,
  TableHead as TH,
  TableCell as TD,
} from './table';

// Pre scrolls past 28rem, so it is a tab stop: keyboard users can scroll it (SPEC-122 P13).
export function Pre({ className, ...props }: ComponentProps<'pre'>) {
  return (
    <pre
      tabIndex={0}
      className={cn(
        'max-h-[28rem] overflow-auto rounded-none border bg-muted/40 p-3 font-mono text-ui leading-relaxed whitespace-pre-wrap break-words outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

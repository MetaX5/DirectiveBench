import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge only knows Tailwind's default scales: without these design tokens (SPEC-120,
// app/globals.css) it reads `text-caption` as a text colour and drops it next to one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['caption', 'ui', 'body', 'page-title', 'metric'],
      spacing: [
        'page-inline',
        'page-block',
        'section',
        'grid',
        'stack',
        'inline',
        'inline-tight',
        'control',
        'control-sm',
        'control-xs',
        'sidebar',
      ],
      radius: ['surface'],
      container: ['content'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

export function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? '—' : `${Math.round(score * 1000) / 10}%`;
}

export function formatDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return '—';
  const points = Math.round(delta * 1000) / 10;
  return `${points > 0 ? '+' : ''}${points} pts`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

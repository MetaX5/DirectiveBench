'use client';

import {
  Bot,
  Boxes,
  FlaskConical,
  FolderGit2,
  Gauge,
  ListChecks,
  type LucideIcon,
  PencilRuler,
  PlayCircle,
  Server,
  Settings,
  Tags,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  planned?: boolean;
}

const sections: { title: string; items: NavItem[] }[] = [
  {
    title: 'Registry',
    items: [
      { href: '/', label: 'Dashboard', icon: Gauge },
      { href: '/repositories', label: 'Repositories', icon: FolderGit2 },
      { href: '/artifacts', label: 'Artifacts', icon: Boxes },
      { href: '/categories', label: 'Categories', icon: Tags },
    ],
  },
  {
    title: 'Evaluation',
    items: [
      { href: '/benchmarks', label: 'Benchmarks', icon: FlaskConical },
      { href: '/builder', label: 'Benchmark Builder', icon: PencilRuler, planned: true },
      { href: '/executions', label: 'Executions', icon: PlayCircle },
      { href: '/results', label: 'Results', icon: ListChecks },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { href: '/agents', label: 'Agent Connections', icon: Bot },
      { href: '/providers', label: 'Model Providers', icon: Server, planned: true },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="px-2 pb-1 text-caption font-medium uppercase tracking-wide text-muted-foreground">
            {section.title}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-none px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    <item.icon className="size-4" aria-hidden />
                    <span className="flex-1">{item.label}</span>
                    {item.planned ? (
                      <span className="text-caption uppercase tracking-wide text-muted-foreground">
                        planned
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import {
  Bot,
  Boxes,
  ChevronDownIcon,
  Construction,
  DatabaseZap,
  FileText,
  FlaskConical,
  Folder,
  FolderGit2,
  Gauge,
  ListChecks,
  type LucideIcon,
  Moon,
  PencilRuler,
  Play,
  PlayCircle,
  Server,
  Settings,
  Sun,
  Tags,
} from 'lucide-react';
import { expect } from 'storybook/test';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const meta = {
  title: 'Foundations/Icons',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// Every lucide icon the app imports on 2026-10-28, with the place it appears.
const inUse: Array<[icon: LucideIcon, name: string, where: string]> = [
  [Gauge, 'Gauge', 'Navigation: Dashboard'],
  [FolderGit2, 'FolderGit2', 'Navigation: Repositories'],
  [Boxes, 'Boxes', 'Navigation: Artifacts'],
  [Tags, 'Tags', 'Navigation: Categories'],
  [FlaskConical, 'FlaskConical', 'Navigation: Benchmarks; MockBadge'],
  [PencilRuler, 'PencilRuler', 'Navigation: Benchmark Builder (planned)'],
  [PlayCircle, 'PlayCircle', 'Navigation: Executions'],
  [ListChecks, 'ListChecks', 'Navigation: Results'],
  [Bot, 'Bot', 'Navigation: Agent Connections'],
  [Server, 'Server', 'Navigation: Model Providers (planned)'],
  [Settings, 'Settings', 'Navigation: Settings'],
  [Sun, 'Sun', 'ThemeToggle in dark theme'],
  [Moon, 'Moon', 'ThemeToggle in light theme'],
  [Play, 'Play', 'Run button on a benchmark'],
  [DatabaseZap, 'DatabaseZap', 'NotInitialized notice'],
  [Construction, 'Construction', 'PlannedSection'],
  [Folder, 'Folder', 'Artifact content tree: folder'],
  [FileText, 'FileText', 'Artifact content tree: file'],
  [ChevronDownIcon, 'ChevronDown', 'NativeSelect indicator'],
];

/** The icons in use, at the default 16px, with their meaning carried by text. */
export const InUse: Story = {
  render: () => (
    <Table aria-label="Icons in use">
      <TableHeader>
        <TableRow>
          <TableHead>Icon</TableHead>
          <TableHead>lucide-react name</TableHead>
          <TableHead>Where</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {inUse.map(([Icon, name, where]) => (
          <TableRow key={name}>
            <TableCell>
              <Icon className="size-4" aria-hidden />
            </TableCell>
            <TableCell className="font-mono">{name}</TableCell>
            <TableCell>{where}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/** Sizes in use: 12px inside badges and trees, 16px in navigation and buttons, 20px in notices. */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-section">
      {[
        ['size-3', '12px: badge, file tree'],
        ['size-4', '16px: default, navigation, button'],
        ['size-5', '20px: notice beside a paragraph'],
      ].map(([size, label]) => (
        <figure key={size} className="flex flex-col items-center gap-inline-tight">
          <FlaskConical className={size} aria-hidden />
          <figcaption className="text-caption text-muted-foreground">{label}</figcaption>
        </figure>
      ))}
    </div>
  ),
};

/** An icon-only control names its action for assistive technology (WCAG 4.1.2). */
export const IconOnlyControl: Story = {
  render: () => (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle colour theme"
      title="Toggle colour theme"
    >
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  ),
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Toggle colour theme' });
    const box = button.getBoundingClientRect();
    // Target size of at least 24 by 24 px (WCAG 2.5.8).
    await expect(box.width).toBeGreaterThanOrEqual(24);
    await expect(box.height).toBeGreaterThanOrEqual(24);
  },
};

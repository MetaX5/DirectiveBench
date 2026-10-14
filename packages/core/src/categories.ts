export interface PredefinedCategory {
  slug: string;
  name: string;
  description: string;
}

/** Initial categories created by `directivebench init`. Users may rename or archive them. */
export const PREDEFINED_CATEGORIES: readonly PredefinedCategory[] = [
  {
    slug: 'security',
    name: 'Security',
    description: 'Secure coding, vulnerabilities and hardening.',
  },
  {
    slug: 'code-quality',
    name: 'Code Quality',
    description: 'Readability, correctness and maintainability.',
  },
  { slug: 'testing', name: 'Testing', description: 'Writing and running automated tests.' },
  { slug: 'documentation', name: 'Documentation', description: 'Docs, comments and changelogs.' },
  { slug: 'performance', name: 'Performance', description: 'Runtime and build performance.' },
  { slug: 'architecture', name: 'Architecture', description: 'System design and structure.' },
  { slug: 'frontend', name: 'Frontend', description: 'Browser and UI development.' },
  { slug: 'backend', name: 'Backend', description: 'Server-side development.' },
  { slug: 'devops', name: 'DevOps', description: 'CI/CD, infrastructure and operations.' },
  { slug: 'wordpress', name: 'WordPress', description: 'WordPress plugins, themes and core.' },
  { slug: 'php', name: 'PHP', description: 'PHP language and ecosystem.' },
  { slug: 'react', name: 'React', description: 'React components and hooks.' },
  { slug: 'nextjs', name: 'Next.js', description: 'Next.js applications.' },
  { slug: 'typescript', name: 'TypeScript', description: 'TypeScript language and typing.' },
  { slug: 'python', name: 'Python', description: 'Python language and ecosystem.' },
  { slug: 'database', name: 'Database', description: 'Schemas, queries and migrations.' },
  { slug: 'workflow', name: 'Workflow', description: 'Agent workflows, planning and process.' },
];

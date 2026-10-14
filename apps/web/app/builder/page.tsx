import type { Metadata } from 'next';
import { PlannedSection } from '@/components/common';

export const metadata: Metadata = { title: 'Benchmark Builder' };

export default function BuilderPage() {
  return (
    <PlannedSection
      title="Benchmark Builder"
      summary="A structured editor for benchmark suites: scenarios, fixtures, prompts, weighted assertions, repetitions and compatible agents, with a raw YAML/JSON view. Today, suites are written as YAML files validated by the benchmark definition schema (see examples/benchmarks)."
      milestone="Milestone 5"
      specs={[
        '.ai/specs/2026-10-14-benchmark-builder.md',
        '.ai/specs/2026-10-14-benchmark-definition-format.md',
      ]}
    />
  );
}

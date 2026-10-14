import { CLI_AGENTS, MockAgentAdapter, detectCliAgent } from '@directivebench/agent-adapters';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/common';
import {
  Badge,
  Card,
  CardContent,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Agent Connections' };

export default async function AgentsPage() {
  const mock = await new MockAgentAdapter().detect();
  const detections = await Promise.all(
    CLI_AGENTS.map(async (d) => ({ descriptor: d, detection: await detectCliAgent(d) })),
  );
  return (
    <>
      <PageHeader
        title="Agent Connections"
        description="Coding agent harnesses detected on this machine. Detection looks up the CLI on PATH and runs its version command; credential files are never read."
      />
      <Card>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH>Detected</TH>
                <TH>Version</TH>
                <TH>Authentication</TH>
                <TH>Benchmark execution</TH>
                <TH>Specification</TH>
              </TR>
            </THead>
            <TBody>
              <TR>
                <TD className="font-medium">Mock Agent (deterministic, no AI)</TD>
                <TD>
                  <Badge variant="success">built-in</Badge>
                </TD>
                <TD className="font-mono text-xs">{mock.version}</TD>
                <TD className="text-xs">not required</TD>
                <TD>
                  <Badge variant="success">supported</Badge>
                </TD>
                <TD className="text-xs text-muted-foreground">—</TD>
              </TR>
              {detections.map(({ descriptor, detection }) => (
                <TR key={descriptor.id} data-agent={descriptor.id}>
                  <TD className="font-medium">
                    {descriptor.displayName}{' '}
                    <span className="font-mono text-xs text-muted-foreground">
                      {descriptor.executable}
                    </span>
                  </TD>
                  <TD>
                    {detection.installed ? (
                      <Badge variant="success">found</Badge>
                    ) : (
                      <Badge variant="muted">not found</Badge>
                    )}
                  </TD>
                  <TD className="font-mono text-xs">{detection.version ?? '—'}</TD>
                  <TD
                    className="text-xs text-muted-foreground"
                    title="Login status checks are specified but not implemented"
                  >
                    unknown
                  </TD>
                  <TD>
                    <Badge variant="muted">not implemented</Badge>
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">{descriptor.specPath}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="mt-4 text-xs text-muted-foreground">
            Real agent execution (Local Subscription Mode and API Key Mode) is planned for Milestone
            4. DirectiveBench will use only officially supported CLI/SDK mechanisms and never copies
            agent session credentials.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

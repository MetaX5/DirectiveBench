import {
  CLI_AGENTS,
  MockAgentAdapter,
  detectCliAgent,
  type AgentDetection,
} from '@directivebench/agent-adapters';
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

const MODE_LABELS: Record<string, string> = { subscription: 'Subscription', 'api-key': 'API key' };

function AuthCell({ detection }: { detection: AgentDetection }) {
  if (!detection.readiness) {
    return (
      <TD
        className="text-ui text-muted-foreground"
        title="Login status checks are specified but not implemented"
      >
        unknown
      </TD>
    );
  }
  return (
    <TD className="text-ui">
      {detection.auth === 'ready' ? (
        <Badge variant="success">ready</Badge>
      ) : (
        <Badge variant="warning">missing</Badge>
      )}
      <ul className="mt-1 space-y-0.5">
        {detection.readiness.map((mode) => (
          <li key={mode.mode} data-auth-mode={mode.mode}>
            <span className="font-medium">{MODE_LABELS[mode.mode] ?? mode.mode}:</span>{' '}
            {mode.ready ? 'ready' : `not ready (${mode.code})`}
            <span className="text-muted-foreground"> — {mode.detail}</span>
          </li>
        ))}
      </ul>
    </TD>
  );
}

export default async function AgentsPage() {
  const mock = await new MockAgentAdapter().detect();
  const detections = await Promise.all(
    CLI_AGENTS.map(async (d) => ({ descriptor: d, detection: await detectCliAgent(d) })),
  );
  return (
    <>
      <PageHeader
        title="Agent Connections"
        description="Coding agent harnesses detected on this machine. Detection looks up the CLI on PATH and runs its version command and, for Claude Code, its login status (claude auth status); credential files are never read and an API key is only checked for presence."
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
                <TD className="font-mono text-ui">{mock.version}</TD>
                <TD className="text-ui">not required</TD>
                <TD>
                  <Badge variant="success">supported</Badge>
                </TD>
                <TD className="text-ui text-muted-foreground">—</TD>
              </TR>
              {detections.map(({ descriptor, detection }) => (
                <TR key={descriptor.id} data-agent={descriptor.id}>
                  <TD className="font-medium">
                    {descriptor.displayName}{' '}
                    <span className="font-mono text-ui text-muted-foreground">
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
                  <TD className="font-mono text-ui">{detection.version ?? '—'}</TD>
                  <AuthCell detection={detection} />
                  <TD>
                    <Badge variant="muted">not implemented</Badge>
                  </TD>
                  <TD className="font-mono text-ui text-muted-foreground">{descriptor.specPath}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="mt-4 text-ui text-muted-foreground">
            Claude Code runs benchmarks from the CLI (<code>directivebench benchmark run</code>) in
            Local Subscription Mode or API Key Mode; running from the web UI and Codex and Cursor
            execution are planned. DirectiveBench uses only officially supported CLI mechanisms and
            never copies agent session credentials.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

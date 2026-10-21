#!/usr/bin/env node
// Packaging verification (see .ai/specs/2026-10-14-testing-strategy.md):
//   1. pack apps/cli (expects `pnpm build` to have run)
//   2. inspect the tarball contents
//   3. install the tarball into an empty temporary project (fetches next/react from the registry)
//   4. run --help and --version, the headless demo, then `serve` and probe it over HTTP
//   5. stop the server with SIGTERM and require a clean exit
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = join(root, 'apps', 'cli');
const work = mkdtempSync(join(tmpdir(), 'directivebench-pack-'));
const failures = [];

function step(name) {
  console.log(`\n▶ ${name}`);
}
function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
}
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

step('pack');
const packOutput = run('pnpm', ['pack', '--pack-destination', work], { cwd: cliDir });
const tarball = join(
  work,
  readdirSync(work).find((f) => f.endsWith('.tgz')),
);
check(Boolean(tarball), `created ${tarball} ${packOutput.trim().split('\n').at(-1)}`);

step('inspect contents');
const files = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean);
for (const required of [
  'package/package.json',
  'package/LICENSE',
  'package/README.md',
  'package/dist/cli.js',
  'package/dist/web/.next/BUILD_ID',
  'package/dist/web/next.config.mjs',
  'package/dist/migrations/meta/_journal.json',
  'package/dist/examples/benchmarks/mock-input-validation/benchmark.yaml',
]) {
  check(files.includes(required), `contains ${required}`);
}
check(!files.some((f) => /(^|\/)\.env/.test(f)), 'contains no .env files');
check(!files.some((f) => f.includes('/.next/cache/')), 'contains no Next.js build cache');
check(!files.some((f) => f.endsWith('.map')), 'contains no source maps');
check(!files.some((f) => f.includes('/node_modules/')), 'contains no node_modules');
const manifest = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']));
check(manifest.license === 'MIT', 'package.json license is MIT');
check(
  !JSON.stringify(manifest.dependencies ?? {}).includes('workspace:'),
  'no workspace: dependencies',
);
console.log(`  ${files.length} files`);

step('install tarball into an empty project');
const project = join(work, 'project');
run('mkdir', ['-p', project]);
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'pack-check', private: true }));
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], { cwd: project });
const bin = join(project, 'node_modules', '.bin', 'directivebench');
const dataDir = join(work, 'data');

step('help and version');
const help = run(bin, ['--help'], { cwd: work });
check(help.includes('Usage: directivebench'), '--help prints usage');
const version = run(bin, ['--version'], { cwd: work }).trim();
check(version === manifest.version, `--version prints ${version}`);

step('demo (headless mock benchmark)');
const demo = run(bin, ['--data-dir', dataDir, 'demo'], { cwd: work });
check(/Verdict:\s+improved/.test(demo), 'demo reports an improved verdict');
check(demo.includes('Mock agent — not an AI evaluation'), 'demo labels mock results');

step('serve');
const port = await new Promise((resolvePort) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolvePort(free));
  });
});
const child = spawn(bin, ['--data-dir', dataDir, 'serve', '--no-open', '--port', String(port)], {
  cwd: work,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (c) => (output += c));
child.stderr.on('data', (c) => (output += c));
const base = `http://127.0.0.1:${port}`;
let healthy = false;
for (let i = 0; i < 120 && !healthy; i += 1) {
  try {
    const response = await fetch(`${base}/api/health`);
    healthy = response.ok && (await response.json()).database === 'ready';
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
check(healthy, `GET ${base}/api/health is ready`);
if (healthy) {
  const results = await (await fetch(`${base}/results`)).text();
  const runPath = /\/results\/run_[A-Za-z0-9_-]+/.exec(results)?.[0];
  check(Boolean(runPath), '/results lists the demo run');
  if (runPath) {
    const detail = await (await fetch(`${base}${runPath}`)).text();
    check(/data-testid="verdict">improved/.test(detail), 'run detail shows the persisted verdict');
  }
  // fetch() does not allow overriding Host, so use node:http directly.
  const rebindingStatus = await new Promise((resolveStatus) => {
    request(
      { host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode);
      },
    ).end();
  });
  check(rebindingStatus === 403, 'foreign Host header is rejected (DNS-rebinding protection)');
}
child.kill('SIGTERM');
const exitCode = await new Promise((r) => child.once('exit', (code) => r(code)));
check(exitCode === 0, `serve exited cleanly after SIGTERM (code ${exitCode})`);
if (exitCode !== 0 || !healthy) console.log(output);

console.log(
  failures.length ? `\n${failures.length} check(s) failed` : '\nPackaging verification passed',
);
console.log(`Artifacts kept in ${work}`);
process.exit(failures.length ? 1 : 0);

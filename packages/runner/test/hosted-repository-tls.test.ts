import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, type DatabaseHandle } from '@directivebench/database';
import { NOT_FOUND_OR_NOT_PUBLIC, registerHostedUrl } from '../src/index';

/**
 * Hosted git over real TLS, on loopback only (issue #61): an HTTPS server with a self-signed
 * certificate stands in for a TLS-intercepting proxy's CA. It answers every request with 401, as
 * github.com does for a missing or private repository, so git reaching it at all proves the
 * handshake — and therefore the certificate check — passed.
 */
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const describeTls = describe.skipIf(!hasOpenssl || process.platform === 'win32');

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const LOCATION = 'https://github.com/acme/skills';

let dir: string;
let handle: DatabaseHandle;
let server: Server;
let requests: number;

/** A self-signed certificate for 127.0.0.1 (its own CA) and its key, as PEM files. */
function selfSigned(name: string): { cert: string; key: string } {
  const cert = join(dir, `${name}.pem`);
  const key = join(dir, `${name}-key.pem`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { cert, key };
}

let proxyCa: { cert: string; key: string };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'directivebench-hosted-tls-'));
  handle = openDatabase(join(dir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
  proxyCa = selfSigned('proxy-ca');
  requests = 0;
  server = createServer(
    { cert: readFileSync(proxyCa.cert), key: readFileSync(proxyCa.key) },
    (_request, response) => {
      requests += 1;
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' }).end();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function register(env: NodeJS.ProcessEnv) {
  const { port } = server.address() as AddressInfo;
  return registerHostedUrl(handle, LOCATION, {
    env: { PATH: process.env.PATH, ...env },
    signal: new AbortController().signal,
    cacheDir: join(dir, 'cache'),
    // The production protocol, HTTPS, to a loopback server instead of github.com.
    transport: { remoteUrl: () => `https://127.0.0.1:${port}/acme/skills.git`, protocol: 'https' },
  });
}

describeTls('hosted git and custom CA certificates', () => {
  // Whether `SSL_CERT_FILE`/`SSL_CERT_DIR` could matter depends on git's TLS backend (OpenSSL
  // builds only); the guard that no such variable reaches git is the environment test in
  // `hosted-git.test.ts`.
  it('verifies TLS: an unknown CA fails, whatever other TLS variables the environment holds', async () => {
    const result = await register({
      GIT_SSL_NO_VERIFY: '1',
      GIT_SSL_CAPATH: dir,
      SSL_CERT_FILE: proxyCa.cert,
      SSL_CERT_DIR: dir,
      NODE_EXTRA_CA_CERTS: proxyCa.cert,
      CURL_CA_BUNDLE: proxyCa.cert,
    });
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
    expect(result.ok ? '' : result.message).toMatch(/certificate/i);
    expect(requests).toBe(0);
  });

  it('trusts the CA bundle named by GIT_SSL_CAINFO, through a symlink, and only that bundle', async () => {
    symlinkSync(proxyCa.cert, join(dir, 'ca-link.pem'));
    expect(await register({ GIT_SSL_CAINFO: join(dir, 'ca-link.pem') })).toEqual({
      ok: false,
      code: 'auth-required',
      message: NOT_FOUND_OR_NOT_PUBLIC,
    });
    expect(requests).toBeGreaterThan(0);
    // A bundle that holds another CA does not vouch for the server: verification still fails.
    const other = selfSigned('other-ca');
    const before = requests;
    expect(await register({ GIT_SSL_CAINFO: other.cert })).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
    expect(requests).toBe(before);
  });

  it('refuses a CA bundle setting it cannot use instead of falling back to the default bundle', async () => {
    expect(await register({ GIT_SSL_CAINFO: dir })).toMatchObject({
      ok: false,
      code: 'git-failed',
      message: expect.stringContaining('GIT_SSL_CAINFO must be the absolute path') as string,
    });
    expect(requests).toBe(0);
  });
});

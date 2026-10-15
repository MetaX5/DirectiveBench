import { describe, expect, it } from 'vitest';
import { isSecretEnvName, redactSecrets } from '../src/redact';

describe('redactSecrets', () => {
  it('removes known secret values and token shapes', () => {
    const text = [
      'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'openai: sk-proj-abcdefghijklmnopqrstuvwxyz',
      'gh: ghp_abcdefghijklmnopqrstuvwxyz0123',
      'pat: github_pat_abcdefghijklmnopqrstuvwxyz',
      'gitlab: glpat-abcdefghijklmnopqrstu',
      'slack: xoxb-1234567890-abcdef',
      'aws: AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abc.def.ghi',
      'custom: my-super-secret-value',
    ].join('\n');
    const redacted = redactSecrets(text, ['my-super-secret-value']);
    expect(redacted).not.toMatch(
      /sk-ant-api03|sk-proj|ghp_|github_pat_|glpat-|xoxb-|AKIA|abc\.def|my-super-secret/,
    );
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('custom: [REDACTED]');
    expect(redacted).toContain('aws: [REDACTED]');
  });

  it('keeps the markers of a private key block and removes its body', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAsecretmaterial',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redactSecrets(`before\n${key}\nafter`)).toBe(
      'before\n-----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY-----\nafter',
    );
  });

  it('ignores known secrets shorter than eight characters', () => {
    expect(redactSecrets('the value is short', ['short', ''])).toBe('the value is short');
  });

  it('leaves text without secrets unchanged', () => {
    expect(redactSecrets('nothing to see here: sk-short')).toBe('nothing to see here: sk-short');
  });
});

describe('isSecretEnvName', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'client_secret',
    'DB_PASSWORD',
    'FTP_PASSWD',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'BASIC_AUTH',
    'SESSION_COOKIE',
  ])('treats %s as a secret', (name) => {
    expect(isSecretEnvName(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'LANG', 'NODE_ENV'])('does not treat %s as a secret', (name) => {
    expect(isSecretEnvName(name)).toBe(false);
  });
});

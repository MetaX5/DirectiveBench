const REDACTED = '[REDACTED]';

/** Token shapes of common providers. Patterns are intentionally conservative. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(authorization:\s*bearer\s+)[^\s"']+/gi,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
];

/**
 * Removes secrets from text before it is persisted in traces, logs or reports.
 * `knownSecrets` are exact values (e.g. configured API keys) that must never appear.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) result = result.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...groups: unknown[]) => {
      const prefix = groups[0];
      if (typeof prefix === 'string' && match.startsWith(prefix) && prefix !== match) {
        const suffix = groups[1];
        return typeof suffix === 'string' && match.endsWith(suffix) && suffix !== match
          ? `${prefix}${REDACTED}${suffix}`
          : `${prefix}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return result;
}

/** Environment variable names that are treated as secrets and never forwarded or logged. */
export function isSecretEnvName(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(name);
}

/** What `redactSecrets` puts in place of a secret. */
export const REDACTION_MARKER = '[REDACTED]';

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
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Replaces the body of every private-key block, keeping its markers. Equivalent to replacing
 * `BEGIN[\s\S]*?END` globally, but linear: that regex rescans to the end of the text from every
 * BEGIN marker without an END after it, which is quadratic in the number of such markers. Once a
 * marker has no END after it, no later marker has one either, so the scan stops there.
 */
function redactPrivateKeys(text: string): string {
  let result = '';
  let from = 0;
  for (;;) {
    PRIVATE_KEY_BEGIN.lastIndex = from;
    const begin = PRIVATE_KEY_BEGIN.exec(text);
    if (!begin) break;
    PRIVATE_KEY_END.lastIndex = PRIVATE_KEY_BEGIN.lastIndex;
    const end = PRIVATE_KEY_END.exec(text);
    if (!end) break;
    result += `${text.slice(from, begin.index)}${begin[0]}${REDACTION_MARKER}${end[0]}`;
    from = PRIVATE_KEY_END.lastIndex;
  }
  return result + text.slice(from);
}

/**
 * Removes secrets from text before it is persisted in traces, logs or reports.
 * `knownSecrets` are exact values (e.g. configured API keys) that must never appear.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) result = result.split(secret).join(REDACTION_MARKER);
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...groups: unknown[]) => {
      const prefix = groups[0];
      return typeof prefix === 'string' && match.startsWith(prefix) && prefix !== match
        ? `${prefix}${REDACTION_MARKER}`
        : REDACTION_MARKER;
    });
  }
  return redactPrivateKeys(result);
}

/** Environment variable names that are treated as secrets and never forwarded or logged. */
export function isSecretEnvName(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(name);
}

/**
 * An error or message as stored: each U+0000 becomes U+FFFD (issue 265). Such text may quote an
 * agent, a process or the file system, and the database refuses text holding NUL
 * (`NulInTextError`), so a failure is still recorded instead of failing in turn.
 */
export function storedMessage(text: string): string;
export function storedMessage(text: string | null): string | null;
export function storedMessage(text: string | null): string | null {
  return text === null ? null : text.replaceAll('\0', '�');
}

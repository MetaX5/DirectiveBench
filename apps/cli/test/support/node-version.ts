/**
 * Pretends the process runs on another Node.js version; returns a function that restores the
 * original. `process.versions` is a configurable data property, so it can be replaced.
 */
export function fakeNodeVersion(version: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'versions');
  Object.defineProperty(process, 'versions', {
    ...original,
    value: { ...process.versions, node: version },
  });
  return () => {
    if (original) Object.defineProperty(process, 'versions', original);
  };
}

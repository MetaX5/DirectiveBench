import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { classifyArtifactPath, parseArtifactFile, slugify, type ParsedArtifact } from './artifacts';
import { hashManifest, sha256 } from './hash';
import type { ArtifactFile } from './models';

export const ARTIFACT_LIMITS = { maxFiles: 200, maxTotalBytes: 1024 * 1024 };

export interface LoadedArtifact {
  slug: string;
  parsed: ParsedArtifact;
  /** Repository-relative path of the artifact (skill directory or single file). */
  path: string;
  /** Primary file relative to the artifact root. */
  primaryFile: string;
  files: ArtifactFile[];
  contentHash: string;
  warnings: string[];
}

async function collectFiles(root: string, warnings: string[]): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let total = 0;
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    // UTF-16 code-unit order, independent of the order the file system returns entries in.
    entries.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
    for (const entry of entries) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link ${rel}`);
      } else if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(abs);
        if (bytes.includes(0)) {
          warnings.push(`Skipped binary file ${rel}`);
          continue;
        }
        total += bytes.length;
        if (files.length >= ARTIFACT_LIMITS.maxFiles || total > ARTIFACT_LIMITS.maxTotalBytes) {
          throw new Error(
            `Artifact exceeds limits (${ARTIFACT_LIMITS.maxFiles} files / ${ARTIFACT_LIMITS.maxTotalBytes} bytes): ${root}`,
          );
        }
        files.push({
          path: rel,
          sha256: sha256(bytes),
          size: bytes.length,
          content: bytes.toString('utf8'),
        });
      }
    }
  }
  await walk(root, '');
  return files;
}

/**
 * Reads one artifact from a local source. `relPath` is the primary file relative to
 * `sourceRoot` (e.g. `.claude/skills/pdf/SKILL.md`). For skills the whole skill directory
 * (supporting scripts, references, assets) becomes part of the version; nothing is executed.
 */
export async function loadLocalArtifact(
  sourceRoot: string,
  relPath: string,
): Promise<LoadedArtifact> {
  const classification = classifyArtifactPath(relPath);
  if (!classification) throw new Error(`Not a recognised artifact path: ${relPath}`);
  const primaryAbs = join(sourceRoot, relPath);
  const info = await lstat(primaryAbs);
  if (!info.isFile()) throw new Error(`Artifact file is not a regular file: ${relPath}`);
  const content = await readFile(primaryAbs, 'utf8');
  const parsed = parseArtifactFile(relPath, content);
  const warnings = [...parsed.warnings];

  let files: ArtifactFile[];
  let path: string;
  let primaryFile: string;
  if (classification.rootDir !== null) {
    path = classification.rootDir;
    files = await collectFiles(join(sourceRoot, classification.rootDir), warnings);
    primaryFile = posix.relative(classification.rootDir || '.', relPath.replaceAll('\\', '/'));
  } else {
    path = relPath.replaceAll('\\', '/');
    primaryFile = posix.basename(path);
    files = [
      { path: primaryFile, sha256: sha256(content), size: Buffer.byteLength(content), content },
    ];
  }

  return {
    slug: slugify(parsed.name),
    parsed,
    path,
    primaryFile,
    files,
    contentHash: hashManifest(files),
    warnings,
  };
}

import { z } from 'zod';

/** Longest repository URL the registration field accepts. */
export const MAX_REPOSITORY_URL_LENGTH = 2048;

/** The only host a URL can be registered for so far (SPEC-104 FR-104-02, D06). */
export const GITHUB_HOST = 'github.com';

/** Why a repository URL was rejected (SPEC-104 §8 `RepositoryErrorCode`, URL subset). */
export type RepositoryUrlErrorCode = 'invalid-url' | 'credentials-in-url' | 'unsupported-provider';

export type RepositoryUrlParse =
  | {
      ok: true;
      provider: 'github';
      /**
       * Normalised location (FR-104-04): `https://github.com/<owner>/<repo>` in lower case — GitHub
       * owner and repository names are case-insensitive — without credentials, `.git` or `/`.
       */
      location: string;
      /** Default name (FR-104-06): `<owner>/<repo>` as entered. */
      name: string;
    }
  | { ok: false; code: RepositoryUrlErrorCode; message: string };

/**
 * GitHub account names: letters, digits and hyphens, not starting with a hyphen, at most 39
 * characters. Repository names: letters, digits, `.`, `_` and `-`, at most 100 characters.
 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** A scheme (`https://`, `file://`, `ssh://`) or an SCP-like SSH address (`git@host:path`). */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\s@]+@[^/\s:]+:)/i;

/**
 * Whether the registration field holds a URL rather than a local path: anything with a scheme or
 * in SSH's `user@host:path` form. Paths are absolute or start with `~`, so they never match.
 */
export function looksLikeRepositoryUrl(input: string): boolean {
  return URL_LIKE.test(input.trim());
}

/** The explanation shown for a URL with a user name, password or token (FR-104-05). */
export const CREDENTIALS_IN_URL_MESSAGE =
  'The URL contains credentials (a user name, password or token). Remove them and enter https://github.com/<owner>/<repo>: DirectiveBench reads public GitHub repositories without credentials and never stores them.';

function invalid(message: string): RepositoryUrlParse {
  return { ok: false, code: 'invalid-url', message };
}

const EXPECTED_SHAPE = 'Enter a GitHub repository URL such as https://github.com/<owner>/<repo>.';

/**
 * Parses a repository URL (SPEC-104 FR-104-02, FR-104-04, FR-104-05). Only public GitHub
 * repositories over HTTPS are supported so far (D06): `https://github.com/<owner>/<repo>`, with an
 * optional `.git` and trailing `/`. Credentials are rejected before anything else is checked, so no
 * message ever repeats them; SSH, `file://`, other hosts, ports, queries, fragments and deeper
 * paths (`/tree/main`) are rejected with a hint.
 */
export function parseRepositoryUrl(input: string): RepositoryUrlParse {
  const value = input.trim();
  if (value.length > MAX_REPOSITORY_URL_LENGTH) {
    return invalid(`The URL is longer than ${MAX_REPOSITORY_URL_LENGTH} characters.`);
  }
  // Before parsing: `new URL` rejects some credential-bearing inputs (a space in the password),
  // and an SCP-like SSH address has its user in front of the host.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority?.includes('@')) {
    return { ok: false, code: 'credentials-in-url', message: CREDENTIALS_IN_URL_MESSAGE };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return {
      ok: false,
      code: 'unsupported-provider',
      message:
        'SSH addresses are not supported yet. Enter the https://github.com/<owner>/<repo> URL.',
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(`This is not a valid URL. ${EXPECTED_SHAPE}`);
  }
  if (url.protocol === 'file:') {
    return invalid(
      'Enter a local directory as a path (for example /home/you/project), not as a file:// URL.',
    );
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'unsupported-provider',
      message: `Only https:// URLs are supported. ${EXPECTED_SHAPE}`,
    };
  }
  if (url.hostname !== GITHUB_HOST) {
    return {
      ok: false,
      code: 'unsupported-provider',
      message: `Only public repositories on ${GITHUB_HOST} can be registered by URL so far. ${EXPECTED_SHAPE}`,
    };
  }
  if (url.port !== '' || url.search !== '' || url.hash !== '') {
    return invalid(`The URL has a port, query or fragment. ${EXPECTED_SHAPE}`);
  }
  const segments = url.pathname.replace(/\/$/, '').split('/').slice(1);
  const [owner = '', rawRepository = ''] = segments;
  const repository = rawRepository.replace(/\.git$/i, '');
  if (
    segments.length !== 2 ||
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository === '.' ||
    repository === '..' ||
    // GitHub refuses names ending in `.git`; accepting one would make the location ambiguous.
    /\.git$/i.test(repository)
  ) {
    return invalid(`This URL does not name a repository. ${EXPECTED_SHAPE}`);
  }
  return {
    ok: true,
    provider: 'github',
    location: `https://${GITHUB_HOST}/${owner.toLowerCase()}/${repository.toLowerCase()}`,
    name: `${owner}/${repository}`,
  };
}

/**
 * A normalised hosted location as stored and carried in a registration job: it parses and is its
 * own normal form, so a job payload can never hold credentials, another host or an unnormalised
 * URL.
 */
export const hostedRepositoryLocationSchema = z
  .string()
  .max(MAX_REPOSITORY_URL_LENGTH)
  .refine(
    (value) => {
      const parsed = parseRepositoryUrl(value);
      return parsed.ok && parsed.location === value;
    },
    { message: 'The location is not a normalised https://github.com/<owner>/<repo> URL.' },
  );

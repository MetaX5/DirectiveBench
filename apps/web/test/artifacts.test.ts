import { describe, expect, it } from 'vitest';
import type { StoredArtifactFile } from '@directivebench/database';
import {
  MAX_FILE_PARAM_LENGTH,
  MAX_SEARCH_LENGTH,
  artifactHref,
  buildFileTree,
  formatBytes,
  invalidParamsNotice,
  parseArtifactDetailParams,
  parseArtifactId,
  parseArtifactListParams,
  rawViewNotice,
  repositoriesLabel,
  repositoryOptions,
  selectContent,
} from '../lib/artifacts';

function file(path: string): StoredArtifactFile {
  return { path, sha256: 'h', size: 1, content: path };
}

describe('parseArtifactListParams', () => {
  it('keeps valid filters and treats empty values as absent', () => {
    expect(
      parseArtifactListParams({
        q: 'review',
        type: 'skill',
        category: 'code-quality',
        repository: 'repo_AbC-12_x',
      }),
    ).toEqual({
      value: { q: 'review', type: 'skill', category: 'code-quality', repository: 'repo_AbC-12_x' },
      invalid: [],
    });
    expect(parseArtifactListParams({ q: '', type: '', other: 'x' })).toEqual({
      value: {},
      invalid: [],
    });
  });

  it('drops invalid and repeated values and names them', () => {
    expect(
      parseArtifactListParams({
        q: 'x'.repeat(MAX_SEARCH_LENGTH + 1),
        type: 'script',
        category: ['a', 'b'],
        repository: "repo_x' or 1=1",
      }),
    ).toEqual({ value: {}, invalid: ['q', 'type', 'category', 'repository'] });
    expect(parseArtifactListParams({ category: 'Bad Slug', repository: 'art_x' }).invalid).toEqual([
      'category',
      'repository',
    ]);
  });
});

describe('invalidParamsNotice', () => {
  it('says which parameters were ignored', () => {
    expect(invalidParamsNotice([])).toBeNull();
    expect(invalidParamsNotice(['type'])).toBe('Ignored invalid value in the URL: type.');
    expect(invalidParamsNotice(['type', 'tab'])).toBe(
      'Ignored invalid values in the URL: type, tab.',
    );
  });
});

describe('repositoriesLabel', () => {
  it('shows the first repository and how many more', () => {
    expect(repositoriesLabel([])).toBe('—');
    expect(repositoriesLabel([{ name: 'team' }])).toBe('team');
    expect(repositoriesLabel([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toBe('a +2');
  });
});

describe('repositoryOptions', () => {
  it('adds the location only to names two repositories share', () => {
    expect(
      repositoryOptions([
        { id: 'repo_1', name: 'skills', location: '/a/skills' },
        { id: 'repo_2', name: 'skills', location: '/b/skills' },
        { id: 'repo_3', name: 'rules', location: '/c/rules' },
      ]),
    ).toEqual([
      { value: 'repo_1', label: 'skills (/a/skills)' },
      { value: 'repo_2', label: 'skills (/b/skills)' },
      { value: 'repo_3', label: 'rules' },
    ]);
  });
});

describe('parseArtifactDetailParams', () => {
  it('defaults to the Overview tab', () => {
    expect(parseArtifactDetailParams({})).toEqual({ value: { tab: 'overview' }, invalid: [] });
  });

  it('keeps a valid tab, version and file', () => {
    expect(
      parseArtifactDetailParams({ tab: 'content', version: '12', file: 'scripts/run.sh' }),
    ).toEqual({ value: { tab: 'content', version: 12, file: 'scripts/run.sh' }, invalid: [] });
  });

  it('drops invalid values and names them', () => {
    expect(
      parseArtifactDetailParams({
        tab: 'secrets',
        version: '0',
        file: 'x'.repeat(MAX_FILE_PARAM_LENGTH + 1),
      }),
    ).toEqual({ value: { tab: 'overview' }, invalid: ['tab', 'version', 'file'] });
    expect(parseArtifactDetailParams({ version: '1.5', tab: ['content'] }).invalid).toEqual([
      'tab',
      'version',
    ]);
    expect(parseArtifactDetailParams({ version: '1234567890' }).invalid).toEqual(['version']);
  });
});

describe('parseArtifactId', () => {
  it('accepts artifact ids only', () => {
    expect(parseArtifactId('art_AbC-1_x')).toBe('art_AbC-1_x');
    for (const id of [
      'does-not-exist',
      'art_',
      'repo_x',
      "art_x' or 1=1",
      `art_${'x'.repeat(65)}`,
    ]) {
      expect(parseArtifactId(id), id).toBeNull();
    }
  });
});

describe('artifactHref', () => {
  it('builds detail links with only the parameters given', () => {
    expect(artifactHref('art_1')).toBe('/artifacts/art_1');
    expect(artifactHref('art_1', { tab: 'overview' })).toBe('/artifacts/art_1');
    expect(artifactHref('art_1', { tab: 'versions' })).toBe('/artifacts/art_1?tab=versions');
    expect(artifactHref('art/1', { tab: 'content', version: 2, file: 'a b/&c.md' })).toBe(
      '/artifacts/art%2F1?tab=content&version=2&file=a+b%2F%26c.md',
    );
  });
});

describe('selectContent', () => {
  const versions = [
    { version: 2, primaryFile: 'SKILL.md', files: [file('scripts/run.sh'), file('SKILL.md')] },
    { version: 1, primaryFile: 'missing.md', files: [file('README.md')] },
  ];

  it('selects the latest version and its primary file by default', () => {
    expect(selectContent(versions, {})).toEqual({
      version: versions[0],
      file: file('SKILL.md'),
      notices: [],
    });
  });

  it('selects the requested version and file', () => {
    expect(selectContent(versions, { version: 2, file: 'scripts/run.sh' })).toEqual({
      version: versions[0],
      file: file('scripts/run.sh'),
      notices: [],
    });
    // A primary file missing from the manifest falls back to the first file.
    expect(selectContent(versions, { version: 1 }).file).toEqual(file('README.md'));
  });

  it('falls back with a notice when the version or file does not exist', () => {
    expect(selectContent(versions, { version: 9, file: 'nope.md' })).toEqual({
      version: versions[0],
      file: file('SKILL.md'),
      notices: [
        'Version 9 does not exist; showing the latest version.',
        'Version 2 has no file "nope.md"; showing its primary file.',
      ],
    });
  });

  it('returns nothing to show for an artifact without versions or files', () => {
    expect(selectContent([], { version: 1 })).toEqual({
      version: null,
      file: null,
      notices: ['Version 1 does not exist; showing the latest version.'],
    });
    const empty = { version: 1, primaryFile: 'SKILL.md', files: [] };
    expect(selectContent([empty], {})).toEqual({ version: empty, file: null, notices: [] });
  });
});

describe('buildFileTree', () => {
  it('nests files under directories, directories first, sorted by code unit', () => {
    expect(
      buildFileTree([
        'SKILL.md',
        'scripts/run.sh',
        'references/b.md',
        'references/a.md',
        'Zeta.md',
        'scripts/lib/util.py',
      ]),
    ).toEqual([
      {
        name: 'references',
        path: 'references',
        children: [
          { name: 'a.md', path: 'references/a.md' },
          { name: 'b.md', path: 'references/b.md' },
        ],
      },
      {
        name: 'scripts',
        path: 'scripts',
        children: [
          {
            name: 'lib',
            path: 'scripts/lib',
            children: [{ name: 'util.py', path: 'scripts/lib/util.py' }],
          },
          { name: 'run.sh', path: 'scripts/run.sh' },
        ],
      },
      { name: 'SKILL.md', path: 'SKILL.md' },
      { name: 'Zeta.md', path: 'Zeta.md' },
    ]);
  });

  it('keeps a file and a directory of the same name apart', () => {
    expect(buildFileTree(['a', 'a/b', 'a'])).toEqual([
      { name: 'a', path: 'a', children: [{ name: 'b', path: 'a/b' }] },
      { name: 'a', path: 'a' },
    ]);
  });
});

describe('formatBytes', () => {
  it('uses B, KB and MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('rawViewNotice', () => {
  it('explains carriage returns the browser cannot show', () => {
    expect(rawViewNotice('a\nb')).toBeNull();
    expect(rawViewNotice('a\r\nb')).toContain('CR or CRLF line endings');
    expect(rawViewNotice('a\rb')).toContain('CR or CRLF line endings');
  });
});

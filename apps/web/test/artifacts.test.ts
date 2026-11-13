import { describe, expect, it } from 'vitest';
import type { StoredArtifactFile } from '@directivebench/database';
import {
  MAX_FILE_PARAM_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_SLUG_PARAM_LENGTH,
  ARTIFACT_LIST_PARAMS,
  artifactHref,
  artifactListFields,
  buildFileTree,
  dropUnknownFilters,
  filterNotice,
  formatBytes,
  invalidParamsNotice,
  parseArtifactDetailParams,
  parseArtifactId,
  parseArtifactListForm,
  parseArtifactListParams,
  rawViewNotice,
  missingNote,
  occurrenceStatusLabel,
  occurrenceVersionLabel,
  possibleDuplicatesCard,
  repositoriesLabel,
  SAME_CONTENT_NOTE,
  searchPrefix,
  repositoryOptions,
  selectContent,
} from '../lib/artifacts';

function file(path: string): StoredArtifactFile {
  return { path, sha256: 'h', size: 1, content: path };
}

describe('artifactListFields and parseArtifactListForm (SPEC-124 bulk form)', () => {
  const full = {
    q: '  Ärger ',
    type: 'rule',
    category: 'client-a',
    repository: 'repo_abc',
  } as const;

  function formOf(fields: { name: string; value: string }[]): FormData {
    const data = new FormData();
    for (const { name, value } of fields) data.append(name, value);
    return data;
  }

  it('posts every key of the list, empty when unset, and parses back to the same filter', () => {
    // A filter added to the list later is posted too (§11.4 implementer notes).
    expect(Object.keys(full).sort()).toEqual([...ARTIFACT_LIST_PARAMS].sort());
    expect(artifactListFields(full).map((f) => f.name)).toEqual(ARTIFACT_LIST_PARAMS);
    expect(artifactListFields({}).map((f) => f.value)).toEqual(['', '', '', '']);
    for (const filter of [full, {}, { type: 'skill' as const }]) {
      expect(parseArtifactListForm(formOf(artifactListFields(filter)))).toEqual({
        value: filter,
        invalid: [],
      });
    }
    expect(parseArtifactListForm(new FormData())).toEqual({ value: {}, invalid: [] });
  });

  it('marks invalid, repeated and file fields invalid instead of dropping them silently', () => {
    const data = formOf([
      { name: 'type', value: 'nope' },
      { name: 'category', value: 'a' },
      { name: 'category', value: 'b' },
    ]);
    data.append('repository', new Blob(['x']), 'x.txt');
    expect(parseArtifactListForm(data)).toEqual({
      value: {},
      invalid: ['type', 'category', 'repository'],
    });
  });
});

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
    for (const category of ['-a', 'a-', 'a--b', 'x'.repeat(MAX_SLUG_PARAM_LENGTH + 1)]) {
      expect(parseArtifactListParams({ category }).invalid, category).toEqual(['category']);
    }
    // The longest slug a category can have (SPEC-124 A6) is still a valid value.
    expect(MAX_SLUG_PARAM_LENGTH).toBe(64);
    const long = 'x'.repeat(MAX_SLUG_PARAM_LENGTH);
    expect(parseArtifactListParams({ category: long }).value).toEqual({ category: long });
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

describe('missingNote (SPEC-125 FR-125-09)', () => {
  it('says when the artifact was last found, what is kept and how it comes back', () => {
    expect(missingNote({ lastFoundAt: '2026-10-28T12:00:00.000Z' })).toBe(
      'Missing: no registered repository contained this artifact in its last scan. Last found on 28 Oct 2026, 12:00 UTC. Its versions, categories, notes and benchmark results are kept, and it becomes active again when a scan finds it at the same path.',
    );
  });

  it('says its repositories were removed when no occurrence is left, without a dash placeholder', () => {
    const note = missingNote({ lastFoundAt: null });
    expect(note).toBe(
      'Missing: the repositories it was found in were removed. Its versions, categories, notes and benchmark results are kept.',
    );
    expect(note).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('occurrenceStatusLabel (SPEC-125 FR-125-10)', () => {
  it('shows a removed occurrence as missing and never the raw value', () => {
    expect(occurrenceStatusLabel('active')).toBe('active');
    expect(occurrenceStatusLabel('removed')).toBe('missing');
  });
});

describe('occurrenceVersionLabel (SPEC-126 UD-3, F4, F5)', () => {
  it('names the version each occurrence holds and marks one older than the latest', () => {
    expect(occurrenceVersionLabel(3, 3, 'review')).toEqual({
      label: 'v3',
      accessibleName: 'v3 of review',
      older: false,
    });
    expect(occurrenceVersionLabel(1, 3, 'review')).toEqual({
      label: 'v1',
      accessibleName: 'v1 of review',
      older: true,
    });
  });
});

describe('possibleDuplicatesCard (SPEC-126 UD-5, §11.4 G7 to G12)', () => {
  const duplicate = (
    n: number,
    overrides: Partial<{ activeOccurrences: number; sameLatestContent: boolean }> = {},
  ) => ({
    id: `art_${n}`,
    slug: `review-${n}`,
    name: 'review',
    activeOccurrences: 1,
    repositories: [
      { id: 'repo_a', name: 'acme/agent-skills' },
      { id: 'repo_b', name: 'client-b' },
    ],
    sameLatestContent: false,
    ...overrides,
  });
  const review = { name: 'review', type: 'skill' } as const;

  it('is null without duplicates (G12)', () => {
    expect(possibleDuplicatesCard(review, { items: [], total: 0 })).toBeNull();
  });

  it('lists the slug, the active repositories or missing, and the content (G7 to G9)', () => {
    expect(
      possibleDuplicatesCard(review, {
        items: [duplicate(2), duplicate(3, { activeOccurrences: 0, sameLatestContent: true })],
        total: 2,
      }),
    ).toEqual({
      rows: [
        {
          id: 'art_2',
          slug: 'review-2',
          href: '/artifacts/art_2',
          repositories: 'acme/agent-skills, client-b',
          content: 'Different content',
        },
        {
          id: 'art_3',
          slug: 'review-3',
          href: '/artifacts/art_3',
          repositories: null,
          content: 'Same latest content',
        },
      ],
      more: null,
      note: SAME_CONTENT_NOTE,
    });
  });

  it('shows the note only when a listed row has the same latest content (G11)', () => {
    expect(possibleDuplicatesCard(review, { items: [duplicate(2)], total: 1 })?.note).toBeNull();
  });

  it('says how many are not listed and links a search narrowed by type (G10)', () => {
    const items = Array.from({ length: 20 }, (_, i) => duplicate(i + 2));
    expect(possibleDuplicatesCard(review, { items, total: 25 })?.more).toEqual({
      text: '5 more are not listed.',
      linkText: 'Search Artifacts for "review"',
      href: '/artifacts?q=review&type=skill',
    });
    expect(possibleDuplicatesCard(review, { items, total: 21 })?.more?.text).toBe(
      '1 more is not listed.',
    );
    const rule = { name: 'a b&c', type: 'rule' } as const;
    expect(possibleDuplicatesCard(rule, { items, total: 21 })?.more).toMatchObject({
      linkText: 'Search Artifacts for "a b&c"',
      href: '/artifacts?q=a+b%26c&type=rule',
    });
  });

  it('keeps every app string free of en and em dashes (AGENTS.md §7)', () => {
    const card = possibleDuplicatesCard(review, {
      items: [duplicate(2, { sameLatestContent: true })],
      total: 3,
    });
    expect(JSON.stringify(card)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('searchPrefix (SPEC-126 §11.4 G10)', () => {
  it('keeps a name within MAX_SEARCH_LENGTH', () => {
    expect(searchPrefix('review')).toBe('review');
    expect(searchPrefix('')).toBe('');
    const exact = 'x'.repeat(MAX_SEARCH_LENGTH);
    expect(searchPrefix(exact)).toBe(exact);
  });

  it('cuts a longer name at a code point boundary, so the list accepts it', () => {
    expect(searchPrefix('y'.repeat(MAX_SEARCH_LENGTH + 5))).toBe('y'.repeat(MAX_SEARCH_LENGTH));
    // A surrogate pair straddling the limit is dropped whole.
    const straddling = `${'z'.repeat(MAX_SEARCH_LENGTH - 1)}\u{1F600}tail`;
    expect(searchPrefix(straddling)).toBe('z'.repeat(MAX_SEARCH_LENGTH - 1));
    const pairInside = `${'z'.repeat(MAX_SEARCH_LENGTH - 2)}\u{1F600}tail`;
    expect(searchPrefix(pairInside)).toBe(`${'z'.repeat(MAX_SEARCH_LENGTH - 2)}\u{1F600}`);
    const cut = searchPrefix(straddling);
    expect(parseArtifactListParams({ q: cut }).invalid).toEqual([]);
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
  it('adds the provider and location only to names two repositories share', () => {
    expect(
      repositoryOptions([
        { id: 'repo_1', name: 'skills', provider: 'local-directory', location: '/a/skills' },
        {
          id: 'repo_2',
          name: 'skills',
          provider: 'github',
          location: 'https://github.com/b/skills',
        },
        { id: 'repo_3', name: 'rules', provider: 'local-git', location: '/c/rules' },
      ]),
    ).toEqual([
      { value: 'repo_1', label: 'skills (Local directory, /a/skills)' },
      { value: 'repo_2', label: 'skills (GitHub, https://github.com/b/skills)' },
      { value: 'repo_3', label: 'rules' },
    ]);
  });

  it('tells apart one directory registered as a local directory and as local Git (E4)', () => {
    const labels = repositoryOptions([
      { id: 'repo_1', name: 'skills', provider: 'local-directory', location: '/a/skills' },
      { id: 'repo_2', name: 'skills', provider: 'local-git', location: '/a/skills' },
    ]).map((option) => option.label);
    expect(labels).toEqual([
      'skills (Local directory, /a/skills)',
      'skills (Local Git, /a/skills)',
    ]);
  });
});

describe('dropUnknownFilters (issue 216, E2 and E5)', () => {
  const known = { repositoryIds: ['repo_known'], categorySlugs: ['security'] };

  it('keeps a filter that names a registered repository and an existing category', () => {
    expect(
      dropUnknownFilters({ q: 'x', repository: 'repo_known', category: 'security' }, known),
    ).toEqual({
      value: { q: 'x', repository: 'repo_known', category: 'security' },
      unknown: [],
    });
  });

  it('drops a repository that is not registered', () => {
    expect(dropUnknownFilters({ type: 'skill', repository: 'repo_gone' }, known)).toEqual({
      value: { type: 'skill' },
      unknown: ['repository'],
    });
  });

  it('drops a category that does not exist', () => {
    expect(dropUnknownFilters({ category: 'no-such-category' }, known)).toEqual({
      value: {},
      unknown: ['category'],
    });
  });

  it('drops both, in the fixed parameter order', () => {
    expect(
      dropUnknownFilters({ category: 'nope', repository: 'repo_gone' }, known).unknown,
    ).toEqual(['category', 'repository']);
  });

  it('leaves an empty filter alone', () => {
    expect(dropUnknownFilters({}, known)).toEqual({ value: {}, unknown: [] });
  });
});

describe('filterNotice (issue 216, E3 and E5)', () => {
  it('is null when nothing was ignored', () => {
    expect(filterNotice([], [])).toBeNull();
  });

  it('keeps the invalid-value sentence', () => {
    expect(filterNotice(['type'], [])).toBe('Ignored invalid value in the URL: type.');
  });

  it('says why an unknown repository or category was ignored', () => {
    expect(filterNotice([], ['repository'])).toBe(
      'Ignored the repository in the URL: it is not registered.',
    );
    expect(filterNotice([], ['category'])).toBe(
      'Ignored the category in the URL: it does not exist.',
    );
  });

  it('puts the sentences one after another', () => {
    expect(filterNotice(['type'], ['category', 'repository'])).toBe(
      'Ignored invalid value in the URL: type. Ignored the category in the URL: it does not exist. Ignored the repository in the URL: it is not registered.',
    );
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

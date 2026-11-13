import { describe, expect, it } from 'vitest';
import { matchMoves, type MoveCandidate } from '../src/moves';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from '../../../test-support/linear-time';

const skill = (key: string, matchHash: string): MoveCandidate => ({
  key,
  format: 'skill-md',
  matchHash,
});

describe('matchMoves (SPEC-126 FR-126-15, A11, §11.5 H2)', () => {
  it.each<{
    name: string;
    added: MoveCandidate[];
    unseen: MoveCandidate[];
    moves: { path: string; occurrenceId: string }[];
    ambiguous: number;
  }>([
    { name: 'empty inputs', added: [], unseen: [], moves: [], ambiguous: 0 },
    {
      name: 'no unseen occurrence',
      added: [skill('a', 'h1')],
      unseen: [],
      moves: [],
      ambiguous: 0,
    },
    {
      name: 'no new path',
      added: [],
      unseen: [skill('occ_1', 'h1')],
      moves: [],
      ambiguous: 0,
    },
    {
      name: 'one to one',
      added: [skill('.agents/skills/review', 'h1')],
      unseen: [skill('occ_1', 'h1')],
      moves: [{ path: '.agents/skills/review', occurrenceId: 'occ_1' }],
      ambiguous: 0,
    },
    {
      name: 'the root skill path is a valid key',
      added: [skill('', 'h1')],
      unseen: [skill('occ_1', 'h1')],
      moves: [{ path: '', occurrenceId: 'occ_1' }],
      ambiguous: 0,
    },
    {
      name: 'two added for one unseen (moved and copied)',
      added: [skill('y', 'h1'), skill('z', 'h1')],
      unseen: [skill('occ_x', 'h1')],
      moves: [],
      ambiguous: 2,
    },
    {
      name: 'two unseen for one added',
      added: [skill('z', 'h1')],
      unseen: [skill('occ_x', 'h1'), skill('occ_y', 'h1')],
      moves: [],
      ambiguous: 1,
    },
    {
      name: 'two identical moved at once (counts the new paths only)',
      added: [skill('x2', 'h1'), skill('y2', 'h1')],
      unseen: [skill('occ_x', 'h1'), skill('occ_y', 'h1')],
      moves: [],
      ambiguous: 2,
    },
    {
      name: 'different formats with the same hash never match',
      added: [{ key: 'b.mdc', format: 'cursor-rule', matchHash: 'h1' }],
      unseen: [{ key: 'occ_1', format: 'claude-rule', matchHash: 'h1' }],
      moves: [],
      ambiguous: 0,
    },
    {
      name: 'different hashes never match',
      added: [skill('a', 'h1')],
      unseen: [skill('occ_1', 'h2')],
      moves: [],
      ambiguous: 0,
    },
    {
      name: 'an ambiguous group does not stop another group from moving',
      added: [skill('x2', 'h1'), skill('y2', 'h1'), skill('r2', 'h2'), skill('new', 'h3')],
      unseen: [skill('occ_x', 'h1'), skill('occ_y', 'h1'), skill('occ_r', 'h2')],
      moves: [{ path: 'r2', occurrenceId: 'occ_r' }],
      ambiguous: 2,
    },
  ])('$name', ({ added, unseen, moves, ambiguous }) => {
    expect(matchMoves({ added, unseen })).toEqual({ moves, ambiguous });
  });

  it('returns the moves in the order of the new paths', () => {
    const result = matchMoves({
      added: [skill('b', 'h2'), skill('a', 'h1')],
      unseen: [skill('occ_1', 'h1'), skill('occ_2', 'h2')],
    });
    expect(result.moves).toEqual([
      { path: 'b', occurrenceId: 'occ_2' },
      { path: 'a', occurrenceId: 'occ_1' },
    ]);
  });

  it('matches 10,000 pairs in linear time', { timeout: LINEAR_TIME_TEST_TIMEOUT_MS }, async () => {
    const build = (size: number) => {
      const added: MoveCandidate[] = [];
      const unseen: MoveCandidate[] = [];
      for (let index = 0; index < size; index += 1) {
        added.push(skill(`new/${index}`, `hash-${index}`));
        unseen.push(skill(`occ_${index}`, `hash-${index}`));
      }
      return { added, unseen };
    };
    const large = build(10_016);
    expect(matchMoves(large).moves).toHaveLength(10_016);
    await expectLinearTime({
      build,
      run: (input) => matchMoves(input),
      // A linear baseline over the same candidates: one map insert and lookup per candidate.
      baseline: ({ added, unseen }) => {
        const seen = new Map<string, string>();
        for (const candidate of unseen) seen.set(candidate.matchHash, candidate.key);
        let found = 0;
        for (const candidate of added) found += Number(seen.has(candidate.matchHash));
        return found;
      },
      size: 10_016,
    });
  });
});

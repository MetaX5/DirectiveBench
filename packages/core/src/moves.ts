/**
 * One side of a possible move (SPEC-126 §8.2): a new path of a scan, or an active occurrence the
 * scan did not find. `matchHash` is the content hash for `skill-md` and the primary file's
 * `sha256` for every single-file format (FR-126-15).
 */
export interface MoveCandidate {
  key: string;
  format: string;
  matchHash: string;
}

export interface MoveMatches {
  /** One-to-one pairs, in the order of the `added` input. */
  moves: { path: string; occurrenceId: string }[];
  /**
   * New paths that matched at least one unseen occurrence but did not move, because their format
   * and match hash had several new paths or several unseen occurrences (§11.5 H2).
   */
  ambiguous: number;
}

/** The group key: equal format and equal match hash. */
function groupKey(candidate: MoveCandidate): string {
  return `${candidate.format}\u0000${candidate.matchHash}`;
}

function groupBy(candidates: readonly MoveCandidate[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = groupKey(candidate);
    const group = groups.get(key);
    if (group) group.push(candidate.key);
    else groups.set(key, [candidate.key]);
  }
  return groups;
}

/**
 * Pairs new paths (`added`, key = path) with unseen occurrences (`unseen`, key = occurrence id)
 * that have the same format and match hash (SPEC-126 FR-126-15, A11). Only a one-to-one match is
 * a move: a group with one new path and one unseen occurrence. Every new path of a group with
 * several new paths or several unseen occurrences counts in `ambiguous`; a new path matching no
 * unseen occurrence counts nowhere. Pure and linear in the inputs (maps keyed by the group).
 */
export function matchMoves(input: {
  added: readonly MoveCandidate[];
  unseen: readonly MoveCandidate[];
}): MoveMatches {
  const added = groupBy(input.added);
  const unseen = groupBy(input.unseen);
  const moves: MoveMatches['moves'] = [];
  let ambiguous = 0;
  for (const [key, paths] of added) {
    const occurrences = unseen.get(key);
    if (!occurrences) continue;
    const [path] = paths;
    const [occurrenceId] = occurrences;
    if (
      paths.length === 1 &&
      occurrences.length === 1 &&
      path !== undefined &&
      occurrenceId !== undefined
    ) {
      moves.push({ path, occurrenceId });
    } else {
      ambiguous += paths.length;
    }
  }
  return { moves, ambiguous };
}

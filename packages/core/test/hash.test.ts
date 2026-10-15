import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, createId, hashManifest, nowIso, sha256 } from '../src/hash';

describe('sha256', () => {
  it('hashes strings and bytes identically', () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sha256('abc')).toBe(expected);
    expect(sha256(new TextEncoder().encode('abc'))).toBe(expected);
  });
});

describe('hashManifest', () => {
  it('is independent of manifest order', () => {
    const a = { path: 'a', sha256: '1' };
    const b = { path: 'b', sha256: '2' };
    const c = { path: 'c', sha256: '3' };
    expect(hashManifest([a, b, c])).toBe(hashManifest([c, a, b]));
    expect(hashManifest([a])).not.toBe(hashManifest([b]));
  });

  it('does not mutate its input and keeps duplicate paths', () => {
    const entries = [
      { path: 'b', sha256: '2' },
      { path: 'a', sha256: '1' },
    ];
    hashManifest(entries);
    expect(entries.map((entry) => entry.path)).toEqual(['b', 'a']);

    const first = { path: 'a', sha256: '1' };
    const duplicate = { path: 'a', sha256: '2' };
    expect(hashManifest([first, duplicate])).not.toBe(hashManifest([first]));
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
    expect(canonicalJson({ a: 1, c: 3, b: 2 })).toBe(canonicalJson({ c: 3, b: 2, a: 1 }));
  });

  it('drops undefined properties and serialises primitives', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('createId', () => {
  it('creates prefixed, URL-safe, unique identifiers', () => {
    const id = createId('job');
    expect(id).toMatch(/^job_[A-Za-z0-9_-]{16}$/);
    expect(createId('job')).not.toBe(id);
  });
});

describe('nowIso', () => {
  it('returns the current time as an ISO 8601 string', () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T12:34:56.789Z') });
    try {
      expect(nowIso()).toBe('2026-10-15T12:34:56.789Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

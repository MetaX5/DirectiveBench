import { describe, expect, it } from 'vitest';
import { isMockAgent } from '../lib/mock-agent';

describe('isMockAgent', () => {
  it('recognises the mock agent adapter id', () => {
    expect(isMockAgent('mock')).toBe(true);
  });

  it.each(['claude-code', 'codex', 'Mock', 'mock ', ''])(
    'does not treat %j as the mock agent',
    (id) => {
      expect(isMockAgent(id)).toBe(false);
    },
  );

  it.each([null, undefined])('does not treat a missing agent (%s) as the mock agent', (id) => {
    expect(isMockAgent(id)).toBe(false);
  });
});

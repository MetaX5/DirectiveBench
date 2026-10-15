import { describe, expect, it } from 'vitest';
import {
  createExecutableAdapters,
  MockAgentAdapter,
  UnsupportedCapabilityError,
} from '../src/index';

describe('createExecutableAdapters', () => {
  it('exposes only the mock agent as executable in this build', () => {
    const adapters = createExecutableAdapters();
    expect([...adapters.keys()]).toEqual(['mock']);
    expect(adapters.get('mock')).toBeInstanceOf(MockAgentAdapter);
  });

  it('returns fresh adapter instances on each call', () => {
    expect(createExecutableAdapters().get('mock')).not.toBe(createExecutableAdapters().get('mock'));
  });
});

describe('UnsupportedCapabilityError', () => {
  it('is a named Error carrying its message', () => {
    const error = new UnsupportedCapabilityError('model selection is not supported');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnsupportedCapabilityError');
    expect(error.message).toBe('model selection is not supported');
  });
});

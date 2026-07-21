import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthBootstrapTimeoutError,
  isAuthBootstrapTimeoutError,
  withAuthBootstrapTimeout,
} from '../authBootstrap';

describe('withAuthBootstrapTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('returns an operation that finishes within the deadline', async () => {
    await expect(withAuthBootstrapTimeout(Promise.resolve('session'), 20)).resolves.toBe('session');
  });

  it('rejects a stuck operation with a recognizable timeout error', async () => {
    vi.useFakeTimers();
    const result = withAuthBootstrapTimeout(new Promise<never>(() => undefined), 20);
    const assertion = expect(result).rejects.toBeInstanceOf(AuthBootstrapTimeoutError);

    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('recognizes serialized timeout errors used by query recovery UI', () => {
    expect(isAuthBootstrapTimeoutError({ code: 'AUTH_BOOTSTRAP_TIMEOUT' })).toBe(true);
    expect(isAuthBootstrapTimeoutError(new Error('network failed'))).toBe(false);
  });
});

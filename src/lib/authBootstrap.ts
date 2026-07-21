export const AUTH_BOOTSTRAP_TIMEOUT_MS = 15_000;

export class AuthBootstrapTimeoutError extends Error {
  readonly code = 'AUTH_BOOTSTRAP_TIMEOUT';

  constructor(timeoutMs = AUTH_BOOTSTRAP_TIMEOUT_MS) {
    super(`Auth bootstrap timed out after ${timeoutMs}ms`);
    this.name = 'AuthBootstrapTimeoutError';
  }
}

export function isAuthBootstrapTimeoutError(error: unknown): error is AuthBootstrapTimeoutError {
  return error instanceof AuthBootstrapTimeoutError
    || (typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'AUTH_BOOTSTRAP_TIMEOUT');
}

export function withAuthBootstrapTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs = AUTH_BOOTSTRAP_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthBootstrapTimeoutError(timeoutMs)), timeoutMs);

    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

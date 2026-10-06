export const DEFERRED_TEST_PATTERNS: string[];
/** Repo-relative path, with either slash style. */
export function isDeferredTest(path: string): boolean;
export function isDeferredGate(scriptName: string): boolean;

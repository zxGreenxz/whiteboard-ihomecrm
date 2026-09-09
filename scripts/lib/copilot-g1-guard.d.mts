export type G1Request = { url: string; method: string; body?: unknown; headers?: Record<string, string> };
export const G1_READ_RPCS: Record<string, string[]>;
export function initializeG1Browser(input: { actorId: string; organizationId: string }): void;
export function safeG1RequestFailure(request: Pick<G1Request, 'url' | 'method'>, errorText?: string): string;
export type G1HeaderCompleteCountRead = { requestOrdinal: number; method: string; origin: string; pathname: string; status: number; code: string; contentRangeDigest: string };
export function createG1Guard(input: { actorId: string; organizationId: string; supabaseOrigin: string; baseUrl: string }): {
  allow(request: G1Request, requestKey?: unknown): boolean;
  finished(requestKey: unknown): void;
  observeHeadCount(requestKey: unknown, status: number, contentRange?: string): void;
  classifyHeadCountAbort(requestKey: unknown, code?: string): boolean;
  observeThread(request: G1Request, body: unknown, status: number): void;
  counters(): { chatWrites: number; pendingChatWrites: number; blockedWrites: number; blocked: string[]; ownedThreadIds: string[];
    headerCompleteCountReadAborts: number; headerCompleteCountReads: G1HeaderCompleteCountRead[] };
};

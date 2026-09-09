export type G1Request = { url: string; method: string; body?: unknown; headers?: Record<string, string> };
export const G1_READ_RPCS: Record<string, string[]>;
export function initializeG1Browser(input: { actorId: string; organizationId: string }): void;
export function createG1Guard(input: { actorId: string; organizationId: string; supabaseOrigin: string; baseUrl: string }): {
  allow(request: G1Request): boolean;
  observeThread(request: G1Request, body: unknown, status: number): void;
  counters(): { chatWrites: number; blockedWrites: number; blocked: string[]; ownedThreadIds: string[] };
};

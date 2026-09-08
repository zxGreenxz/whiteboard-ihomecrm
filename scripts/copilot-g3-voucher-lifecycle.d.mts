export type G3Row = Record<string, unknown>;
export interface G3Attempt { actorId: string; organizationId: string; caseNo: 3 | 8; sourceSha: string; buildSha: string; runId: string; runAttempt: string; workflow: string; attemptId: string; startedAt: string; marker: string; requestKey: string; actions: string[]; }
export interface G3RpcResult { status: number; body: unknown; }
export interface G3Store { acquire(): void; acquireRecovery(): void; assertOwner(): void; load(): G3Row | null; save(journal: G3Row): void; release(): void; completeReleased(journal: G3Row): void; }
export interface G3HistoryInput { attempt: G3Attempt; voucherId: string; voucherDigest: string; }
export interface G3Client { rpc(name: string, args: unknown): Promise<G3RpcResult>; readPlan(id: string): Promise<unknown>; readVoucher(id: string): Promise<unknown>; readMode(): Promise<unknown>; readPending(id: string): Promise<G3Row[]>; readRequest(id: string): Promise<G3Row>; readAudit(id: string): Promise<unknown>; discoverPlans(attempt: G3Attempt): Promise<unknown[]>; verifyHistory(input: G3HistoryInput): Promise<unknown>; }
export interface G3Lifecycle { journal(): G3Row; create(): Promise<G3RpcResult>; approve(input: { nonce: string; digest: string; version: number; stepUpToken?: string | null }): Promise<G3RpcResult>; execute(step: number, version: number): Promise<G3RpcResult>; executePair(step: number, version: number): Promise<G3RpcResult[]>; cleanup(): Promise<G3Row>; run<T>(business: () => Promise<T>): Promise<T>; }
export const G3_DEMO: string;
export function createG3Attempt(input: { actorId: string; caseNo: 3 | 8; sourceSha: string; buildSha: string; runId: string; runAttempt: string; workflow: string; attemptId?: string; startedAt?: string }): G3Attempt;
export function createG3FileStore(input: { directory: string }): G3Store;
export function createG3AppClient(input: { apiOrigin: string; actorId: string; credentialProvider: () => Promise<{ actorId: string; accessToken: string; apikey: string }>; fetch: typeof globalThis.fetch; readPending?: (id: string) => Promise<G3Row[]>; readRequest?: (id: string) => Promise<G3Row>; verifyHistory?: (input: G3HistoryInput) => Promise<unknown> }): G3Client;
export function openG3Lifecycle(input: { attempt: G3Attempt; store: G3Store; client: G3Client; recovery?: boolean; now?: () => number }): G3Lifecycle;
export function validateG3Journal(value: unknown): G3Row;
export function validateG3Receipt(value: unknown): G3Row;

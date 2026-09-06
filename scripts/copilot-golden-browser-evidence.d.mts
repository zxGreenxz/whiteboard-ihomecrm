/** Typed boundary for the native Node evidence module. Untrusted inputs are
 * validated by the implementation before a run/checkpoint is accepted. */
export const DEMO_ORG: 'dddd0000-0000-4000-8000-000000000001';
export const IMPLEMENTED_ORACLES: Set<string>;
export type ProviderFailureReason = 'quota_exhausted' | 'rate_exhausted' | 'provider_failed';
export type CaseReason = ProviderFailureReason | 'oracle_not_implemented' | 'fixture_unbound' | 'preflight_missing' | 'attestation_failed' | 'browser_failed' | 'oracle_failed' | 'cleanup_required';
export type CaseStatus = 'pending' | 'running' | 'pass' | 'fail' | 'blocked';
export interface GoldenScenario {
  id: string; fixture: string; oracle: string; kind: string;
  acceptance: string[]; prompt: string;
}
export interface GoldenManifest { schemaVersion: 1; scope: 'full-corpus'; cases: GoldenScenario[] }
export interface Attestation {
  buildSha: string; edgeSourceDigest: string; deployedEdgeSourceDigest: string;
  providerModel: string; organizationId: typeof DEMO_ORG; corpusDigest: string;
  manifestDigest: string; fixtureDigest: string; policyDigest: string;
  actorDigest: string; observedAt: string; contextId: string;
}
export interface Timing {
  startedAt: string; completedAt: string; totalMs: number; humanWaitMs: number; processingMs: number;
}
export interface Observation {
  answerDigest: string; promptDigest: string; promptTemplateDigest: string; bindingDigest: string;
  rpcDigest: string; modelRounds: number; toolResultLinked: true; finalAnswerMounted: true;
  readRpc: 'copilot_available_rooms_v1'; businessWrites: number; networkErrors: number; oracleVersion: string;
}
export interface BrowserCase {
  id: string; oracle: string; status: CaseStatus; reason?: CaseReason; timing?: Timing; observed?: Observation;
}
export interface BrowserRun {
  schemaVersion: 2; lane: 'real-model'; executor: 'attested-chat-panel-v1'; attestation: Attestation;
  runId: string; createdAt: string; updatedAt: string; cases: BrowserCase[];
  cleanup: { caseId: string; fixtureKey: string; state: 'pending' | 'done'; cleanup: string }[];
}
export interface Quantiles { min: number | null; p50: number | null; p95: number | null; max: number | null }
export function digest(value: unknown): string;
export function providerFailureReason(error: unknown): ProviderFailureReason;
export function bindRoomScenario(scenario: GoldenScenario, payload: unknown): {
  prompt: string; payload: unknown; bindingDigest: string; buildingScope?: { id: string; name: string };
};
export function validateManifest(golden: unknown, manifest: unknown): string[];
export function createRun(golden: unknown, manifest: unknown, attestation: unknown): BrowserRun;
export function validateBrowserRun(golden: unknown, manifest: unknown, run: unknown): string[];
export function transitionCase(run: BrowserRun, id: string, update: Pick<BrowserCase, 'status'> & Partial<Pick<BrowserCase, 'reason' | 'timing' | 'observed'>>): void;
export function resumeRun(run: BrowserRun, attestation: Attestation): BrowserRun;
export function writeCheckpoint(path: string, run: BrowserRun, golden: unknown, manifest: unknown): void;
export function summarizeRun(run: BrowserRun): {
  total: number; counts: Record<CaseStatus, number>; latencyMs: Quantiles; unsuccessfulLatencyMs: Quantiles;
  sla: { status: 'pending-owner-approval'; p50: null; p95: null; max: null }; verdict: 'blocked';
};

/** Typed boundary for the native Node evidence module. Untrusted inputs are
 * validated by the implementation before a run/checkpoint is accepted. */
export const DEMO_ORG: 'dddd0000-0000-4000-8000-000000000001';
export const IMPLEMENTED_ORACLES: Set<string>;
export type ProviderFailureReason = 'quota_exhausted' | 'rate_exhausted' | 'provider_failed';
export type CaseReason = ProviderFailureReason | 'oracle_not_implemented' | 'fixture_unbound' | 'preflight_missing' | 'attestation_failed' | 'browser_failed' | 'oracle_failed' | 'cleanup_required';
export type CaseStatus = 'pending' | 'running' | 'pass' | 'fail' | 'blocked' | 'not_selected';
export interface GoldenScenario {
  id: string; fixture: string; oracle: string; kind: string;
  acceptance: string[]; prompt: string;
}
export interface GoldenManifest { schemaVersion: 1; scope: 'full-corpus'; cases: GoldenScenario[] }
export interface ContractFixtureAttestation {
  kind: 'contract-search' | 'contract-absent' | 'contract-detail'; organizationId: typeof DEMO_ORG;
  queryDigest: string; identityDigest: string; searchDigest: string; detailDigest?: string; customerDigest?: string;
}
export interface C02Ownership {
  kind:'owned-c02-v1';state:'ready';organizationId:typeof DEMO_ORG;implementationSha:string;
  customerId:string;associationId:string;hostId:string;roomId:string;buildingId:string;
  actorDigest:string;contextDigest:string;phoneDigest:string;markerDigest:string;hostDigest:string;associationsDigest:string;
  customerDigest:string;associationDigest:string;responseDigest:string;reviewDigest:string;
}
export function validC02Ownership(value:unknown,binding:{actorDigest:string;contextDigest:string;responseDigest:string}):value is C02Ownership;
export interface CustomerFixtureAttestation {
  kind:'customer-search'|'customer-absent';organizationId:typeof DEMO_ORG;actorDigest:string;contextDigest:string;queryDigest:string;identityDigest:string;responseDigest:string;
  ownership?:C02Ownership;
}
export interface Attestation {
  financialReadFixtures?:Partial<Record<import('./copilot-financial-read-fixtures.mjs').FinancialReadCaseId,import('./copilot-financial-read-fixtures.mjs').FinancialReadAttestation>>;
  customerFixtures?:Partial<Record<'C02'|'C14',CustomerFixtureAttestation>>;
  contractFixtures?: Partial<Record<'C31' | 'C32' | 'C33', ContractFixtureAttestation>>;
  incomeApprovalFixtures?: Partial<Record<'C34' | 'C35' | 'C36', IncomeApprovalFixtureAttestation>>;
  buildSha: string; edgeSourceDigest: string; deployedEdgeSourceDigest: string;
  providerModel: string; organizationId: typeof DEMO_ORG; corpusDigest: string;
  manifestDigest: string; fixtureDigest: string; policyDigest: string;
  actorDigest: string; observedAt: string; contextId: string;
}
export interface IncomeApprovalFixtureAttestation {
  kind:'voucher-search'|'voucher-empty'|'pending-inbox'; organizationId:typeof DEMO_ORG;
  dailyCashbookQueryDigest?:string; dailyCashbookResponseDigest?:string;
  actorDigest:string; queryDigest:string; identityDigest:string; responseDigest:string;
}
export interface Timing {
  startedAt: string; completedAt: string; totalMs: number; humanWaitMs: number; processingMs: number;
}
export interface Observation {
  financialReads?:import('../.e2e-fleet/specs/copilotFinancialReadOracle').FinancialReadObservation[];
  answerDigest: string; promptDigest: string; promptTemplateDigest: string; bindingDigest: string;
  rpcDigest: string; modelRounds: number; toolResultLinked: true; finalAnswerMounted: true;
  fixtureDigest?: string; queryDigest?: string; identityDigest?: string; searchDigest?: string; detailDigest?: string; responseDigest?:string; customerDigest?: string;
  dailyCashbookCalls?:0|1; dailyCashbookDigest?:string;
  contextDigest?:string;
  contractCalls?: number; customerCalls?: number;
  readRpc: 'financial-read-roles-v1' | 'copilot_customer_search_v1' | 'copilot_available_rooms_v1' | 'copilot_contract_search_v1' | 'copilot_contract_detail_v1' | 'copilot_income_expense_search_v1' | 'copilot_pending_requests_v1'; businessWrites: number; networkErrors: number; oracleVersion: string;
}
export interface BrowserCase {
  id: string; oracle: string; status: CaseStatus; reason?: CaseReason; timing?: Timing; observed?: Observation;
}
export interface BrowserRun {
  selection?: { mode: 'selected'; caseIds: string[] };
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
export function selectCaseIds(manifest: GoldenManifest, ids?: unknown): string[];
export function validateManifest(golden: unknown, manifest: unknown): string[];
export function createRun(golden: unknown, manifest: unknown, attestation: unknown, caseIds?: string[]): BrowserRun;
export function validateBrowserRun(golden: unknown, manifest: unknown, run: unknown): string[];
export function transitionCase(run: BrowserRun, id: string, update: Pick<BrowserCase, 'status'> & Partial<Pick<BrowserCase, 'reason' | 'timing' | 'observed'>>): void;
export function resumeRun(run: BrowserRun, attestation: Attestation): BrowserRun;
export function writeCheckpoint(path: string, run: BrowserRun, golden: unknown, manifest: unknown): void;
export function summarizeRun(run: BrowserRun): {
  fullPlanAccepted: false; selectedScope: { mode: string; caseIds: string[] }; selectedCounts: Record<string, number>; selectedVerdict: 'pass' | 'blocked';
  total: number; counts: Record<CaseStatus, number>; latencyMs: Quantiles; unsuccessfulLatencyMs: Quantiles;
  sla: { status: 'pending-owner-approval'; p50: null; p95: null; max: null }; verdict: 'blocked';
};
